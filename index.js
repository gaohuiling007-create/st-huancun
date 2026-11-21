// ST-Cache-Optimizer 2.4.4
//
// 只调整当前请求中的提示词，不修改世界书文件。
// 请求诊断观察浏览器 -> 酒馆后端的消息及响应副本。
// 后端转换后的最终 Google 请求不在前端诊断范围内。
// 字符前缀比例不等于实际缓存 token 命中率。

const MODULE = 'cacheOptimizer';

const DEFAULTS = {
    enabled: true,
    routeWorldInfo: true,
    hoistStatic: true,
    learn: true,
    stickyLore: false,
    stickyTurns: 6,
    volatileHeads: ['〔记忆系统私密简报'],
    learnedHeads: [],
    keepPatterns: 'output_format|Force_Structured|^<\\/?Format>|jailbreak|破限',
};

const WRAP_OPEN = '<当前剧情相关设定>';
const WRAP_CLOSE = '</当前剧情相关设定>';
const WRAP_WORLD = '__cache_optimizer__';
const STATIC_OPEN = '<固定设定>';
const STATIC_CLOSE = '</固定设定>';
const STICKY_OPEN = '<近期剧情设定>';
const STICKY_CLOSE = '</近期剧情设定>';

const TOP_DEPTH = 10000;
const STICKY_ORDER_BASE = 2000000;
const HOIST_ORDER_BASE = 100000;
const MAX_LEARNED = 30;
const MAX_LEARN_CHARS = 20000;

const POS = {
    before: 0,
    after: 1,
    anTop: 2,
    anBottom: 3,
    atDepth: 4,
    emTop: 5,
    emBottom: 6,
    outlet: 7,
};

const DYNAMIC_EJS = /stat_data|getMessageVar|getvar\(\s*['"`]stat_data|random|Math\.|Date|roll|_\.(sample|shuffle)|lastUserMessage|lastCharMessage|chat\[|incvar|addvar/;
const DYNAMIC_MACRO = /\{\{(roll|random|pick|time|date|weekday|isotime|isodate|datetimeformat|idle_duration|lastMessage|lastUserMessage|lastCharMessage|lastMessageId)/i;
const DYNAMIC_TAG = /<status_current_variables>\s*(<%|\{\{)/i;

const GENERATE_PATH = '/api/backends/chat-completions/generate';
const RECENT_LIMIT = 12;
const MAX_EVENT_CHARS = 2 * 1024 * 1024;

let lastRun = '尚未处理生成请求';
let lastSystemBlocks = null;
let checking = false;
let recentReal = [];
let latestReal = null;
let lastUsageReport = '等待响应缓存用量。';

const changeCounts = new Map();

function ctx() {
    return SillyTavern.getContext();
}

function settings() {
    const all = ctx().extensionSettings;
    all[MODULE] ??= structuredClone(DEFAULTS);

    for (const [key, value] of Object.entries(DEFAULTS)) {
        all[MODULE][key] ??= structuredClone(value);
    }

    if (!Array.isArray(all[MODULE].volatileHeads)) {
        all[MODULE].volatileHeads = [...DEFAULTS.volatileHeads];
    }
    if (!Array.isArray(all[MODULE].learnedHeads)) {
        all[MODULE].learnedHeads = [];
    }

    return all[MODULE];
}

function save() {
    ctx().saveSettingsDebounced();
}

function chatId() {
    return ctx().getCurrentChatId?.() ?? '';
}

function text(message) {
    if (typeof message?.content === 'string') return message.content;

    if (Array.isArray(message?.content)) {
        return message.content
            .filter(part => part?.type === 'text'
                && typeof part.text === 'string')
            .map(part => part.text)
            .join('\n');
    }

    return '';
}

function stableJSON(value) {
    function sorted(v) {
        if (Array.isArray(v)) return v.map(sorted);

        if (v && typeof v === 'object') {
            return Object.fromEntries(
                Object.keys(v).sort().map(key => [key, sorted(v[key])]),
            );
        }

        return v;
    }

    return JSON.stringify(sorted(value)) ?? '';
}

function keepRegex() {
    try {
        return new RegExp(settings().keepPatterns, 'im');
    } catch {
        return new RegExp(DEFAULTS.keepPatterns, 'im');
    }
}

// ───────────────── 世界书现场调整 ─────────────────

function isDynamicContent(entry) {
    const content = String(entry.content ?? '');
    const blocks = content.match(/<%[\s\S]*?%>/g) ?? [];

    return blocks.some(block => DYNAMIC_EJS.test(block))
        || DYNAMIC_MACRO.test(content)
        || DYNAMIC_TAG.test(content)
        || (!!entry.useProbability
            && Number(entry.probability ?? 100) < 100);
}

function isDynamicEntry(entry) {
    return isDynamicContent(entry)
        || Number(entry.sticky) > 0
        || Number(entry.cooldown) > 0
        || Number(entry.delay) > 0;
}

function presetSlotBeforeHistory(identifier) {
    const orders = ctx().chatCompletionSettings?.prompt_order ?? [];
    const order = (
        orders.find(item => item.character_id === 100001) ?? orders[0]
    )?.order ?? [];

    const index = id => order.findIndex(
        item => item.identifier === id && item.enabled !== false,
    );

    const slot = index(identifier);
    const history = index('chatHistory');

    return slot < 0 || history < 0 || slot < history;
}

function systemBlocksGetMerged() {
    const cc = ctx().chatCompletionSettings ?? {};

    return ['makersuite', 'vertexai'].includes(cc.chat_completion_source)
        || !!cc.custom_prompt_post_processing;
}

function routeEntries(lists) {
    const s = settings();
    if (!s.enabled || !s.routeWorldInfo) return;

    const keep = keepRegex();
    const beforeOk = presetSlotBeforeHistory('worldInfoBefore');
    const afterOk = presetSlotBeforeHistory('worldInfoAfter');
    const stickyOn = s.stickyLore && !systemBlocksGetMerged();
    const stickyTurns = Math.max(
        1, Math.floor(Number(s.stickyTurns) || DEFAULTS.stickyTurns),
    );

    let moved = null;
    let top = null;
    let sticky = null;

    const visited = new WeakSet();

    const toTop = (entry, list, order) => {
        Object.assign(entry, {
            position: POS.atDepth,
            depth: TOP_DEPTH,
            role: 0,
            order,
        });
        top ??= { entry, list };
    };

    for (const list of lists) {
        if (!Array.isArray(list)) continue;

        // 使用快照，包装条目在扫描完成后添加。
        for (const entry of [...list]) {
            if (!entry || typeof entry !== 'object'
                || visited.has(entry)
                || entry.disable
                || entry.world === WRAP_WORLD) continue;

            visited.add(entry);

            const firstLine = String(entry.content ?? '')
                .trimStart().split('\n', 1)[0];

            if (keep.test(String(entry.comment ?? ''))
                || keep.test(firstLine)) continue;

            const position = Number(entry.position);

            if (position === POS.before || position === POS.after) {
                if (stickyOn
                    && !entry.constant
                    && !isDynamicContent(entry)) {
                    Object.assign(entry, {
                        position: POS.atDepth,
                        depth: TOP_DEPTH,
                        role: 0,
                        order: STICKY_ORDER_BASE
                            + (position === POS.after ? 50000 : 0)
                            + (Number(entry.order) || 0),
                        sticky: Math.max(
                            Number(entry.sticky) || 0, stickyTurns,
                        ),
                    });

                    sticky ??= { entry, list };
                } else if (!entry.constant || isDynamicEntry(entry)) {
                    Object.assign(entry, {
                        position: POS.atDepth,
                        depth: 0,
                        role: 0,
                    });

                    moved ??= { entry, list };
                } else if (
                    position === POS.before ? !beforeOk : !afterOk
                ) {
                    toTop(
                        entry,
                        list,
                        (position === POS.after ? 50000 : 0)
                            + (Number(entry.order) || 0),
                    );
                }
            } else if (
                position === POS.atDepth
                && (!entry.constant || isDynamicEntry(entry))
            ) {
                if (Number(entry.depth) !== 0) {
                    entry.depth = 0;
                    moved ??= { entry, list };
                }
            } else if (
                s.hoistStatic
                && entry.constant
                && !isDynamicEntry(entry)
                && [POS.atDepth, POS.anTop, POS.anBottom].includes(position)
            ) {
                const depth = position === POS.atDepth
                    ? Number(entry.depth) || 0
                    : 0;

                const order = HOIST_ORDER_BASE
                    + (100 - Math.min(depth, 99)) * 1000
                    + (Number(entry.order) || 0);

                if (beforeOk) {
                    Object.assign(entry, {
                        position: POS.before,
                        order,
                    });
                } else {
                    toTop(entry, list, order);
                }
            }
        }
    }

    const wrapper = (entry, uid, content, order, depth) => ({
        ...entry,
        uid,
        world: WRAP_WORLD,
        comment: content,
        content,
        order,
        key: [],
        keysecondary: [],
        constant: true,
        disable: false,
        selective: false,
        useProbability: false,
        probability: 100,
        group: '',
        groupOverride: false,
        sticky: 0,
        cooldown: 0,
        delay: 0,
        position: POS.atDepth,
        depth,
        role: 0,
        excludeRecursion: true,
        preventRecursion: true,
    });

    const addPair = (
        target, uid, open, close, firstOrder, lastOrder, depth,
    ) => {
        if (!target) return;

        target.list.push(
            wrapper(target.entry, uid, open, firstOrder, depth),
            wrapper(target.entry, uid - 1, close, lastOrder, depth),
        );
    };

    addPair(
        moved, -910001, WRAP_OPEN, WRAP_CLOSE,
        -1000000, 1000000, 0,
    );

    addPair(
        top, -910003, STATIC_OPEN, STATIC_CLOSE,
        -1000000, 1000000, TOP_DEPTH,
    );

    addPair(
        sticky, -910005, STICKY_OPEN, STICKY_CLOSE,
        STICKY_ORDER_BASE - 500000,
        STICKY_ORDER_BASE + 1000000,
        TOP_DEPTH,
    );
}

// ───────────────── 重排与学习 ─────────────────

function headOf(message) {
    return text(message).trimStart().split('\n', 1)[0].slice(0, 40);
}

function isTopBlock(message) {
    const value = text(message).trimStart();
    return value.startsWith(STATIC_OPEN)
        || value.startsWith(STICKY_OPEN);
}

function isVolatileHead(head) {
    const s = settings();
    return [...s.volatileHeads, ...s.learnedHeads]
        .some(value => value && head.startsWith(value));
}

function normalize(value) {
    return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function historySnippets() {
    return (ctx().chat ?? [])
        .filter(message => message && !message.is_system
            && typeof message.mes === 'string'
            && message.mes.trim())
        .slice(-60)
        .map(message => {
            const value = normalize(message.mes);
            if (value.length <= 60) return [value];

            return [0.3, 0.5, 0.7].map(position => {
                const start = Math.floor(value.length * position);
                return value.slice(start, start + 30);
            });
        });
}

function findHistoryRange(chat) {
    const snippets = historySnippets();
    if (!snippets.length) return null;

    let start = -1;
    let end = -1;

    chat.forEach((message, index) => {
        if (message.role === 'system') return;

        const value = normalize(text(message));

        if (value && snippets.some(parts =>
            parts.some(part => part && value.includes(part)))) {
            if (start < 0) start = index;
            end = index;
        }
    });

    return start < 0 ? null : { start, end };
}

function canMoveSystem(message) {
    // 工具调用、多模态内容和保持原位的规则不参与重排。
    return message?.role === 'system'
        && typeof message.content === 'string'
        && !message.tool_calls
        && !message.tool_call_id
        && !isTopBlock(message)
        && !keepRegex().test(headOf(message));
}

function reorder(chat) {
    const range = findHistoryRange(chat);
    const start = range?.start
        ?? chat.findIndex(message => message.role !== 'system');
    const end = range?.end
        ?? chat.findLastIndex(message => message.role === 'user');

    if (start < 0 || end < 0) return 0;

    const anchor = chat[end];
    const moved = [];

    for (let i = end - 1; i > start; i--) {
        if (canMoveSystem(chat[i])) {
            moved.unshift(...chat.splice(i, 1));
        }
    }

    for (let i = start - 1; i >= 0; i--) {
        const value = text(chat[i]).trimStart();

        if (canMoveSystem(chat[i])
            && ((isVolatileHead(headOf(chat[i]))
                && value.length <= MAX_LEARN_CHARS)
                || value.startsWith(WRAP_OPEN))) {
            moved.unshift(...chat.splice(i, 1));
        }
    }

    if (moved.length) {
        const at = chat.indexOf(anchor);
        chat.splice(range ? at + 1 : at, 0, ...moved);
    }

    return moved.length;
}

function learnFrom(chat) {
    const s = settings();
    if (!s.learn) return [];

    const currentChat = chatId();

    if (lastSystemBlocks
        && lastSystemBlocks.chatId !== currentChat) {
        changeCounts.clear();
    }

    const range = findHistoryRange(chat);
    const firstTurn = chat.findIndex(message => message.role !== 'system');
    const stop = range?.start
        ?? (firstTurn < 0 ? chat.length : firstTurn);

    const blocks = chat.slice(0, stop)
        .filter(canMoveSystem)
        .map(message => ({
            head: headOf(message),
            body: text(message),
        }));

    const learned = [];

    if (lastSystemBlocks?.chatId === currentChat) {
        const previous = new Map();
        const duplicates = new Set();
        const currentCounts = new Map();

        for (const block of lastSystemBlocks.blocks) {
            if (previous.has(block.head)) duplicates.add(block.head);
            previous.set(block.head, block.body);
        }

        for (const block of blocks) {
            currentCounts.set(
                block.head,
                (currentCounts.get(block.head) ?? 0) + 1,
            );
        }

        for (const block of blocks) {
            if (block.head.length < 4
                || duplicates.has(block.head)
                || currentCounts.get(block.head) > 1
                || !previous.has(block.head)
                || previous.get(block.head) === block.body
                || isVolatileHead(block.head)
                || block.body.length > MAX_LEARN_CHARS) continue;

            const count = (changeCounts.get(block.head) ?? 0) + 1;
            changeCounts.set(block.head, count);

            if (count < 2) continue;

            s.learnedHeads.push(block.head);
            learned.push(block.head);
        }

        if (learned.length) {
            s.learnedHeads = [...new Set(s.learnedHeads)]
                .slice(-MAX_LEARNED);
            save();
        }
    }

    lastSystemBlocks = { chatId: currentChat, blocks };
    return learned;
}

function onPromptReady(data) {
    if (!settings().enabled || !Array.isArray(data?.chat)) return;

    const count = reorder(data.chat);
    if (data.dryRun || checking) return;

    const learned = learnFrom(data.chat);

    lastRun = `${new Date().toLocaleTimeString()} 重排：移动 ${count} 个块`
        + (learned.length
            ? `；新学到 ${learned.length} 个易变块`
            : '');

    $('#cacheopt_last').text(lastRun);
    renderLearned();
}

// ───────────────── 免费模拟检查 ─────────────────

function sharedPrefix(a, b) {
    let k = 0;

    while (k < a.length && k < b.length && a[k] === b[k]) k++;

    let at = 0;

    if (k < a.length && k < b.length) {
        while (at < a[k].length
            && at < b[k].length
            && a[k][at] === b[k][at]) at++;
    }

    const chars = a.slice(0, k)
        .reduce((sum, value) => sum + value.length + 1, 0) + at;

    return { k, at, chars };
}

async function captureDryRun() {
    const c = ctx();
    let captured = null;

    const handler = data => {
        if (Array.isArray(data?.chat)) {
            captured = structuredClone(data.chat);
        }
    };

    c.eventSource.on(c.eventTypes.CHAT_COMPLETION_PROMPT_READY, handler);

    try {
        await c.generate('normal', {}, true);
    } finally {
        c.eventSource.removeListener(
            c.eventTypes.CHAT_COMPLETION_PROMPT_READY,
            handler,
        );
    }

    return captured;
}

async function checkStability() {
    if (checking) return;

    const c = ctx();
    const report = $('#cacheopt_report');

    if (c.mainApi !== 'openai') {
        report.text('只支持对话补全（Chat Completion）接口。');
        return;
    }

    const lastUser = c.chat.findLastIndex(message => message.is_user);

    if (lastUser < 2) {
        report.text('聊天记录太短，至少需要两轮对话。');
        return;
    }

    checking = true;
    $('#cacheopt_check').attr('aria-disabled', 'true');
    report.text('模拟检查中，不调用模型。请等待完成后再操作聊天。');

    try {
        let previous;

        // 与原版相同，通过临时截短内存聊天模拟上一轮。
        // 无论组装成功与否，都恢复被移除的消息。
        const removed = c.chat.splice(lastUser - 1);

        try {
            previous = await captureDryRun();
        } finally {
            c.chat.push(...removed);
        }

        const current = await captureDryRun();

        if (!previous || !current) {
            report.text('检查失败：没有捕获到组装后的提示词。');
            return;
        }

        const a = previous.map(stableJSON);
        const b = current.map(stableJSON);
        const { k, at, chars } = sharedPrefix(a, b);
        const total = b.reduce(
            (sum, value) => sum + value.length + 1, 0,
        );

        const leadingSystem = list => {
            const result = [];

            for (const message of list) {
                if (message.role !== 'system') break;
                result.push(message);
            }

            return stableJSON(result);
        };

        const systemSame =
            leadingSystem(previous) === leadingSystem(current);

        report.text([
            `开头系统消息一致：${systemSame ? '✅ 是' : '❌ 否，可能影响缓存'}`,
            `消息序列化前缀相同：${
                total ? (chars / total * 100).toFixed(1) : '0.0'
            }%（${chars.toLocaleString()} / ${total.toLocaleString()} 字符）`,
            `前 ${k} 条消息完整相同。`,
            k < previous.length && k < current.length
                ? `首个变化：第 ${k + 1} 条（${current[k]?.role}），序列化位置 ${at}。`
                : '其中一组消息是另一组的完整前缀。',
            '这是字符稳定性比较，不是实际缓存 token 命中率。',
            '模拟不包含后端 Google 格式转换，以及部分扩展仅在真实生成时执行的修改。',
        ].join('\n'));
    } finally {
        checking = false;
        $('#cacheopt_check').removeAttr('aria-disabled');
    }
}

// ───────────────── 真实请求诊断 ─────────────────

function requestGroup(body) {
    return stableJSON({
        chatId: chatId(),
        source: body.chat_completion_source
            ?? ctx().chatCompletionSettings?.chat_completion_source
            ?? '',
        model: body.model ?? '',
        type: body.type ?? 'unknown',
        region: body.vertexai_region ?? '',
        secretId: body.secret_id ?? '',
        proxy: body.reverse_proxy ?? '',
        customUrl: body.custom_url ?? '',
    });
}

function toolDefinition(body) {
    return stableJSON({
        tools: body.tools ?? null,
        functions: body.functions ?? null,
        tool_choice: body.tool_choice ?? null,
        function_call: body.function_call ?? null,
    });
}

function prefixConfig(body) {
    return stableJSON({
        use_sysprompt: body.use_sysprompt ?? null,
        char_name: body.char_name ?? null,
        user_name: body.user_name ?? null,
        group_names: body.group_names ?? null,
        custom_prompt_post_processing:
            body.custom_prompt_post_processing ?? null,
        enable_web_search: body.enable_web_search ?? null,
        json_schema: body.json_schema ?? null,
        responseMimeType: body.responseMimeType ?? null,
        responseSchema: body.responseSchema ?? null,
    });
}

function publishReal(cur) {
    if (latestReal !== cur) return;
    $('#cacheopt_real').text(cur.lines.join('\n'));
}

function recordRealRequest(rawBody) {
    let body;

    try {
        body = JSON.parse(rawBody);
    } catch {
        return null;
    }

    if (!body || !Array.isArray(body.messages)) return null;

    const now = Date.now();

    const cur = {
        group: requestGroup(body),
        at: now,
        chatId: chatId(),
        model: String(body.model ?? '未提供'),
        type: String(body.type ?? '未标记'),
        stream: Boolean(body.stream),
        texts: body.messages.map(stableJSON),
        roles: body.messages.map(message => message?.role ?? '?'),
        tools: toolDefinition(body),
        config: prefixConfig(body),
        lines: [],
    };

    const previous = recentReal.findLast(
        item => item.group === cur.group,
    );

    cur.lines.push(
        `${new Date().toLocaleTimeString()}｜模型：${cur.model}`,
        `用途：${cur.type}；${cur.stream ? '流式' : '非流式'}`,
        `当前 ${cur.texts.length} 条消息；包含数组内容和工具调用字段。`,
    );

    if (cur.type === '未标记') {
        cur.lines.push('请求未标记用途，同组仍可能混入辅助请求。');
    }

    if (previous) {
        const { k, at, chars } = sharedPrefix(
            previous.texts, cur.texts,
        );

        const total = cur.texts.reduce(
            (sum, value) => sum + value.length + 1, 0,
        );

        cur.lines.push(
            `对比同组紧邻上一次请求：${Math.round((now - previous.at) / 1000)} 秒前`,
            `消息数量：${previous.texts.length} → ${cur.texts.length}`,
            `消息序列化前缀相同：${
                total ? (chars / total * 100).toFixed(1) : '0.0'
            }%（${chars.toLocaleString()} / ${total.toLocaleString()} 字符）`,
            `前 ${k} 条消息完整相同。`,
        );

        if (k === previous.texts.length && k === cur.texts.length) {
            cur.lines.push('消息字段完全相同。');
        } else if (k === previous.texts.length) {
            cur.lines.push('本次在上次消息序列末尾追加了消息。');
        } else if (k === cur.texts.length) {
            cur.lines.push('本次消息序列比上次更短。');
        } else {
            cur.lines.push(
                `首个变化：第 ${k + 1} 条（${cur.roles[k]}），`
                + `序列化字符位置 ${at}。`,
            );
        }

        cur.lines.push(
            previous.tools === cur.tools
                ? '工具定义及调用配置：相同。'
                : '⚠ 工具定义或调用配置发生变化。',
            previous.config === cur.config
                ? '系统提示开关、名称、后处理及输出格式配置：相同。'
                : '⚠ 系统提示开关、名称、后处理或输出格式配置发生变化。',
        );
    } else {
        cur.lines.push('当前组首次记录，下一次同组请求后比较。');
    }

    cur.lines.push(
        '比较范围：浏览器 → 酒馆后端。后端可能再次转换消息。',
        '字符比例不是缓存 token 命中率；实际报告见下方。',
    );

    latestReal = cur;
    recentReal.push(cur);
    recentReal = recentReal.slice(-RECENT_LIMIT);

    publishReal(cur);
    return cur;
}

// ───────────────── 响应用量诊断 ─────────────────

function readUsage(value, state) {
    if (!value || typeof value !== 'object') return;

    if (Array.isArray(value)) {
        for (const item of value) readUsage(item, state);
        return;
    }

    const validCount = count =>
        typeof count === 'number'
        && Number.isFinite(count)
        && count >= 0;

    const google = value.usageMetadata ?? value.usage_metadata;

    if (google && typeof google === 'object') {
        state.sawUsage = true;

        const count = google.cachedContentTokenCount
            ?? google.cached_content_token_count;

        if (validCount(count)) {
            state.cached = count;
            state.field = 'usageMetadata.cachedContentTokenCount';
        }
    }

    const usage = value.usage;

    if (usage && typeof usage === 'object') {
        state.sawUsage = true;

        const count = usage.prompt_tokens_details?.cached_tokens
            ?? usage.input_tokens_details?.cached_tokens;

        if (validCount(count)) {
            state.cached = count;
            state.field = 'usage.*_tokens_details.cached_tokens';
        }
    }

    // 部分中转将响应包在这些字段中。
    for (const key of ['data', 'response', 'result']) {
        if (value[key] && typeof value[key] === 'object') {
            readUsage(value[key], state);
        }
    }
}

function publishUsage(cur, message) {
    // 清空诊断后，忽略仍在完成的旧请求。
    if (!recentReal.includes(cur)) return;

    lastUsageReport = [
        `${new Date(cur.at).toLocaleTimeString()} 发出的请求`,
        `模型：${cur.model}；用途：${cur.type}`,
        message,
        '这里读取浏览器收到的响应；费用面板由另一插件独立统计。',
    ].join('\n');

    $('#cacheopt_usage').text(lastUsageReport);
}

async function observeRealResponse(copy, cur) {
    const state = {
        cached: null,
        sawUsage: false,
        field: '',
    };

    let reader = null;
    let completed = false;
    let limited = false;

    try {
        if (!copy.ok) {
            publishUsage(
                cur,
                `响应失败：HTTP ${copy.status}；无法判断缓存。`,
            );
            return;
        }

        const contentType = copy.headers.get('content-type') ?? '';

        // 酒馆后端可能没有转发 SSE Content-Type。
        // 优先依据原始请求中的 stream 标记。
        const isStream = cur.stream
            || contentType.includes('text/event-stream');

        if (!isStream) {
            readUsage(await copy.json(), state);
            completed = true;
        } else {
            if (!copy.body) throw new Error('没有响应流');

            reader = copy.body.getReader();

            const decoder = new TextDecoder();
            let pending = '';
            let eventData = [];
            let eventSize = 0;

            const consumeEvent = () => {
                const data = eventData.join('\n').trim();
                eventData = [];
                eventSize = 0;

                if (!data || data === '[DONE]') return;

                try {
                    readUsage(JSON.parse(data), state);
                } catch {
                    // 非 JSON 事件不参与用量判断。
                }
            };

            const consumeLine = line => {
                line = line.replace(/\r$/, '');

                if (!line) {
                    consumeEvent();
                } else if (line.startsWith('data:')) {
                    const data = line.slice(5).replace(/^ /, '');
                    eventData.push(data);
                    eventSize += data.length;
                }
            };

            while (true) {
                const { value, done } = await reader.read();

                pending += done
                    ? decoder.decode()
                    : decoder.decode(value, { stream: true });

                let newline;

                while ((newline = pending.indexOf('\n')) >= 0) {
                    consumeLine(pending.slice(0, newline));
                    pending = pending.slice(newline + 1);

                    if (eventSize > MAX_EVENT_CHARS) {
                        limited = true;
                        break;
                    }
                }

                if (limited
                    || pending.length + eventSize > MAX_EVENT_CHARS) {
                    limited = true;
                    break;
                }

                if (done) {
                    if (pending) consumeLine(pending);
                    consumeEvent();
                    completed = true;
                    break;
                }
            }
        }

        const suffix = completed
            ? ''
            : '\n诊断读取未完成，用量可能不完整。';

        if (state.cached !== null) {
            publishUsage(
                cur,
                (state.cached > 0
                    ? `✅ 响应报告缓存命中：${state.cached.toLocaleString()} tokens`
                    : '响应明确报告缓存为 0')
                    + `\n字段：${state.field}`
                    + suffix,
            );
        } else {
            publishUsage(
                cur,
                (limited
                    ? '单个诊断事件超过大小上限，已停止读取诊断副本。'
                    : state.sawUsage
                        ? '收到用量信息，但未发现支持的缓存字段。'
                        : '未识别到响应中的用量信息。')
                    + '\n字段缺失不能直接认定为实际零命中。'
                    + '\n非流式响应可能被酒馆后端省略用量。'
                    + suffix,
            );
        }
    } catch {
        publishUsage(
            cur,
            state.cached !== null
                ? `已观察到缓存 ${state.cached.toLocaleString()} tokens；`
                    + '诊断读取中断，用量可能不完整。'
                : '响应诊断中断或格式不支持，无法判断实际缓存是否为零。',
        );
    } finally {
        if (reader) {
            if (!completed) {
                // 只取消响应副本，不取消酒馆使用的原响应。
                reader.cancel().catch(() => {});
            } else {
                reader.releaseLock();
            }
        }
    }
}

function watchRealRequests() {
    const original = window.fetch;
    if (original.__cacheoptWatch) return;

    const wrapped = function (input, init) {
        let recording = Promise.resolve(null);
        let watched = false;

        try {
            const url = typeof input === 'string'
                ? input
                : input instanceof URL
                    ? input.href
                    : input?.url;

            watched = !!url
                && new URL(url, location.href).pathname === GENERATE_PATH;

            if (watched) {
                if (typeof init?.body === 'string') {
                    recording = Promise.resolve(
                        recordRealRequest(init.body),
                    );
                } else if (
                    typeof Request !== 'undefined'
                    && input instanceof Request
                    && init?.body === undefined
                ) {
                    recording = input.clone().text()
                        .then(recordRealRequest)
                        .catch(() => null);
                }
            }
        } catch {
            // 诊断失败不改变原请求。
        }

        const result = original.apply(this, arguments);

        if (!watched) return result;

        result.then(
            response => {
                // 在其他消费者读取原响应之前立即复制。
                let copy;

                try {
                    copy = response.clone();
                } catch {
                    recording.then(cur => {
                        if (cur) {
                            publishUsage(
                                cur,
                                '无法创建响应诊断副本，无法判断缓存。',
                            );
                        }
                    }).catch(() => {});
                    return;
                }

                recording.then(cur => {
                    if (!cur) {
                        if (copy.body) {
                            copy.body.cancel().catch(() => {});
                        }
                        return;
                    }

                    observeRealResponse(copy, cur).catch(() => {});
                }).catch(() => {
                    if (copy.body) copy.body.cancel().catch(() => {});
                });
            },
            () => {
                recording.then(cur => {
                    if (cur) {
                        publishUsage(
                            cur,
                            '请求失败或取消，无法判断实际缓存。',
                        );
                    }
                }).catch(() => {});
            },
        );

        return result;
    };

    wrapped.__cacheoptWatch = true;
    window.fetch = wrapped;
}

// ───────────────── 设置界面 ─────────────────

function setEnabled(value) {
    settings().enabled = value;
    save();

    $('#cacheopt_enabled').prop('checked', value);
    $('#cacheopt_menu_label').text(`缓存优化：${value ? '开' : '关'}`);

    $('#cacheopt_menu .extensionsMenuExtensionButton')
        .css('opacity', value ? '' : '0.4');
}

function renderLearned() {
    const list = settings().learnedHeads;

    $('#cacheopt_learned').text(
        list.length
            ? `已学到的易变块（${list.length}）：${list.join(' / ')}`
            : '已学到的易变块：暂无',
    );
}

function bindCheckbox(id, key) {
    $(id).prop('checked', !!settings()[key]).on('input', function () {
        settings()[key] = !!$(this).prop('checked');
        save();
    });
}

function clearDiagnostics() {
    recentReal = [];
    latestReal = null;
    lastUsageReport = '等待响应缓存用量。';

    $('#cacheopt_real').text('诊断记录已清空，等待新的真实请求。');
    $('#cacheopt_usage').text(lastUsageReport);
}

function renderSettings() {
    $('#extensions_settings2').append(`
    <div class="cacheopt-settings">
      <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
          <b>⚡ 缓存优化 2.4.4</b>
          <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>

        <div class="inline-drawer-content">
          <label class="checkbox_label">
            <input id="cacheopt_enabled" type="checkbox">
            <span>启用提示词缓存优化</span>
          </label>

          <label class="checkbox_label">
            <input id="cacheopt_route" type="checkbox">
            <span>世界书现场调整：关键词 / 会变的条目移到聊天中（不改文件）</span>
          </label>

          <label class="checkbox_label">
            <input id="cacheopt_hoist" type="checkbox">
            <span>固定规则条目前移进系统提示</span>
          </label>

          <label class="checkbox_label">
            <input id="cacheopt_sticky" type="checkbox">
            <span>
              关键词设定放到聊天记录前并保持
              <input id="cacheopt_sticky_turns"
                class="text_pole cacheopt-num"
                type="number" min="1" max="50">
              条消息
              （Gemini / Vertex 或开启提示词后处理时自动不生效）
            </span>
          </label>

          <label class="checkbox_label">
            <input id="cacheopt_learn" type="checkbox">
            <span>自动学习系统提示里的易变块</span>
          </label>

          <label class="cacheopt-label">
            保持原位的条目（正则，匹配条目名或内容开头）
            <input id="cacheopt_keep" class="text_pole" type="text">
          </label>

          <div class="cacheopt-row">
            <button id="cacheopt_check" type="button" class="menu_button">
              检查提示词稳定性（免费）
            </button>
            <button id="cacheopt_forget" type="button" class="menu_button">
              清空已学到的易变块
            </button>
            <button id="cacheopt_clear" type="button" class="menu_button">
              清空请求诊断
            </button>
          </div>

          <div id="cacheopt_learned" class="cacheopt-hint"></div>
          <div id="cacheopt_last" class="cacheopt-hint"></div>

          <div id="cacheopt_report" class="cacheopt-report">免费检查比较消息字符前缀，不代表实际缓存命中率。</div>

          <div class="cacheopt-hint">
            真实请求对比：按聊天、接口、模型和请求用途分组，
            比较同组紧邻上一次请求。
          </div>
          <div id="cacheopt_real" class="cacheopt-report">等待新的真实请求。</div>

          <div class="cacheopt-hint">
            最近完成的响应诊断：
          </div>
          <div id="cacheopt_usage" class="cacheopt-report"></div>

          <div class="cacheopt-hint">
            关闭上方提示词优化后，请求诊断仍继续。
            诊断不会额外调用模型，记录只保存在当前页面内存中。
            本扩展无法强制上游命中缓存。
          </div>
        </div>
      </div>
    </div>`);

    $('#cacheopt_enabled')
        .prop('checked', settings().enabled)
        .on('input', function () {
            setEnabled(!!$(this).prop('checked'));
        });

    bindCheckbox('#cacheopt_route', 'routeWorldInfo');
    bindCheckbox('#cacheopt_hoist', 'hoistStatic');
    bindCheckbox('#cacheopt_learn', 'learn');
    bindCheckbox('#cacheopt_sticky', 'stickyLore');

    $('#cacheopt_sticky_turns')
        .val(settings().stickyTurns)
        .on('change', function () {
            settings().stickyTurns = Math.min(
                50,
                Math.max(
                    1,
                    Math.floor(Number($(this).val()))
                        || DEFAULTS.stickyTurns,
                ),
            );

            $(this).val(settings().stickyTurns);
            save();
        });

    $('#cacheopt_keep')
        .val(settings().keepPatterns)
        .on('change', function () {
            const value = String($(this).val());

            try {
                new RegExp(value, 'im');
            } catch {
                toastr.warning('正则表达式无效，已保留原设置。', '缓存优化');
                $(this).val(settings().keepPatterns);
                return;
            }

            settings().keepPatterns = value;
            save();
        });

    $('#cacheopt_check').on('click', () => {
        checkStability().catch(error => {
            $('#cacheopt_report').text(
                `检查失败：${error?.message || error}`,
            );
        });
    });

    $('#cacheopt_forget').on('click', () => {
        settings().learnedHeads = [];
        changeCounts.clear();
        lastSystemBlocks = null;
        save();
        renderLearned();
    });

    $('#cacheopt_clear').on('click', clearDiagnostics);

    $('#cacheopt_last').text(lastRun);
    $('#cacheopt_usage').text(lastUsageReport);
    renderLearned();

    const item = $(`
      <div id="cacheopt_wand_container"
        class="extension_container interactable" tabindex="0">
        <div id="cacheopt_menu"
          class="list-group-item flex-container flexGap5 interactable"
          tabindex="0" role="listitem" title="切换提示词缓存优化">
          <div class="fa-solid fa-bolt extensionsMenuExtensionButton"></div>
          <span id="cacheopt_menu_label"></span>
        </div>
      </div>`);

    item.on('click', () => {
        setEnabled(!settings().enabled);

        toastr.info(
            `提示词优化已${settings().enabled ? '开启' : '关闭'}，请求诊断继续`,
            '缓存优化',
        );
    });

    $('#extensionsMenu').append(item);
    setEnabled(settings().enabled);
}

jQuery(() => {
    settings();

    // 不再展示旧版持久化的请求比较结论。
    if ('lastRealReport' in settings()) {
        delete settings().lastRealReport;
        save();
    }

    renderSettings();
    watchRealRequests();

    const c = ctx();

    c.eventSource.on(c.eventTypes.WORLDINFO_ENTRIES_LOADED, data => {
        routeEntries([
            data?.globalLore,
            data?.characterLore,
            data?.chatLore,
            data?.personaLore,
        ]);
    });

    c.eventSource.on(
        c.eventTypes.CHAT_COMPLETION_PROMPT_READY,
        onPromptReady,
    );
});