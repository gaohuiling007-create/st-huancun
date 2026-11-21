// 缓存优化 Cache Optimizer v3 —— 前缀冻结
//
// Gemini / Vertex 的隐式缓存只认「从头开始一字不差的前缀」：
//   · 开头所有 system 消息会被合并成一个 systemInstruction（parts 拼接），
//     其中任何一处变化，它后面的 token 全部作废；
//   · 之后按消息顺序做前缀匹配，遇到第一处不同就停。
//
// 所以「让某几块内容保持不动」这种思路永远治不好：只要系统提示里有一块每轮在变，
// 它后面的一切都白给。v3 换成一种能保证收敛的做法：
//
//   1. 第一轮记下开头 system 区（骨架）的每一块；
//   2. 之后每轮逐块比对：内容变了 / 消失了的块，就地换成固定的占位符，
//      真实内容挪到提示词最末尾（离生成位置最近，注意力最高）；
//   3. 骨架里没有的新块，一律只放末尾，绝不往系统提示里塞。
//
// 于是系统提示从第二轮起就是逐字节冻结的，缓存前缀永远成立；
// 变化的只有末尾那一小段。附带的好处是完全不改世界书、不改预设、不改角色卡。
//
// 另外提供两件诊断工具：
//   · 真实请求对比：拿实际发出的两次请求比，报告相同前缀比例和第一处不同的位置；
//   · 用量观测：读服务端返回的 cachedContentTokenCount / cached_tokens，
//     算出真实命中率 —— 这样才能区分「没锁住」和「服务端压根没缓存」。

const VERSION = '3.4.0';
const MODULE = 'cacheOptimizer';
const LS_KEY = 'cacheopt_v3_skeleton';
const MAX_SKELETONS = 4;
const MAX_STORE_CHARS = 1_500_000;
const MAX_RECENT = 6;
const GENERATE_PATH = '/api/backends/chat-completions/generate';

const TAIL_OPEN = '<动态设定（本轮最新）>';
const TAIL_CLOSE = '</动态设定（本轮最新）>';
const STUB_HEAD = '〔动态设定已移至对话末尾〕';

const DEFAULTS = Object.freeze({
    enabled: true,
    freezeHead: true,
    moveTail: true,
    verbose: true,
});

// 一眼就知道每轮会变的内容：EJS 变量、随机/时间宏、MVU 变量块
const DYNAMIC_RE = /<%[\s\S]*?%>|\{\{\s*(random|roll|pick|time|date|weekday|isotime|isodate|datetimeformat|idle_duration|lastMessage|lastUserMessage|lastCharMessage|lastMessageId)/i;
// 更严格的一档：建骨架时就能确定「它一定每轮变」，直接按占位符起手，省掉一轮试错
const STRICT_DYNAMIC_RE = /<status_current_variables>|\{\{\s*(random|roll|pick|time|date|weekday|isotime|isodate|datetimeformat|idle_duration|lastMessage|lastUserMessage|lastCharMessage|lastMessageId)|stat_data|getMessageVar/i;

const state = {
    skeletons: new Map(), // chatId -> { slots: [{key,text,stub,misses}], at, allStub }
    requests: new Map(),  // chatId -> { at, msgs: string[] }
    usage: null,          // { cached, prompt, at }
    report: '',           // 上一次真实请求对比的文字
    lastRun: '还没发送过请求',
};

// ───────────────────────── 基础 ─────────────────────────

function ctx() {
    return SillyTavern.getContext();
}

function settings() {
    const all = ctx().extensionSettings;
    all[MODULE] ??= structuredClone(DEFAULTS);
    for (const [key, value] of Object.entries(DEFAULTS)) {
        all[MODULE][key] ??= structuredClone(value);
    }
    return all[MODULE];
}

function save() {
    ctx().saveSettingsDebounced();
}

function text(message) {
    return typeof message?.content === 'string' ? message.content : '';
}

/** 粗略识别平台：iOS / iPadOS（iPadOS 13+ 伪装成 Mac，靠触点数量区分）/ Android */
function platformLabel() {
    try {
        const ua = navigator.userAgent || '';
        if (/iPhone|iPad|iPod/i.test(ua)) return 'iOS/iPadOS';
        if (/Macintosh/i.test(ua) && (navigator.maxTouchPoints || 0) > 1) return 'iOS/iPadOS';
        if (/Android/i.test(ua)) return 'Android';
    } catch { /* 忽略 */ }
    return '';
}

/** 当前跑在什么壳里：TauriTavern 原生客户端 or 浏览器 */
function hostLabel() {
    const p = platformLabel();
    try {
        const h = window.__TAURITAVERN_HOST__;
        if (h && h.platform) return `TauriTavern（${h.platform}/${h.kind ?? 'desktop'}）`;
        if (window.__TAURI_RUNNING__) return `TauriTavern${p ? `（${p}）` : ''}`;
    } catch { /* 忽略 */ }
    if (p) return `${p} 浏览器`;
    return '浏览器';
}

function currentChatId() {
    const c = ctx();
    try {
        return c.getCurrentChatId?.() ?? c.chatId ?? 'default';
    } catch {
        return 'default';
    }
}

function keyOf(content) {
    return String(content ?? '').replace(/\s+/g, ' ').trim().slice(0, 48);
}

function stubText(key) {
    const label = String(key ?? '').replace(/[<>{}\[\]]/g, '').slice(0, 16).trim();
    return label ? `${STUB_HEAD}（原「${label}…」）` : STUB_HEAD;
}

/** 开头连续 system 消息的数量：Gemini 会把这些合并成 systemInstruction */
function leadingSystemCount(chat) {
    let i = 0;
    while (i < chat.length && chat[i]?.role === 'system' && typeof chat[i].content === 'string') i++;
    return i;
}

// ───────────────────────── 骨架存取 ─────────────────────────

function loadSkeletons() {
    try {
        const raw = localStorage.getItem(LS_KEY);
        if (!raw) return;
        const obj = JSON.parse(raw);
        for (const [chatId, sk] of Object.entries(obj ?? {})) {
            if (sk && Array.isArray(sk.slots)) state.skeletons.set(chatId, sk);
        }
    } catch (e) {
        console.warn('[缓存优化] 读取骨架失败', e);
    }
}

function persist() {
    try {
        const entries = [...state.skeletons.entries()]
            .sort((a, b) => (b[1]?.at ?? 0) - (a[1]?.at ?? 0))
            .slice(0, MAX_SKELETONS);
        const raw = JSON.stringify(Object.fromEntries(entries));
        if (raw.length > MAX_STORE_CHARS) {
            localStorage.removeItem(LS_KEY);
            return;
        }
        localStorage.setItem(LS_KEY, raw);
    } catch (e) {
        console.warn('[缓存优化] 保存骨架失败', e);
    }
}

function makeSkeleton(blocks) {
    return {
        slots: blocks.map(m => {
            const body = text(m);
            const key = keyOf(body);
            if (STRICT_DYNAMIC_RE.test(body)) {
                return { key, text: stubText(key), stub: true, misses: 0 };
            }
            return { key, text: body, stub: false, misses: 0 };
        }),
        at: Date.now(),
    };
}

// ───────────────────────── 核心：前缀冻结 ─────────────────────────

/**
 * 用骨架匹配本轮的开头 system 块，产出「新的开头」和「要挪到末尾的内容」。
 * @param {any[]} blocks 本轮开头 system 块
 * @param {any} sk 骨架
 * @param {any} r 统计累加器
 */
function matchSkeleton(blocks, sk, r) {
    const used = new Set();
    const outHead = [];
    const moved = [];

    for (const slot of sk.slots) {
        const idx = slot.key
            ? blocks.findIndex((b, i) => !used.has(i) && keyOf(text(b)) === slot.key)
            : -1;
        const body = idx >= 0 ? text(blocks[idx]) : null;
        if (idx >= 0) { used.add(idx); r.matched++; }

        // 已经冻结的槽位：永远吐占位符，真实内容进末尾
        if (slot.stub) {
            outHead.push({ role: 'system', content: slot.text });
            r.stubbed++;
            if (body && body.trim()) {
                moved.push(body);
                r.movedBlocks++;
                r.movedChars += body.length;
            }
            continue;
        }

        // 和上一轮一字不差：原样保留
        if (body !== null && body === slot.text) {
            outHead.push(blocks[idx]);
            r.kept++;
            r.keptChars += body.length;
            continue;
        }

        // 内容变了，或者这一轮没出现
        slot.misses = (slot.misses || 0) + 1;
        const obvious = body !== null && (DYNAMIC_RE.test(body) || body.length < 500);
        if (body !== null && !obvious && slot.misses < 3) {
            // 大块 + 不常变（改预设、改角色卡）：就地更新，认一次不命中
            slot.text = body;
            outHead.push(blocks[idx]);
            r.kept++;
            r.keptChars += body.length;
            continue;
        }

        // 判定为易变块：换成占位符，真实内容挪到末尾
        slot.stub = true;
        slot.text = stubText(slot.key || keyOf(body ?? ''));
        outHead.push({ role: 'system', content: slot.text });
        r.stubbed++;
        if (body && body.trim()) {
            moved.push(body);
            r.movedBlocks++;
            r.movedChars += body.length;
        }
    }

    // 骨架里没有的新块：一律只放末尾，绝不塞进系统提示
    for (let i = 0; i < blocks.length; i++) {
        if (used.has(i)) continue;
        const body = text(blocks[i]);
        if (!body.trim()) continue;
        moved.push(body);
        r.movedBlocks++;
        r.movedChars += body.length;
    }

    return { outHead, moved };
}

/**
 * 把开头 system 区改写成「冻结骨架 + 末尾追加真实动态内容」。
 * @param {any[]} chat 提示词消息数组（原地修改）
 * @param {boolean} dryRun 试运行：只算不改状态
 */
function stabilize(chat, dryRun) {
    const s = settings();
    const chatId = currentChatId();
    const headLen = leadingSystemCount(chat);
    const r = {
        chatId, headLen, kept: 0, stubbed: 0, keptChars: 0, matched: 0,
        movedBlocks: 0, movedChars: 0, created: false, reset: false, skipped: '',
    };

    if (!s.enabled || !s.freezeHead) { r.skipped = 'off'; return r; }
    if (headLen < 2) { r.skipped = headLen === 1 ? 'single' : 'empty'; return r; }

    const blocks = chat.slice(0, headLen).filter(m => text(m).trim());
    if (blocks.length < 2) { r.skipped = 'single'; return r; }

    let sk = state.skeletons.get(chatId);
    if (!sk) {
        if (dryRun) { r.skipped = 'noskel'; return r; }
        sk = makeSkeleton(blocks);
        state.skeletons.set(chatId, sk);
        persist();
        r.created = true;
    }
    if (dryRun) sk = JSON.parse(JSON.stringify(sk));

    let res = matchSkeleton(blocks, sk, r);

    // 一块都对不上 = 换了预设 / 换了卡：就地重建骨架，再用新骨架重跑一遍，
    // 这样只付「这一轮」，下一轮立刻恢复命中
    if (r.matched === 0 && r.stubbed >= 2 && !dryRun) {
        sk = makeSkeleton(blocks);
        state.skeletons.set(chatId, sk);
        persist();
        Object.assign(r, { kept: 0, stubbed: 0, keptChars: 0, matched: 0, movedBlocks: 0, movedChars: 0 });
        res = matchSkeleton(blocks, sk, r);
        r.reset = true;
        state.lastRun = '检测到换了预设/角色卡，已重建骨架';
    }
    const { outHead, moved } = res;

    if (!dryRun) {
        sk.at = Date.now();
        persist();
    }

    chat.splice(0, headLen, ...outHead);

    if (s.moveTail && moved.length) {
        const body = `${TAIL_OPEN}\n${moved.join('\n\n')}\n${TAIL_CLOSE}`;
        chat.push({ role: 'system', content: body });
        r.tailChars = body.length;
    }

    const tag = r.reset ? '（已重建骨架）' : '';
    state.lastRun = r.stubbed
        ? `${new Date().toLocaleTimeString()}${tag} 冻结 ${r.stubbed} 块 / 保留 ${r.kept} 块，动态内容 ${r.movedChars.toLocaleString()} 字移到末尾`
        : `${new Date().toLocaleTimeString()}${tag} 系统提示全静态，保留 ${r.kept} 块`;
    return r;
}

// ───────────────────────── 真实请求观测 ─────────────────────────

function snippet(line, offset) {
    const from = Math.max(0, offset - 30);
    return `…${String(line).slice(from, offset + 60).replace(/\s+/g, ' ')}…`;
}

function describeDiff(prev, cur) {
    const A = prev.msgs;
    const B = cur.msgs;
    const total = B.reduce((n, t) => n + t.length + 1, 0) || 1;
    let k = 0;
    while (k < A.length && k < B.length && A[k] === B[k]) k++;
    const chars = A.slice(0, k).reduce((n, t) => n + t.length + 1, 0);
    let off = 0;
    if (k < A.length && k < B.length) {
        while (off < A[k].length && A[k][off] === B[k][off]) off++;
    }

    const headA = A.findIndex(t => !t.startsWith('[system]'));
    const headB = B.findIndex(t => !t.startsWith('[system]'));
    const ha = headA < 0 ? A.length : headA;
    const hb = headB < 0 ? B.length : headB;
    const headSame = ha === hb && A.slice(0, ha).every((t, i) => t === B[i]);

    const gap = Math.round((cur.at - prev.at) / 1000);
    const lines = [
        `${new Date(cur.at).toLocaleTimeString()}｜与 ${gap} 秒前那次真实请求对比（${A.length} 条 → ${B.length} 条消息）`,
        `系统提示（前 ${hb} 条）：${headSame ? '✅ 逐字一致' : '❌ 有变化 —— 这一轮基本 0 命中'}`,
        `相同前缀：${(chars / total * 100).toFixed(1)}%（${chars.toLocaleString()} / ${total.toLocaleString()} 字）`,
    ];
    if (k < B.length) {
        const role = B[k].match(/^\[(\w+)\]/)?.[1] ?? '?';
        lines.push(`第一处不同：第 ${k + 1} 条（${role}）第 ${off} 字`);
        lines.push(`　上次：${snippet(A[k] ?? '（无）', off)}`);
        lines.push(`　这次：${snippet(B[k], off)}`);
        const fromEnd = B.length - 1 - k;
        if (k === B.length - 1) lines.push('　（只差在最后一条：这正是理想状态）');
        else if (fromEnd <= 6) lines.push(`　（距末尾 ${fromEnd} 条，属于正常的深度注入，损失有限）`);
        else lines.push(`　（距末尾还有 ${fromEnd} 条 —— 有东西插进了聊天记录中前段，这一段之后的缓存都会丢）`);
    } else {
        lines.push('两次完全相同');
    }
    if (!headSame) lines.push('提示：系统提示没锁住，多半是有扩展在生成时往开头插了东西，或开了「合并系统消息 / 提示词后处理」。');
    if (gap > 300) lines.push(`⚠ 间隔 ${gap} 秒，Gemini 隐式缓存可能已经过期（实测 10 分钟以上基本没了）`);
    return lines.join('\n');
}

/**
 * 记下这一轮真正发出去的消息序列。
 * 有两条路会调它：拦到请求体（浏览器 / TT 都可用），以及 PROMPT_READY 事件（宿主把请求藏起来时的兜底）。
 * 同一轮被记两次时（两条路都通），内容相同就跳过，避免"自己跟自己对比"。
 */
function noteSent(msgs) {
    const chatId = currentChatId();
    const now = Date.now();
    const prev = state.requests.get(chatId);
    if (prev && prev.msgs.length === msgs.length && prev.msgs.every((m, i) => m === msgs[i])) return;
    if (prev) state.report = describeDiff(prev, { at: now, msgs });
    state.requests.set(chatId, { at: now, msgs });
    if (state.requests.size > MAX_RECENT) {
        const oldest = [...state.requests.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        state.requests.delete(oldest[0]);
    }
    render();
}

function recordRequest(raw) {
    let body;
    try { body = JSON.parse(raw); } catch { return; }
    if (!Array.isArray(body?.messages) || body.type === 'quiet') return;
    noteSent(body.messages.map(m => `[${m.role}]${text(m)}`));
}

function maxNum(txt, re) {
    let best = null;
    for (const m of txt.matchAll(re)) {
        const n = Number(m[1]);
        if (Number.isFinite(n) && (best === null || n > best)) best = n;
    }
    return best;
}

async function observeResponse(res) {
    try {
        if (!res || typeof res.clone !== 'function') return;
        const raw = await res.clone().text();
        if (!raw) return;
        // Google 原生：usageMetadata.cachedContentTokenCount / promptTokenCount
        const cached = maxNum(raw, /"cachedContentTokenCount"\s*:\s*(\d+)/g)
            ?? maxNum(raw, /"cached_tokens"\s*:\s*(\d+)/g)
            ?? maxNum(raw, /"cache_read_input_tokens"\s*:\s*(\d+)/g);
        const prompt = maxNum(raw, /"promptTokenCount"\s*:\s*(\d+)/g)
            ?? maxNum(raw, /"prompt_tokens"\s*:\s*(\d+)/g)
            ?? maxNum(raw, /"input_tokens"\s*:\s*(\d+)/g);
        const output = maxNum(raw, /"candidatesTokenCount"\s*:\s*(\d+)/g)
            ?? maxNum(raw, /"completion_tokens"\s*:\s*(\d+)/g);
        if (prompt === null && cached === null) return;
        state.usage = { cached: cached ?? 0, prompt: prompt ?? 0, output: output ?? 0, at: Date.now() };
        render();
    } catch (e) {
        console.debug('[缓存优化] 读取用量失败', e);
    }
}

function watchNetwork() {
    if (window.fetch?.__cacheoptV3) return;
    const original = window.fetch;
    const wrapped = function (input, init) {
        const url = typeof input === 'string' ? input : input?.url ?? '';
        const hit = url.includes(GENERATE_PATH) && typeof init?.body === 'string';
        if (hit) {
            try { recordRequest(init.body); } catch { /* 旁观而已 */ }
        }
        const promise = original.apply(this, arguments);
        if (hit) {
            promise.then(res => { observeResponse(res).catch(() => {}); }).catch(() => {});
        }
        return promise;
    };
    wrapped.__cacheoptV3 = true;
    window.fetch = wrapped;
}

// ───────────────────────── 诊断 ─────────────────────────

function diagnostics() {
    const c = ctx();
    const cc = c.chatCompletionSettings ?? {};
    const src = String(cc.chat_completion_source ?? '');
    const model = String(cc.google_model ?? cc.vertexai_model ?? cc.openai_model ?? cc.claude_model ?? '');
    const lines = [];
    const ok = t => lines.push(`✅ ${t}`);
    const warn = t => lines.push(`⚠️ ${t}`);
    const bad = t => lines.push(`❌ ${t}`);

    if (src === 'makersuite' || src === 'vertexai') ok(`连接方式：${src === 'makersuite' ? 'Google AI Studio' : 'Vertex AI'} 直连`);
    else bad(`连接方式：${src || '未知'} —— 不是 Google 直连。中转站/OpenAI 兼容代理基本拿不到隐式缓存，先把这里换成 Google AI Studio 或 Vertex AI`);

    if (/gemini-(2\.[5-9]|[3-9])/.test(model)) ok(`模型：${model}`);
    else warn(`模型：${model || '未知'} —— 隐式缓存需要 gemini-2.5 及以上`);

    if (cc.use_sysprompt === false) warn('「使用系统提示」是关的：开头内容会被当成 user 消息，前缀照样算，但建议打开');
    else ok('「使用系统提示」已开');

    if (cc.squash_system_messages) bad('开了「合并系统消息」：所有 system 会被压成一条，插件无法逐块冻结，请关掉');
    if (cc.custom_prompt_post_processing) bad(`开了提示词后处理（${cc.custom_prompt_post_processing}）：会合并消息，请关掉`);

    const u = state.usage;
    if (u) {
        const pct = u.prompt ? (u.cached / u.prompt * 100) : 0;
        lines.push(`📊 最近一次：输入 ${u.prompt.toLocaleString()} tokens，命中缓存 ${u.cached.toLocaleString()}（${pct.toFixed(1)}%）`);
        if (u.prompt && u.prompt < 1024) warn(`输入只有 ${u.prompt} tokens，低于隐式缓存的最小长度（Flash 约 1024、Pro 约 2048）`);
        if (u.cached === 0 && u.prompt > 2048) {
            lines.push('　→ 前缀没问题但服务端不给缓存：常见原因是走了中转、模型不支持，或两轮间隔太久');
        }
    } else {
        lines.push('📊 还没观测到用量（发送一次后自动出现）');
    }
    return lines.join('\n');
}

// ───────────────────────── 界面 ─────────────────────────

function setEnabled(value) {
    settings().enabled = value;
    save();
    $('#cacheopt_enabled').prop('checked', value);
    $('#cacheopt_menu_label').text(`缓存优化：${value ? '开' : '关'}`);
    $('#cacheopt_menu .extensionsMenuExtensionButton').css('opacity', value ? '' : '0.4');
}

function render() {
    const u = state.usage;
    const sent = [...state.requests.values()].reduce((n, r) => n + 1, 0);
    const usage = u
        ? `本轮输入 ${u.prompt.toLocaleString()} tokens，命中缓存 ${u.cached.toLocaleString()}（${(u.prompt ? u.cached / u.prompt * 100 : 0).toFixed(1)}%）`
        : (sent
            ? '读不到 usage（宿主没透出 token 用量）。冻结逻辑不受影响，命中率请看服务商账单/控制台'
            : '还没有观测到用量');
    const ios = platformLabel() === 'iOS/iPadOS';
    $('#cacheopt_env').text(`运行环境：${hostLabel()}${ios ? '　（iOS 锁屏/切后台会让服务端缓存过期，连续对话更划算）' : ''}`);
    $('#cacheopt_usage').text(usage);
    $('#cacheopt_real').text(state.report || '同一聊天连续发送两次后自动显示。');
    $('#cacheopt_last').text(state.lastRun);
    const sk = state.skeletons.get(currentChatId());
    $('#cacheopt_skeleton').text(sk
        ? `当前聊天的骨架：${sk.slots.length} 块，其中 ${sk.slots.filter(s => s.stub).length} 块已冻结`
        : '当前聊天还没有骨架（下一次生成时建立）');
}

function bindCheckbox(id, key) {
    $(id).prop('checked', !!settings()[key]).on('input', function () {
        settings()[key] = !!$(this).prop('checked');
        save();
    });
}

function renderSettings() {
    const html = `
    <div class="cacheopt-settings">
      <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
          <b>⚡ 缓存优化 v${VERSION}</b>
          <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">
          <label class="checkbox_label"><input id="cacheopt_enabled" type="checkbox"> 启用缓存优化</label>
          <label class="checkbox_label"><input id="cacheopt_freeze" type="checkbox"> 冻结系统提示前缀（核心，关掉就回到 0 命中）</label>
          <label class="checkbox_label"><input id="cacheopt_tail" type="checkbox"> 把每轮变化的内容挪到对话末尾</label>
          <div class="cacheopt-row">
            <div id="cacheopt_check" class="menu_button">检查当前提示词（免费）</div>
            <div id="cacheopt_reset" class="menu_button">重建骨架</div>
          </div>
          <div id="cacheopt_env" class="cacheopt-hint"></div>
          <div id="cacheopt_skeleton" class="cacheopt-hint"></div>
          <div id="cacheopt_usage" class="cacheopt-hint"></div>
          <div id="cacheopt_last" class="cacheopt-hint"></div>
          <div id="cacheopt_real" class="cacheopt-report">同一聊天连续发送两次后自动显示。</div>
          <div class="cacheopt-hint">诊断：</div>
          <div id="cacheopt_diag" class="cacheopt-report">点上面的「检查」按钮查看。</div>
        </div>
      </div>
    </div>`;
    $('#extensions_settings2').append(html);

    $('#cacheopt_enabled').prop('checked', settings().enabled).on('input', function () {
        setEnabled(!!$(this).prop('checked'));
    });
    bindCheckbox('#cacheopt_freeze', 'freezeHead');
    bindCheckbox('#cacheopt_tail', 'moveTail');

    $('#cacheopt_reset').on('click', () => {
        state.skeletons.delete(currentChatId());
        persist();
        render();
        toastr.info('骨架已清空，下一次生成时重建（这一轮不命中）', '缓存优化');
    });

    $('#cacheopt_check').on('click', () => {
        $('#cacheopt_diag').text(diagnostics());
        checkCurrent().catch(e => $('#cacheopt_diag').text(`检查失败：${e?.message || e}`));
    });

    // 魔法棒菜单一键开关
    const item = $(`<div id="cacheopt_wand_container" class="extension_container interactable" tabindex="0">
        <div id="cacheopt_menu" class="list-group-item flex-container flexGap5 interactable" tabindex="0" role="listitem" title="一键开关缓存优化">
          <div class="fa-solid fa-bolt extensionsMenuExtensionButton"></div><span id="cacheopt_menu_label"></span></div></div>`);
    item.on('click', () => {
        setEnabled(!settings().enabled);
        toastr.info(`缓存优化已${settings().enabled ? '开启' : '关闭'}`, '缓存优化');
    });
    $('#extensionsMenu').append(item);
    setEnabled(settings().enabled);
    render();
}

/** 只组装不发送：拿当前提示词和上一轮真实请求比 */
async function checkCurrent() {
    const c = ctx();
    if (c.mainApi !== 'openai') {
        $('#cacheopt_diag').text('只支持对话补全（Chat Completion）接口。');
        return;
    }
    let captured = null;
    const handler = data => { captured = (data?.chat ?? []).map(m => `[${m.role}]${text(m)}`); };
    c.eventSource.on(c.eventTypes.CHAT_COMPLETION_PROMPT_READY, handler);
    try {
        await c.generate('normal', {}, true);
    } finally {
        c.eventSource.removeListener(c.eventTypes.CHAT_COMPLETION_PROMPT_READY, handler);
    }
    const prev = state.requests.get(currentChatId());
    const head = [
        diagnostics(),
        '',
        captured ? '当前提示词已组装成功（未发送）。' : '组装失败。',
        prev && captured
            ? describeDiff({ msgs: prev.msgs, at: prev.at }, { msgs: captured, at: Date.now() })
            : '还没有上一轮真实请求可对比，先正常发送一次。',
    ].join('\n');
    $('#cacheopt_diag').text(head);
}

// ───────────────────────── 启动 ─────────────────────────

jQuery(() => {
    try {
        settings();
        loadSkeletons();
        renderSettings();
        watchNetwork();
        const c = ctx();
        const evt = c.eventTypes ?? {};
        c.eventSource.on(evt.CHAT_COMPLETION_PROMPT_READY ?? 'chat_completion_prompt_ready', data => {
            try {
                if (!Array.isArray(data?.chat)) return;
                const r = stabilize(data.chat, !!data.dryRun);
                if (!data.dryRun) {
                    // 宿主（如 TauriTavern）可能把请求藏在自己的进程里，拦不到 fetch；
                    // 用事件里这份已经改好的提示词兜底，保证"两轮对比"照样有数据
                    try { noteSent(data.chat.map(m => `[${m.role}]${text(m)}`)); } catch { /* 忽略 */ }
                    if (r.skipped === 'single') {
                        state.lastRun = '⚠ 开头的 system 消息只有 1 块（多半开了「合并系统消息」或提示词后处理），无法逐块冻结';
                    } else if (r.skipped === 'empty') {
                        state.lastRun = '⚠ 开头没有 system 消息（「使用系统提示」可能关着），无法冻结前缀';
                    }
                    render();
                }
            } catch (e) {
                console.error('[缓存优化] 冻结失败（已跳过，不影响生成）', e);
            }
        });
        console.info(`[缓存优化] v${VERSION} 已加载`);
    } catch (e) {
        console.error('[缓存优化] 初始化失败', e);
    }
});
