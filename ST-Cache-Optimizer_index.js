// 缓存优化 (Cache Optimizer) v2
//
// 支持隐式前缀缓存的模型通常会从重复、稳定的前缀中受益；具体缓存条件由模型、API 和服务商决定。
// 本扩展尝试减少提示词每轮的变动，并提供诊断；它不能保证服务商命中缓存。
// 本扩展在不改任何文件的前提下，对任意预设 / 世界书生效：
//   1. 世界书现场调整（WORLDINFO_ENTRIES_LOADED，只改本次扫描的临时副本）：
//      - 「角色定义前/后」的关键词条目、会变的常驻条目（MVU 变量、随机宏、概率触发）→ 聊天中深度 0，
//        外面用 <当前剧情相关设定> 包住；
//      - 按深度 / 作者注释插入、内容固定的常驻条目 → 角色定义前（进入固定的系统提示）。
//   2. 发送前重排（CHAT_COMPLETION_PROMPT_READY）：把聊天记录中间的 system 块和易变块
//      放到当前轮最新用户消息之前，避免它们被挪到提示词末尾之后。
//   3. 自动学习：系统提示里两轮之间变化过的块记下开头特征，以后参与重排。
//   4. 稳定性检查和请求前缀比较只作诊断，不代表服务商实际缓存 token。

const MODULE = 'cacheOptimizer';
const DEFAULTS = Object.freeze({
    enabled: true,
    routeWorldInfo: true,
    hoistStatic: true,
    learn: true,
    stickyLore: false,
    argonStablePrefix: false,
    argonCompactDynamic: false,
    argonMaxHistoryTurns: 0,
    hoistTailStatic: true,
    hoistKeepLast: 2,
    stableHeads: [],
    stableStreaks: {},
    stableChanges: {},
    usageHistory: [],
    stickyTurns: 6,
    volatileHeads: ['〔记忆系统私密简报'],
    learnedHeads: [],
    lastCacheUsage: '',
    lastCacheUsageChatId: '',
    lastCacheUsageSource: '',
    lastCacheUsageModel: '',
    keepPatterns: 'output_format|Force_Structured|^<\\/?Format>|jailbreak|破限',
});
const WRAP_OPEN = '<当前剧情相关设定>';
const WRAP_CLOSE = '</当前剧情相关设定>';
const WRAP_WORLD = '__cache_optimizer__';
const STATIC_OPEN = '<固定设定>';
const STATIC_CLOSE = '</固定设定>';
const STICKY_OPEN = '<近期剧情设定>';
const STICKY_CLOSE = '</近期剧情设定>';
const STICKY_ORDER_BASE = 2000000;
// 比任何聊天记录都深：插在聊天记录最顶端
// 酒馆只注入深度 0~10000（MAX_INJECTION_DEPTH），再大会被静默丢掉
const TOP_DEPTH = 10000;
const POS = { before: 0, after: 1, anTop: 2, anBottom: 3, atDepth: 4, emTop: 5, emBottom: 6, outlet: 7 };
const ROLE_SYSTEM = 0;
const HOIST_ORDER_BASE = 100000;
const MAX_LEARNED = 30;
const MAX_LEARN_CHARS = 20000;
const changeCounts = new Map();
// 常驻条目里出现这些就视为每轮可能变化。读固定配置的 {{getvar::xx}} 不算：它们开局设定后基本不变；
// 真正每轮变的是 MVU 等消息级变量（stat_data / getMessageVar）、随机、时间、最新消息。
const DYNAMIC_EJS = /stat_data|getMessageVar|getvar\(\s*['"`]stat_data|random|Math\.|Date|roll|_\.(sample|shuffle)|lastUserMessage|lastCharMessage|chat\[|incvar|addvar/;
const DYNAMIC_MACRO = /\{\{(roll|random|pick|time|date|weekday|isotime|isodate|datetimeformat|idle_duration|lastMessage|lastUserMessage|lastCharMessage|lastMessageId)/i;
// MVU 变量块是「标签后紧跟模板代码」；正文里只是提到标签名的规则条目不算
const DYNAMIC_TAG = /<status_current_variables>\s*(<%|\{\{)/i;

let lastRun = '尚未发送过请求';
let lastSystemBlocks = null;

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

function normalizeForCompare(value, key = '') {
    if (typeof value === 'string') {
        if ((key === 'url' || key === 'data') && value.startsWith('data:')) {
            return `data:${value.length}:${hashString(value)}`;
        }
        if (value.length > 4096 && /^[A-Za-z0-9+/=\r\n]+$/.test(value)) {
            return `binary:${value.length}:${hashString(value)}`;
        }
        return value;
    }
    if (Array.isArray(value)) return value.map(item => normalizeForCompare(item));
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.keys(value).sort().map(k => [k, normalizeForCompare(value[k], k)]));
    }
    return value;
}

function hashString(value) {
    let hash = 2166136261;
    for (let i = 0; i < value.length; i++) {
        hash ^= value.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16);
}

function text(message) {
    if (typeof message?.content === 'string') return message.content;
    if (message?.content !== undefined) return JSON.stringify(normalizeForCompare(message.content));
    return '';
}

function keepRegex() {
    try {
        return new RegExp(settings().keepPatterns, 'im');
    } catch {
        return new RegExp(DEFAULTS.keepPatterns, 'im');
    }
}

// ───────────────────────── 1. 世界书现场调整 ─────────────────────────

/** 正文本身每轮可能不同（变量、随机、时间、概率触发）；与触发时机无关 */
function isDynamicContent(entry) {
    const content = String(entry.content ?? '');
    const ejs = content.match(/<%[\s\S]*?%>/g) ?? [];
    if (ejs.some(block => DYNAMIC_EJS.test(block))) return true;
    if (DYNAMIC_MACRO.test(content) || DYNAMIC_TAG.test(content)) return true;
    if (argonPrefixActive() && /\{\{\s*format_message_variable\s*::\s*stat_data\b/i.test(content)) return true;
    return !!entry.useProbability && Number(entry.probability ?? 100) < 100;
}

function isDynamicEntry(entry) {
    if (isDynamicContent(entry)) return true;
    // 粘性/冷却/延迟会让条目时有时无
    if (Number(entry.sticky) > 0 || Number(entry.cooldown) > 0 || Number(entry.delay) > 0) return true;
    return false;
}

/** 预设里某个模块（如 worldInfoBefore）是否排在聊天记录之前；找不到时按常见结构（之前）处理 */
function presetSlotBeforeHistory(identifier) {
    const orders = ctx().chatCompletionSettings?.prompt_order ?? [];
    const order = (orders.find(o => o.character_id === 100001) ?? orders[0])?.order ?? [];
    const index = id => order.findIndex(e => e.identifier === id && e.enabled !== false);
    const slot = index(identifier), history = index('chatHistory');
    if (slot < 0 || history < 0) return true;
    return slot < history;
}

/**
 * 聊天记录前的 system 块会不会被并进同一条消息。当前 Gemini / Vertex 转换路径会把非开头的 system 块转成 user 并与相邻消息合并，
 * 提示词后处理（合并 / 半严格 / 严格）也可能合并。由于请求转换和供应商缓存细节不同，不在这类路径启用近期剧情粘性设定，
 * 避免在该设定变化时污染更大的消息前缀；最终效果仍需以服务商实际缓存用量验证。
 */
function systemBlocksGetMerged() {
    const cc = ctx().chatCompletionSettings ?? {};
    if (['makersuite', 'vertexai'].includes(cc.chat_completion_source)) return true;
    return !!cc.custom_prompt_post_processing;
}

function argonPrefixActive() {
    const { source, model } = selectedModel();
    return settings().argonStablePrefix && source === 'vertexai' && model === 'gemini-4-argon';
}

function routeEntries(lists) {
    const s = settings();
    if (!s.enabled || !s.routeWorldInfo) return;
    const keep = keepRegex();
    // 有的预设把世界书位置排在聊天记录之后：那里的内容每轮都排在新消息后面，永远命中不了。
    // 这时固定设定改插到聊天记录最顶端（深度 TOP_DEPTH），不管预设怎么排都在聊天记录之前。
    const argon = argonPrefixActive();
    const beforeSlotOk = presetSlotBeforeHistory('worldInfoBefore');
    const afterSlotOk = presetSlotBeforeHistory('worldInfoAfter');
    let moved = 0, template = null, target = null;
    let topMoved = 0, topTemplate = null, topTarget = null;
    let stickyMoved = 0, stickyTemplate = null, stickyTarget = null;
    const stickyTurns = Math.max(0, Math.floor(Number(s.stickyTurns) || 0));
    const stickyOn = s.stickyLore && !systemBlocksGetMerged();
    const toTop = (e, list, order) => {
        Object.assign(e, { position: POS.atDepth, depth: TOP_DEPTH, role: ROLE_SYSTEM, order });
        topMoved++;
        topTemplate ??= e;
        topTarget ??= list;
    };

    for (const list of lists) {
        if (!Array.isArray(list)) continue;
        for (const e of list) {
            if (!e || e.disable || e.world === WRAP_WORLD) continue;
            // 只看条目名和正文第一行，避免正文里随口提到的词误判
            const firstLine = String(e.content ?? '').trimStart().split('\n', 1)[0];
            if (keep.test(String(e.comment ?? '')) || keep.test(firstLine)) continue;
            const pos = Number(e.position);
            if (argon && [POS.anTop, POS.anBottom, POS.emTop, POS.emBottom].includes(pos)
                && (!e.constant || isDynamicEntry(e))) {
                Object.assign(e, { position: POS.atDepth, depth: 0, role: ROLE_SYSTEM });
                moved++;
                template ??= e;
                target ??= list;
                continue;
            }
            if (pos === POS.before || pos === POS.after) {
                // 关键词条目时有时无、动态常驻条目每轮都变：都不能留在系统提示里
                if (stickyOn && !e.constant && !isDynamicContent(e)) {
                    // 关键词条目放回聊天记录之前（与固定设定同一条消息，排在其后），并粘住几轮：
                    // 场景不变时这块几轮不变，连同后面的聊天记录都能命中缓存
                    Object.assign(e, {
                        position: POS.atDepth, depth: TOP_DEPTH, role: ROLE_SYSTEM,
                        order: STICKY_ORDER_BASE + (pos === POS.after ? 50000 : 0) + (Number(e.order) || 0),
                        sticky: Math.max(Number(e.sticky) || 0, stickyTurns),
                    });
                    stickyMoved++;
                    stickyTemplate ??= e;
                    stickyTarget ??= list;
                } else if (!e.constant || isDynamicEntry(e)) {
                    Object.assign(e, { position: POS.atDepth, depth: 0, role: ROLE_SYSTEM });
                    moved++;
                    template ??= e;
                    target ??= list;
                } else if (pos === POS.before ? !beforeSlotOk : !afterSlotOk) {
                    toTop(e, list, (pos === POS.after ? 50000 : 0) + (Number(e.order) || 0));
                }
            } else if (pos === POS.atDepth && (!e.constant || isDynamicEntry(e))) {
                // 会变的深度条目统一放到深度 0：深度设得比聊天记录还大时它会落进系统提示，
                // 放在中间也会随楼层后移改写前缀；深度 0 之后由发送前重排挪到聊天记录末尾
                if (Number(e.depth) !== 0) {
                    e.depth = 0;
                    moved++;
                }
            } else if ((s.hoistStatic || argon) && e.constant && !isDynamicEntry(e)
                && (pos === POS.atDepth || pos === POS.anTop || pos === POS.anBottom)) {
                // 固定规则前移到聊天记录之前；按原深度从深到浅、再按 order 排，保持原先的相对顺序
                const depth = pos === POS.atDepth ? Number(e.depth) || 0 : 0;
                const order = HOIST_ORDER_BASE + (100 - Math.min(depth, 99)) * 1000 + (Number(e.order) || 0);
                if (beforeSlotOk) Object.assign(e, { position: POS.before, order });
                else toTop(e, list, order);
            }
        }
    }

    const wrap = (from, uid, content, order, depth) => ({
        ...from, uid, world: WRAP_WORLD, comment: content, content, order,
        key: [], keysecondary: [], constant: true, disable: false, selective: false,
        useProbability: false, probability: 100, group: '', groupOverride: false,
        sticky: 0, cooldown: 0, delay: 0, position: POS.atDepth, depth, role: ROLE_SYSTEM,
        excludeRecursion: true, preventRecursion: true,
    });
    if (moved && template && target) {
        target.push(wrap(template, -910001, WRAP_OPEN, -1000000, 0), wrap(template, -910002, WRAP_CLOSE, 1000000, 0));
    }
    if (topMoved && topTemplate && topTarget) {
        topTarget.push(wrap(topTemplate, -910003, STATIC_OPEN, -1000000, TOP_DEPTH), wrap(topTemplate, -910004, STATIC_CLOSE, 1000000, TOP_DEPTH));
    }
    if (stickyMoved && stickyTemplate && stickyTarget) {
        stickyTarget.push(
            wrap(stickyTemplate, -910005, STICKY_OPEN, STICKY_ORDER_BASE - 500000, TOP_DEPTH),
            wrap(stickyTemplate, -910006, STICKY_CLOSE, STICKY_ORDER_BASE + 1000000, TOP_DEPTH),
        );
    }
}

// ───────────────────────── 2. 发送前重排 + 3. 自动学习 ─────────────────────────

function headOf(message) {
    return text(message).trimStart().split('\n', 1)[0].slice(0, 40);
}

/** 插在聊天记录最顶端、要留在前面的块（固定设定 / 近期剧情设定） */
function isTopBlock(message) {
    const t = text(message).trimStart();
    return t.startsWith(STATIC_OPEN) || t.startsWith(STICKY_OPEN);
}

function isVolatileHead(head) {
    const { volatileHeads, learnedHeads } = settings();
    return [...volatileHeads, ...learnedHeads].some(h => h && head.startsWith(h));
}

function normalize(value) {
    return String(value ?? '').replace(/\s+/g, ' ').trim();
}

/** 最近的真实聊天消息各取几段文字，用来在提示词里认出哪些是聊天记录 */
function historySnippets(predicate = () => true) {
    return (ctx().chat ?? [])
        .filter(m => m && !m.is_system && typeof m.mes === 'string' && m.mes.trim() && predicate(m))
        .slice(-60)
        .map(m => {
            const t = normalize(m.mes);
            if (t.length <= 60) return [t];
            // 取中段：开头常是思维链、结尾常是变量块，都可能被正则删掉
            return [0.3, 0.5, 0.7].map(p => t.slice(Math.floor(t.length * p), Math.floor(t.length * p) + 30));
        });
}

/**
 * 找出提示词里真正的聊天记录范围。很多预设在聊天记录前放伪造的 user/assistant 对话、规则和资料，
 * 不能把「第一条非 system 消息」当成聊天记录的开头，所以拿真实聊天消息逐条比对。
 */
function findHistoryRange(chat) {
    const snippets = historySnippets();
    if (!snippets.length) return null;
    let start = -1, end = -1;
    chat.forEach((m, i) => {
        if (m.role === 'system') return;
        const t = normalize(text(m));
        if (t && snippets.some(list => list.some(s => s && t.includes(s)))) {
            if (start < 0) start = i;
            end = i;
        }
    });
    return start < 0 ? null : { start, end };
}

const OMITTED_HISTORY = '[历史对话已由酒馆上下文限制省略]';
const HISTORY_BATCH_TURNS = 8;

function momHistoryRuleActive() {
    const extensions = ctx().extensionSettings;
    if (extensions.disabledExtensions?.includes('regex')) return false;
    return Array.isArray(extensions.regex) && extensions.regex.some(rule => rule
        && /^MoM可选-\[8\]/.test(rule.scriptName ?? '') && !rule.disabled && rule.promptOnly
        && rule.minDepth === 1 && rule.maxDepth == null && rule.replaceString === ''
        && rule.findRegex === '^([\\s\\S]*)$' && rule.placement?.includes(1));
}

function compactArgonHistory(chat, range) {
    const s = settings();
    if (!argonPrefixActive() || !s.argonCompactDynamic || !range) return 0;
    const minTurns = Math.min(100, Math.max(0, Math.floor(Number(s.argonMaxHistoryTurns) || 0)));
    if (!minTurns) return 0;

    const dialogue = [];
    for (let i = range.start; i <= range.end; i++) {
        if (chat[i].role !== 'system') dialogue.push(i);
    }
    // 酒馆角色卡通常从一条 assistant 开场白开始，保留开场白再成对处理。
    if (dialogue.length && chat[dialogue[0]].role === 'assistant') dialogue.shift();
    // MoM may blank historical user messages; the assembler may keep or drop them.
    // Keep a separate assistant-only path and never restore the removed user content.
    if (momHistoryRuleActive()) {
        const replySnippets = historySnippets(m => !m.is_user);
        const replies = [];
        let previousMatch = -1;
        for (const index of dialogue) {
            const m = chat[index];
            if (m.role === 'user' && typeof m.content === 'string' && !m.content.trim()
                && Object.keys(m).every(key => ['role', 'content', 'name', 'identifier'].includes(key))) continue;
            if (m.role !== 'assistant' || typeof m.content !== 'string'
                || !Object.keys(m).every(key => ['role', 'content', 'name', 'identifier'].includes(key))) break;
            const body = normalize(m.content);
            const matches = replySnippets.flatMap((parts, i) => parts.some(part => part && body.includes(part)) ? [i] : []);
            if (!body || matches.length !== 1 || matches[0] <= previousMatch) break;
            previousMatch = matches[0];
            replies.push(index);
        }
        const allReplies = dialogue.filter(index => chat[index].role === 'assistant').length;
        const count = Math.floor(Math.min(replies.length, Math.max(0, allReplies - minTurns)) / HISTORY_BATCH_TURNS) * HISTORY_BATCH_TURNS;
        for (const index of replies.slice(0, count)) chat[index] = { ...chat[index], content: OMITTED_HISTORY };
        return count;
    }
    const batchSize = HISTORY_BATCH_TURNS * 2;
    const eligible = Math.floor(Math.max(0, dialogue.length - minTurns * 2 - 1) / batchSize) * batchSize;
    let omitted = 0;
    for (let offset = 0; offset < eligible; offset += batchSize) {
        const batch = dialogue.slice(offset, offset + batchSize);
        const plainPairs = batch.every((index, position) => {
            const message = chat[index];
            return message.role === (position % 2 === 0 ? 'user' : 'assistant')
                && typeof message.content === 'string'
                && Object.keys(message).every(key => ['role', 'content', 'name', 'identifier'].includes(key));
        });
        if (!plainPairs) break;
        for (const index of batch) chat[index] = { ...chat[index], content: OMITTED_HISTORY };
        omitted += batchSize;
    }
    return omitted;
}

function reorder(chat, stats = {}) {
    const range = findHistoryRange(chat);
    stats.omitted = compactArgonHistory(chat, range);
    const firstTurn = chat.findIndex(m => m.role !== 'system');
    // 认不出聊天记录时退回旧规则：第一条非 system 消息到最后一条用户消息之间
    const start = range ? range.start : firstTurn;
    const historyEnd = range ? range.end : chat.findLastIndex(m => m.role === 'user');
    if (start < 0 || historyEnd < 0) return 0;
    const argon = argonPrefixActive();
    // 包含历史匹配点之后的动态注入，但保留预设尾部及最近用户消息的相对顺序。
    const lastUser = chat.findLastIndex(m => m.role === 'user');
    const end = argon && lastUser > historyEnd && chat.slice(historyEnd + 1, lastUser).every(m => m.role === 'system')
        ? lastUser : historyEnd;
    const anchor = chat[end];

    const moved = [];
    const originalOrder = argon ? new Map(chat.map((message, index) => [message, index])) : null;
    const keep = argon ? keepRegex() : null;
    if (argon) {
        for (let i = chat.length - 1; i > end; i--) {
            const m = chat[i];
            const body = typeof m.content === 'string' ? m.content.trimStart() : '';
            if (m.role === 'system' && body.startsWith(WRAP_OPEN) && body.trimEnd().endsWith(WRAP_CLOSE)) {
                moved.unshift(...chat.splice(i, 1));
            }
        }
    }
    // 聊天记录中间插入的 system 块：每多一轮位置就后移，会改写上一轮的前缀
    for (let i = end - 1; i > start; i--) {
        // 插在聊天记录最顶端的固定设定块就是要留在前面的
        if (chat[i].role === 'system' && !isTopBlock(chat[i])
            && (!argon || (typeof chat[i].content === 'string' && !keep.test(text(chat[i]))))) {
            moved.unshift(...chat.splice(i, 1));
        }
    }
    // 聊天记录之前的易变块（柏宝书历史摘要、学到的易变块、现场调整出来的动态世界书块）
    for (let i = start - 1; i >= 0; i--) {
        const t = text(chat[i]).trimStart();
        const standaloneMvu = argon && typeof chat[i].content === 'string'
            && /^<status_current_variables>\s*[\s\S]*?<\/status_current_variables>\s*$/i.test(t)
            && (t.match(/<\/?status_current_variables>/gi) ?? []).length === 2
            && !keep.test(t);
        if (chat[i].role === 'system' && !isTopBlock(chat[i])
            && (standaloneMvu || (isVolatileHead(headOf(chat[i])) && t.length <= MAX_LEARN_CHARS) || t.startsWith(WRAP_OPEN))) moved.unshift(...chat.splice(i, 1));
    }
    if (!moved.length) return 0;

    const at = chat.indexOf(anchor);
    if (originalOrder) moved.sort((a, b) => originalOrder.get(a) - originalOrder.get(b));
    chat.splice(at, 0, ...moved);
    return moved.length;
}

/** 聊天记录之前的固定区域里，同一开头的块内容变了 → 记为易变，下一轮起挪到聊天记录之后 */
function learnFrom(chat) {
    const s = settings();
    if (!s.learn) return [];
    const range = findHistoryRange(chat);
    const firstTurn = chat.findIndex(m => m.role !== 'system');
    const stop = range ? range.start : (firstTurn < 0 ? chat.length : firstTurn);
    // 顶端设定块随场景变化是预期内的，不能学成易变块挪走
    const blocks = chat.slice(0, stop).filter(m => m.role === 'system' && !isTopBlock(m)).map(m => ({ head: headOf(m), body: text(m) }));
    const learned = [];
    if (lastSystemBlocks && lastSystemBlocks.chatId === ctx().getCurrentChatId()) {
        const prev = new Map(lastSystemBlocks.blocks.map(b => [b.head, b.body]));
        for (const b of blocks) {
            if (b.head.length < 4 || !prev.has(b.head) || prev.get(b.head) === b.body || isVolatileHead(b.head)) continue;
            // 大块（整本世界书之类）挪到聊天记录之后，每轮整块按原价算，比偶尔变一次贵得多
            if (b.body.length > MAX_LEARN_CHARS) continue;
            // 偶发一次变化（改设置、换预设、脚本改了一次变量）不算，第二次变才学
            const seen = (changeCounts.get(b.head) ?? 0) + 1;
            changeCounts.set(b.head, seen);
            if (seen < 2) continue;
            s.learnedHeads.push(b.head);
            learned.push(b.head);
        }
        if (learned.length) {
            s.learnedHeads = s.learnedHeads.slice(-MAX_LEARNED);
            save();
        }
    }
    lastSystemBlocks = { chatId: ctx().getCurrentChatId(), blocks };
    return learned;
}

function onPromptReady(data) {
    if (!settings().enabled || !Array.isArray(data?.chat)) return;
    const stats = {};
    const n = reorder(data.chat, stats);
    if (data.dryRun) return;
    const learned = learnFrom(data.chat);
    lastRun = `${new Date().toLocaleTimeString()} 发送前重排：移动了 ${n} 个块`
        + (learned.length ? `；新学到易变块 ${learned.length} 个（下一轮生效）` : '')
        + (argonPrefixActive() && settings().argonCompactDynamic ? `；成批瘦身省略 ${stats.omitted} 条旧消息` : '');
    $('#cacheopt_last').text(lastRun);
    renderLearned();
}

// ───────────────────────── 4. 免费稳定性检查 ─────────────────────────

async function captureDryRun() {
    const c = ctx();
    let captured = null;
    const handler = data => { captured = structuredClone(data.chat); };
    c.eventSource.on(c.eventTypes.CHAT_COMPLETION_PROMPT_READY, handler);
    try {
        await c.generate('normal', {}, true);
    } finally {
        c.eventSource.removeListener(c.eventTypes.CHAT_COMPLETION_PROMPT_READY, handler);
    }
    return captured;
}

async function checkStability() {
    const c = ctx();
    const report = $('#cacheopt_report');
    if (c.mainApi !== 'openai') return report.text('只支持对话补全（Chat Completion）接口。');
    const lastUser = c.chat.findLastIndex(m => m.is_user);
    if (lastUser < 2) return report.text('聊天记录太短，至少需要两轮对话。');
    report.text('检查中（只组装、不发送，不花钱）…');

    const original = c.chat.length;
    let previous;
    const removed = c.chat.splice(lastUser - 1);
    try {
        previous = await captureDryRun();
    } finally {
        c.chat.push(...removed);
    }
    const current = await captureDryRun();
    if (c.chat.length !== original || !previous || !current) return report.text('检查失败：没能组装出提示词。');

    const flat = list => list.map(m => `[${m.role}]${text(m)}`).join('\n');
    const lead = list => { let k = 0; while (k < list.length && list[k].role === 'system') k++; return k; };
    const a = flat(previous), b = flat(current);
    let i = 0;
    while (i < a.length && a[i] === b[i]) i++;
    let at = 0, acc = 0;
    for (; at < current.length; at++) {
        acc += flat([current[at]]).length + 1;
        if (acc > i) break;
    }
    const sysPrev = previous.slice(0, lead(previous)), sysCur = current.slice(0, lead(current));
    const systemSame = flat(sysPrev) === flat(sysCur);
    const changed = systemSame ? [] : sysCur.filter((m, k) => text(m) !== text(sysPrev[k])).map(headOf);
    report.text([
        `系统提示两轮一致：${systemSame ? '是' : '否'}（仅提示词稳定性诊断，不等于服务商缓存命中判定）`,
        changed.length ? `系统提示里变化的块：${changed.slice(0, 5).join(' / ')}` : '',
        `两轮相同的文本前缀：${(i / b.length * 100).toFixed(1)}%（约 ${i.toLocaleString()} / ${b.length.toLocaleString()} 字符；不等于 token 命中率）`,
        `第一次不同出现在第 ${at + 1} 条消息（${current[at]?.role}）：`,
        text(current[at]).slice(0, 80).replace(/\s+/g, ' '),
        '缓存门槛与策略因模型及 API 路由而异；字符数不是 token 数，文本前缀也不能证明服务商命中。请以该路由实际返回的缓存用量为准。模拟也不包含每轮真实发生的扩展注入变化。',
        settings().enabled ? '' : '（当前未启用，开启后再检查一次可对比效果）',
    ].filter(Boolean).join('\n'));
}

// ───────────────────────── 5. 真实发送对比 ─────────────────────────
// 模拟检查看不到只在真实生成时才出现的变化（EJS 渲染、扩展在生成时注入、变量被脚本改写等）。
// 这里在网络层旁观每次真实发出的请求（不修改、不额外请求），和同一聊天的上一次对比。

const GENERATE_PATH = '/api/backends/chat-completions/generate';
const RECENT_LIMIT = 8;
// 同一聊天最近几次真实请求；比较时只配对同一 API 来源和模型，避免跨路由误比。
let recentReal = [];
let usageRequestSequence = 0;
const latestUsageRequest = new Map();
const usageSession = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;

function optimizationMode() {
    if (!settings().enabled) return '关闭重排';
    if (!argonPrefixActive()) return '普通重排';
    if (!settings().argonCompactDynamic || !(Number(settings().argonMaxHistoryTurns) > 0)) return 'Argon 前缀优化';
    return momHistoryRuleActive() ? 'Argon 前缀优化 + MoM 兼容瘦身' : 'Argon 前缀优化 + 成批瘦身';
}

function requestFingerprint(body, requestSource = ctx().chatCompletionSettings?.chat_completion_source ?? 'unknown') {
    const comparable = {
        model: body.model,
        source: requestSource,
        messages: body.messages,
        tools: body.tools,
        tool_choice: body.tool_choice,
        response_format: body.response_format,
        json_schema: body.json_schema,
        reasoning: body.reasoning,
        reasoning_effort: body.reasoning_effort,
        temperature: body.temperature,
        top_p: body.top_p,
        top_k: body.top_k,
    };
    return JSON.stringify(normalizeForCompare(comparable));
}

function readCachedTokens(data) {
    const candidates = [
        data?.usage?.prompt_tokens_details?.cached_tokens,
        data?.usage?.input_tokens_details?.cached_tokens,
        data?.usage?.cached_tokens,
        data?.usage?.cached_content_token_count,
        data?.usageMetadata?.cachedContentTokenCount,
        data?.usageMetadata?.cached_content_token_count,
        data?.responseContent?.usageMetadata?.cachedContentTokenCount,
        data?.responseContent?.usageMetadata?.cached_content_token_count,
        data?.response?.usage?.total_cached_tokens,
        data?.usage?.total_cached_tokens,
        data?.usage?.cachedContentTokenCount,
    ];
    const value = candidates.find(v => (typeof v === 'number' || (typeof v === 'string' && /^\d+$/.test(v)))
        && Number.isSafeInteger(Number(v)) && Number(v) >= 0);
    return value === undefined ? null : Number(value);
}

function messageSignatures(body) {
    return (Array.isArray(body.messages) ? body.messages : []).map(message => {
        const content = text(message);
        return {
            role: message?.role ?? 'unknown',
            length: content.length,
            hash: hashString(content),
            chunks: Array.from({ length: Math.ceil(content.length / 256) }, (_, index) => hashString(content.slice(index * 256, (index + 1) * 256))),
        };
    });
}

function sharedPrefix(a, b) {
    let k = 0;
    while (k < a.length && k < b.length && a[k].hash === b[k].hash && a[k].role === b[k].role && a[k].length === b[k].length) k++;
    const chars = a.slice(0, k).reduce((s, message) => s + message.length + 1, 0);
    return { k, chars };
}

function describeReal(prev, cur, gapSec) {
    const a = prev.messages, b = cur.messages;
    const { k, chars } = sharedPrefix(a, b);
    const total = b.reduce((s, message) => s + message.length + 1, 0) || 1;
    const sameMessages = JSON.stringify(a) === JSON.stringify(b);
    const sameRequest = prev.fingerprint === cur.fingerprint;
    const paramsChanged = prev.fingerprint !== cur.fingerprint && sameMessages;
    const firstDiff = k < b.length
        ? `第一处消息差异：第 ${k + 1} 条（${b[k]?.role ?? '未知'}）`
        : (sameMessages ? '' : '两次消息列表长度不同（较短的那次是较长消息列表的前缀）');
    return [
        `${new Date().toLocaleTimeString()}｜${cur.source} / ${cur.model || '模型名未知'}；与 ${gapSec} 秒前同聊天、同路由和模型的上一条请求比较`,
        `完全相同消息前缀占请求文本：${(chars / total * 100).toFixed(1)}%（${chars.toLocaleString()} / ${total.toLocaleString()} 字符；只计完全一致的整条消息，不是 token 或服务商命中率）`,
        sameRequest ? '请求参数和消息完全相同（是否缓存命中仍需看下方服务商用量）' : firstDiff,
        paramsChanged ? '消息相同但模型、工具或生成参数变化；请检查模型/工具定义是否稳定。' : '',
        prev.toolNames !== cur.toolNames ? '工具名列表发生变化。' : '',
        '缓存有效期依模型和供应商而异；本比较不推测有效时长。',
        '本扩展只比较请求；只有服务商返回 cached token 用量时，下面才会显示真实命中。',
    ].filter(Boolean).join('\n');
}

function recordRealRequest(rawBody, requestChatId = ctx().getCurrentChatId?.() ?? '', requestSource = ctx().chatCompletionSettings?.chat_completion_source ?? 'unknown') {
    let body;
    try { body = JSON.parse(rawBody); } catch { return; }
    if (!body || !Array.isArray(body.messages) || body.type === 'quiet') return;
    const chatId = requestChatId;
    const now = Date.now();
    const cur = {
        chatId,
        at: now,
        model: String(body.model ?? ''),
        source: requestSource,
        messages: messageSignatures(body),
        toolNames: JSON.stringify((body.tools ?? []).map(t => t?.function?.name ?? t?.name ?? '')),
        fingerprint: hashString(requestFingerprint(body, requestSource)),
    };
    const prev = recentReal.findLast(r => r.chatId === chatId && r.source === requestSource && r.model === cur.model);
    const omitted = body.messages.filter(m => m.content === OMITTED_HISTORY).length;
    const diagnostic = { omitted, prefix: null };
    if (prev) {
        const gap = Math.round((now - prev.at) / 1000);
        const report = describeReal(prev, cur, gap);
        const { k, chars } = sharedPrefix(prev.messages, cur.messages);
        const before = prev.messages[k];
        const after = cur.messages[k];
        let blocks = 0;
        if (before && after && before.role === after.role) {
            while (blocks < Math.min(before.chunks.length, after.chunks.length)
                && before.chunks[blocks] === after.chunks[blocks]) blocks++;
        }
        diagnostic.prefix = {
            gapSeconds: gap,
            equalMessages: k,
            equalMessageChars: chars - k,
            firstChangeMessage: before || after ? k + 1 : null,
            firstChangeRole: after?.role ?? before?.role ?? null,
            equalCharsInChangedMessage: Math.min(blocks * 256, before?.length ?? 0, after?.length ?? 0),
        };
        if ((ctx().getCurrentChatId?.() ?? '') === chatId) $('#cacheopt_real').text(report);
    }
    recentReal = [...recentReal.filter(r => r.chatId === chatId), cur].slice(-RECENT_LIMIT);
    return diagnostic;
}

function showUsageUnavailable(chatId, source, model, requestId) {
    const current = selectedModel();
    if ((ctx().getCurrentChatId?.() ?? '') !== chatId || latestUsageRequest.get(chatId)?.id !== requestId
        || current.source !== source || current.model !== model) return;
    if (settings().lastCacheUsageChatId === chatId && settings().lastCacheUsageSource === source && settings().lastCacheUsageModel === model) {
        settings().lastCacheUsage = '';
        settings().lastCacheUsageChatId = '';
        settings().lastCacheUsageSource = '';
        settings().lastCacheUsageModel = '';
        save();
    }
    const report = source === 'openrouter'
        ? `本次请求（${model || '模型名未知'}）失败或酒馆响应未包含缓存用量，不能据此判定为 0。请在 OpenRouter Activity 查看该请求的 cached_tokens / cache_discount。`
        : ['makersuite', 'vertexai'].includes(source)
            ? `本次请求（${model || '模型名未知'}）失败或酒馆响应未包含缓存用量，不能据此判定为 0。Google 直连的部分酒馆后端会丢弃响应中的 usageMetadata；可查看酒馆服务端调试日志。`
            : `本次请求（${model || '模型名未知'}）失败或响应未包含可读取的缓存用量，不能据此判定为 0。`;
    $('#cacheopt_usage').text(report);
}

function recordCacheUsage(data, requestChatId, source, model, requestId) {
    const cached = readCachedTokens(data);
    const current = selectedModel();
    if (cached === null || latestUsageRequest.get(requestChatId)?.id !== requestId
        || current.source !== source || current.model !== model) return false;
    const usage = data?.usage ?? {};
    const metadata = data?.usageMetadata ?? data?.responseContent?.usageMetadata ?? {};
    const googleNative = source === 'vertexai' || source === 'makersuite';
    const inputCount = googleNative ? metadata.promptTokenCount : (usage.prompt_tokens ?? usage.input_tokens ?? metadata.promptTokenCount);
    const inputField = googleNative || (usage.prompt_tokens == null && usage.input_tokens == null)
        ? 'promptTokenCount' : (usage.prompt_tokens != null ? 'prompt_tokens' : 'input_tokens');
    const inputNumber = Number(inputCount);
    const input = Number.isSafeInteger(inputNumber) && inputNumber > 0 && inputNumber >= cached ? inputNumber : null;
    const ratio = input === null ? '（未取得可核实的输入 token，无法计算比例）'
        : ` / ${input.toLocaleString()} 输入 tokens（${(cached / input * 100).toFixed(1)}%）`;
    const s = settings();
    const history = s.usageHistory.filter(row => row.id !== requestId || row.session !== usageSession);
    const previous = s.usageHistory.find(row => row.id === requestId && row.session === usageSession);
    if (input === null && previous?.input != null) return true;
    history.push({ id: requestId, session: usageSession, chatId: requestChatId, source, model,
        at: Date.now(), mode: latestUsageRequest.get(requestChatId).mode, cached, input, inputField: input === null ? null : inputField,
        diagnostic: latestUsageRequest.get(requestChatId).diagnostic ?? null });
    s.usageHistory = history.slice(-24);
    const report = `酒馆响应中的缓存用量：${cached.toLocaleString()} cached tokens${ratio}（${source} / ${model || '模型名未知'}；${new Date().toLocaleTimeString()}）。${cached === 0 ? '本次字段明确返回 0；这不代表其他请求也为 0。' : ''}`;
    settings().lastCacheUsage = report;
    settings().lastCacheUsageChatId = requestChatId;
    settings().lastCacheUsageSource = source;
    settings().lastCacheUsageModel = model;
    save();
    if ((ctx().getCurrentChatId?.() ?? '') === requestChatId) renderCacheUsage();
    return true;
}

function observeSseUsage(response, requestChatId, source, model, requestId) {
    if (!response.body?.getReader) return;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = '';
    let sawUsage = false;
    const consumeLine = line => {
        if (!line.startsWith('data:')) return;
        const raw = line.slice(5).trim();
        if (!raw || raw === '[DONE]' || raw.length > 1024 * 1024) return;
        try { sawUsage = recordCacheUsage(JSON.parse(raw), requestChatId, source, model, requestId) || sawUsage; } catch { /* 忽略非 JSON SSE 事件 */ }
    };
    (async () => {
        try {
            while (true) {
                const { value, done } = await reader.read();
                pending += decoder.decode(value, { stream: !done });
                const lines = pending.split(/\r?\n/);
                pending = lines.pop() ?? '';
                lines.forEach(consumeLine);
                if (done) {
                    consumeLine(pending);
                    if (!sawUsage) showUsageUnavailable(requestChatId, source, model, requestId);
                    break;
                }
                if (pending.length > 1024 * 1024) pending = '';
            }
        } catch { /* 监听失败不能影响原始请求 */ }
    })();
}

function observeResponseUsage(response, requestChatId, source, model, requestId, requestedStream = false) {
    const contentType = (response.headers?.get('content-type') ?? '').toLowerCase();
    // SillyTavern's Google handler may pipe SSE bytes without copying the upstream Content-Type.
    const googleStream = (source === 'vertexai' || source === 'makersuite') && requestedStream === true;
    try {
        if (contentType.includes('text/event-stream') || (googleStream && !contentType.includes('json'))) {
            observeSseUsage(response.clone(), requestChatId, source, model, requestId);
        } else if (contentType.includes('application/json')) {
            response.clone().json()
                .then(data => { if (!recordCacheUsage(data, requestChatId, source, model, requestId)) showUsageUnavailable(requestChatId, source, model, requestId); })
                .catch(() => showUsageUnavailable(requestChatId, source, model, requestId));
        } else {
            showUsageUnavailable(requestChatId, source, model, requestId);
        }
    } catch { /* 不影响原始响应 */ }
}


/* __STABLE_PREFIX_V4__
 * 目的：让请求前缀尽可能长且逐字节稳定，把每轮都会变的内容全部压到请求最尾部。
 *
 * 依据（实测 + 官方行为）：
 *   · Gemini 隐式缓存只认"上一条请求的前缀"；
 *   · 上一条请求里"最后一段内容"永远不在缓存里（这一段相对它的上一版是新的）；
 *   · 所以"最新用户消息之后的任何块"= 100% 白付钱。
 *
 * 做法：
 *   1. front：已被证明稳定的块 → 全部提到最前面（进 systemInstruction）；
 *   2. tail ：易变块（微信、动态剧情设定、时间注入…）→ 压到最新用户消息之后；
 *   3. keep ：破限 / 输出格式 / 最后指令类块 → 永远留在请求最末尾，保证强度；
 *   4. 一次都没见过的块 → 原地不动，先观察一轮再决定，避免误判整锅端；
 *   5. 只改顺序，不改任何文字；任何异常都不影响原请求。
 */
const TAIL_VOLATILE_HEADS = ["<\u5f53\u524d\u5267\u60c5\u76f8\u5173\u8bbe\u5b9a>", "\u3010\u624b\u673a\u5fae\u4fe1\u5df2\u6709\u6d88\u606f\u3011", "\u3010\u5fae\u4fe1\u7ebf\u4e0b\u6a21\u5f0f\u3011"];

/** 冷启动种子：这些头的块在各家预设里都是固定设定，直接按"稳定"处理 */
const SP_SEED_HEADS = [
    '<WorldFrame>', '\u57fa\u672c\u4fe1\u606f', '<info>', '<Beagle_personality>', '\u53d8\u91cf\u8f93\u51fa\u683c\u5f0f',
    '</WorldFrame_components>', '[Start a new Chat]', '</WorldFrame_timeline>', '<memory_and_flow>',
    '<world_reading>', '<character_existence>', '<no_fabrication>', '<narrative_drive>', '<romance_and_tension>',
    '<narrative_craft>', '<language_guard>', '<LANGUAGE_OVERRIDE', '<writing_style>', '<living_prose>',
    '<word_count>', '<paragraph_format>', '<spectate_slow>', '<perspective>', '<creative_baseline',
    '<common_knowledge>', '<prune>', '<Time>', '</WorldFrame_presence>', '## Phase', '</WorldFrame>',
    '<user_persona>', '<character>', '<scenario>', '<persona>', '<world_info>', '<lore>',
    // 长篇常驻世界书的典型块：这些块内部不含任何每轮求值的变量，相邻两轮逐字节一致，
    // 属于最该前移、也最值得前移的一类（单块 800~3300 字，20 块合计 3 万字）。
    '# 此时期人设需结合', '# 读取上轮回复中状态栏', '# 你必须在每轮回复的正文末尾',
    '# 全局数据表', '# 以下设定仅在NSFW情节中适用', '# 为保证剧情真实', '# AI在正文输出前',
    '<大学时期npc>', '<成年时期npc>', '<高中时期npc>', '<少年时期npc>', '| AM',
];

// 块身份取前多少字。原来取 24 字，长篇世界书里大量块共用同一开头
// （实测 20 块中只有 15 个不同身份），同前缀块会互相覆盖连续计数，
// 被误判成"每轮都在变"而永久禁足。97 字起才能完全区分，留余量取 120。
const SP_HEAD_LEN = 120;

let spSeen = new Map();          // chatId -> Map(head -> 本轮 hash)

function msgText(m) {
    if (!m) return "";
    const c = m.content;
    if (typeof c === "string") return c;
    if (Array.isArray(c)) return c.map(x => (typeof x === "string" ? x : x?.text || "")).join("");
    return "";
}

function spHead(m) {
    return msgText(m).trimStart().slice(0, SP_HEAD_LEN);
}

/** 种子表恒生效：种子代表"这类块本来就是固定的"，不该因为设置里存过别的列表就失效 */
function spStableHead(s, head) {
    const own = Array.isArray(s.stableHeads) ? s.stableHeads : [];
    const list = own.length ? [...SP_SEED_HEADS, ...own] : SP_SEED_HEADS;
    if (list.includes(head)) return true;
    for (const h of list) {
        if (h && h.length >= 4 && head.startsWith(h)) return true;
    }
    return false;
}

/** 读"连续一致次数"：支持种子表里的短前缀写法 */
function spStreakOf(s, head) {
    const map = (s.stableStreaks && typeof s.stableStreaks === 'object') ? s.stableStreaks : {};
    let best = Number(map[head] ?? 0) || 0;
    for (const [k, v] of Object.entries(map)) {
        if (k && k.length >= 4 && head.startsWith(k)) best = Math.max(best, Number(v) || 0);
    }
    return best;
}

function spVolatileHead(head) {
    const s = settings();
    const heads = [...TAIL_VOLATILE_HEADS, ...(s.volatileHeads ?? []), ...(s.learnedHeads ?? [])].filter(Boolean);
    return heads.some(h => head.startsWith(String(h).slice(0, 24)));
}

/** 每轮记录"哪些块这轮变了"，让稳定性判断自己长出来，不靠写死；结果持久化，刷新页面不用重新学 */
function spLearn(chatId, messages) {
    const s = settings();
    if (!Array.isArray(s.stableHeads) || !s.stableHeads.length) s.stableHeads = SP_SEED_HEADS.slice();
    if (!s.stableStreaks || typeof s.stableStreaks !== 'object') s.stableStreaks = {};
    let dirty = false;
    if (s.spPlanVersion !== 5) {
        // 5：块身份由 24 字改为 120 字。旧记录都是按 24 字建的，同前缀块互相覆盖计数，
        // 其中被误判成「永久易变」的黑名单必须清掉，否则身份修对了它们还是被禁足。
        // 同时清掉旧稳定列表，从种子重新起步（种子已覆盖常见预设块与长篇常驻块）。
        s.spPlanVersion = 5;
        s.stableStreaks = {};
        s.stableChanges = {};
        s.learnedHeads = [];
        s.stableHeads = [];
        // 沿用第 4 版那条结论：<当前剧情相关设定> 实测相邻两轮逐字节一致，直接按已稳定起步，
        // 省掉一次布阵切换造成的整轮跳空；它若真的每轮都变，两次变化后会自动退回尾部。
        s.stableStreaks[WRAP_OPEN] = 2;
        dirty = true;
    }
    const prev = spSeen.get(chatId);
    const hashes = new Map();
    for (const m of messages) {
        if (m?.role !== 'system') continue;
        const head = spHead(m);
        if (!head) continue;
        const hash = hashString(msgText(m));
        const was = prev?.get(head);
        // 上一次会话里学到的连续一致次数也要接着算，否则每次刷新都要从头来三轮回合
        const base = spStreakOf(s, head);
        const streak = was === undefined ? base : (was === hash ? base + 1 : 0);
        if (streak !== base) { s.stableStreaks[head] = Math.min(streak, 99); dirty = true; }
        // 变一次只是"暂时不前置"；变两次就判定为真易变，永久不再前置，
        // 避免"前置→变→回尾→再前置→再变"的来回抖动，每次抖动都要白付一整轮。
        if (was !== undefined && was !== hash) {
            const n = (Number(s.stableChanges?.[head] ?? 0) || 0) + 1;
            if (!s.stableChanges || typeof s.stableChanges !== 'object') s.stableChanges = {};
            s.stableChanges[head] = n;
            delete s.stableStreaks[head];
            dirty = true;
            if (n >= 2 && !(s.learnedHeads ?? []).includes(head)) {
                s.learnedHeads = [...(s.learnedHeads ?? []), head].slice(-60);
                dirty = true;
            }
        }
        if (streak >= 1 && !spStableHead(s, head) && !spVolatileHead(head)) {
            s.stableHeads = [...s.stableHeads, head].slice(-200);
            dirty = true;
        }
        if (streak === 0 && was !== undefined && !spVolatileHead(head)) {
            if (s.stableHeads.includes(head)) { s.stableHeads = s.stableHeads.filter(h => h !== head); dirty = true; }
        }
        hashes.set(head, hash);
    }
    spSeen.set(chatId, hashes);
    if (dirty) {
        const keys = Object.keys(s.stableStreaks);
        if (keys.length > 120) {
            keys.sort((a, b) => (s.stableStreaks[b] ?? 0) - (s.stableStreaks[a] ?? 0));
            const kept = {};
            keys.slice(0, 120).forEach(k => { kept[k] = s.stableStreaks[k]; });
            s.stableStreaks = kept;
        }
        save();
    }
}

/**
 * 重建请求顺序：front(稳定) → 对话原序 → tail(易变) → keep(最后指令)
 * @returns {{moved:number, hoistedChars:number, predicted:number}}
 */
function stablePrefixPlan(messages) {
    const none = { moved: 0, hoistedChars: 0, predicted: 0 };
    if (settings().hoistTailStatic === false) return none;
    if (!Array.isArray(messages) || messages.length < 6) return none;

    const chatId = ctx().getCurrentChatId?.() ?? '';
    const s = settings();
    if (!Array.isArray(s.stableHeads) || !s.stableHeads.length) s.stableHeads = SP_SEED_HEADS.slice();
    if (!s.stableStreaks || typeof s.stableStreaks !== 'object') s.stableStreaks = {};
    spLearn(chatId, messages);   // 先按这一轮的表现更新判断，再用最新判断重排

    let lastUser = -1;
    for (let i = messages.length - 1; i >= 0; i--) { if (messages[i]?.role === 'user') { lastUser = i; break; } }
    if (lastUser < 0) return none;

    // 末尾 N 个 system 块 = 最后指令，永远留在最尾部
    const keepLast = Math.max(0, Math.min(12, Math.floor(Number(s.hoistKeepLast ?? 2)) || 0));
    const protectedSet = new Set();
    if (keepLast > 0) {
        const sysIdx = messages.map((m, i) => (m?.role === 'system' ? i : -1)).filter(i => i >= 0);
        sysIdx.slice(Math.max(0, sysIdx.length - keepLast)).forEach(i => protectedSet.add(i));
    }
    let keepRe = null;
    try { if (s.keepPatterns) keepRe = new RegExp(String(s.keepPatterns), 'i'); } catch { keepRe = null; }

    const front = [];
    const stay = [];     // 对话消息 + 原地不动的 system 块（保持原相对顺序）
    const tail = [];
    const keep = [];
    const streakOf = (head) => spStreakOf(s, head);

    messages.forEach((m, i) => {
        if (m?.role !== 'system') { stay.push([i, m]); return; }
        if (protectedSet.has(i) || (keepRe && keepRe.test(msgText(m).slice(0, 4000)))) { keep.push([i, m]); return; }
        const head = spHead(m);
        const volatileHead = spVolatileHead(head);
        const banned = (s.learnedHeads ?? []).includes(head);
        const proven = !banned && (spStableHead(s, head) || streakOf(head) >= 2);
        if (volatileHead && !proven) { tail.push([i, m]); return; }
        if (proven) { front.push([i, m, volatileHead ? 1 : 0]); return; }
        stay.push([i, m]);       // 没见过、也没证据 → 原地不动
    });

    // 曾易变、后来稳定的块排在 front 最末：真变了也只损失它自己后面的部分
    front.sort((a, b) => (Number(!!a[2]) - Number(!!b[2])) || (a[0] - b[0]));
    if (front.length < 2) return none;
    const hoistedChars = front.reduce((n, [, m]) => n + msgText(m).length, 0);
    if (hoistedChars < 800) return none;

    // 各块内部已按原顺序收集，直接拼接即得到目标顺序
    const rebuilt = [...front.map(x => x[1]), ...stay.map(x => x[1]), ...tail.map(x => x[1]), ...keep.map(x => x[1])];
    if (rebuilt.length !== messages.length) return none;

    const totalChars = rebuilt.reduce((n, m) => n + msgText(m).length, 0) || 1;
    let lastUserNew = -1;
    for (let i = rebuilt.length - 1; i >= 0; i--) { if (rebuilt[i]?.role === 'user') { lastUserNew = i; break; } }
    let cachedChars = 0;
    for (let i = 0; i <= lastUserNew; i++) cachedChars += msgText(rebuilt[i]).length;

    const moved = messages.reduce((n, m, i) => (rebuilt[i] !== m ? n + 1 : n), 0);
    messages.splice(0, messages.length, ...rebuilt);
    return { moved, hoistedChars, predicted: cachedChars / totalChars };
}

/** 把这一轮重排后的"可缓存占比"写进设置，便于离线核对，不参与发送 */
function recordLayout(plan) {
    try {
        const s = settings();
        const pct = Math.round(plan.predicted * 1000) / 10;
        s.lastLayoutPct = pct;
        s.lastLayout = `${new Date().toLocaleTimeString()}｜前移 ${plan.moved} 块（${plan.hoistedChars} 字）｜本轮可缓存前缀 ${pct}%`;
        save();
        $('#cacheopt_last').text(s.lastLayout);
    } catch { /* 记录失败不影响请求 */ }
}
function watchRealRequests() {
    const original = window.fetch;
    if (original.__cacheoptWatch) return;
    const wrapped = function (input, init) {
        let url = '';
        let rawBody = '';
        let requestChatId = '';
        let source = 'unknown';
        let model = '';
        let requestId = 0;
        let requestedStream = false;
        try {
            url = typeof input === 'string' ? input : input?.url ?? '';
            if (url.includes(GENERATE_PATH) && typeof init?.body === 'string') {
                rawBody = init.body;
                try {
                    const body = JSON.parse(rawBody);
                    requestedStream = body?.stream === true;
                    if (body?.type === 'quiet') {
                        rawBody = '';
                    } else {
                        const plan = stablePrefixPlan(body.messages);
                        if (plan.moved > 0) {
                            rawBody = JSON.stringify(body);
                            try { init.body = rawBody; } catch { /* init 不可写则放弃改写 */ }
                            recordLayout(plan);
                        }
                    }
                } catch { /* body 解析失败则仍旁观响应 */ }
                if (rawBody) {
                    requestChatId = ctx().getCurrentChatId?.() ?? '';
                    ({ source, model } = selectedModel());
                    requestId = ++usageRequestSequence;
                    latestUsageRequest.set(requestChatId, { id: requestId, mode: optimizationMode() });
                    latestUsageRequest.get(requestChatId).diagnostic = recordRealRequest(rawBody, requestChatId, source);
                }
            }
        } catch { /* 只旁观，出错不影响请求 */ }
        const result = original.apply(this, arguments);
        if (!rawBody) return result;
        return result.then(response => {
            try {
                if (response.ok) {
                    observeResponseUsage(response, requestChatId, source, model, requestId, requestedStream);
                } else {
                    showUsageUnavailable(requestChatId, source, model, requestId);
                }
            } catch { /* 旁观失败不能影响原始响应 */ }
            return response;
        }, error => {
            try { showUsageUnavailable(requestChatId, source, model, requestId); } catch { /* 旁观失败不能影响原始错误 */ }
            throw error;
        });
    };
    wrapped.__cacheoptWatch = true;
    window.fetch = wrapped;
}

// ───────────────────────── 界面 ─────────────────────────

function selectedModel() {
    const chatSettings = ctx().chatCompletionSettings ?? {};
    const source = chatSettings.chat_completion_source ?? 'unknown';
    const key = source === 'makersuite' ? 'google_model'
        : source === 'vertexai' ? 'vertexai_model'
            : `${source}_model`;
    return { source, model: String(chatSettings[key] ?? '') };
}

function renderCacheUsage() {
    const s = settings();
    const chatId = ctx().getCurrentChatId?.() ?? '';
    const { source, model } = selectedModel();
    const report = s.lastCacheUsage && s.lastCacheUsageChatId === chatId
        && s.lastCacheUsageSource === source && s.lastCacheUsageModel === model
        ? s.lastCacheUsage
        : '当前聊天/模型/路由尚未读到供应商缓存用量；请勿把“未读到”理解为命中为 0。';
    $('#cacheopt_usage').text(report);
    renderUsageHistory();
}

function renderUsageHistory() {
    const { source, model } = selectedModel();
    const chatId = ctx().getCurrentChatId?.() ?? '';
    const rows = settings().usageHistory.filter(row => row.chatId === chatId && row.source === source && row.model === model);
    $('#cacheopt_usage_history').text(rows.slice(-12).reverse().map(row => {
        const time = new Date(row.at).toLocaleTimeString();
        const cached = row.cached.toLocaleString();
        const ratio = row.input === null ? '无输入 token 读数' : `${row.input.toLocaleString()} 输入 · ${(100 * row.cached / row.input).toFixed(1)}% · ${row.inputField}`;
        const diagnostic = row.diagnostic;
        const prefix = diagnostic?.prefix;
        const detail = diagnostic ? ` · 省略 ${diagnostic.omitted} 条` : '';
        const change = prefix?.firstChangeMessage == null ? '' : ` · 与 ${prefix.gapSeconds} 秒前相比，第 ${prefix.firstChangeMessage} 条起有差异`;
        return `${time}｜${row.mode}｜${cached} 缓存 · ${ratio}${detail}${change}`;
    }).join('\n') || '当前聊天与线路暂无用量记录。');
}

function setEnabled(value) {
    settings().enabled = value;
    save();
    $('#cacheopt_enabled').prop('checked', value);
    $('#cacheopt_menu_label').text(`缓存优化：${value ? '开' : '关'}`);
    $('#cacheopt_menu .extensionsMenuExtensionButton').css('opacity', value ? '' : '0.4');
}

function renderLearned() {
    const list = settings().learnedHeads;
    $('#cacheopt_learned').text(list.length ? `已学到的易变块（${list.length}）：${list.join(' / ')}` : '已学到的易变块：暂无');
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
          <b>⚡ 缓存优化</b>
          <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">
          <label class="checkbox_label"><input id="cacheopt_enabled" type="checkbox"> 启用缓存优化</label>
          <label class="checkbox_label"><input id="cacheopt_route" type="checkbox"> 世界书现场调整：关键词 / 会变的条目移到聊天中（不改文件）</label>
          <label class="checkbox_label"><input id="cacheopt_hoist" type="checkbox"> 固定规则条目前移进系统提示</label>
          <label class="checkbox_label"><input id="cacheopt_argon" type="checkbox"> Argon 前缀优化（仅 Vertex AI gemini-4-argon）</label>
          <label class="checkbox_label"><input id="cacheopt_compact" type="checkbox"> Argon 动态历史瘦身（仅本次请求，不改聊天记录）</label>
          <label class="cacheopt-label">至少保留最近对话轮数（每 8 轮成批处理，0 = 不瘦身）
            <input id="cacheopt_compact_turns" class="text_pole cacheopt-num" type="number" min="0" max="100"></label>
          <label class="checkbox_label"><input id="cacheopt_sticky" type="checkbox"> 关键词设定放到聊天记录前并保持
            <input id="cacheopt_sticky_turns" class="text_pole cacheopt-num" type="number" min="1" max="50"> 条消息（可能稳定前缀；Gemini / Vertex 或开了提示词后处理时自动不生效，效果需看实际缓存用量）</label>
          <label class="checkbox_label"><input id="cacheopt_learn" type="checkbox"> 自动学习系统提示里的易变块</label>
          <label class="cacheopt-label">保持原位的条目（正则，匹配条目名或内容开头）
            <input id="cacheopt_keep" class="text_pole" type="text">
          </label>
          <div class="cacheopt-row">
            <div id="cacheopt_check" class="menu_button">检查缓存稳定性（免费）</div>
            <div id="cacheopt_forget" class="menu_button">清空已学到的易变块</div>
          </div>
          <div id="cacheopt_learned" class="cacheopt-hint"></div>
          <div id="cacheopt_last" class="cacheopt-hint"></div>
          <div id="cacheopt_report" class="cacheopt-report">点「检查缓存稳定性」查看两轮之间的提示文本变化（不是缓存命中率）。</div>
          <div class="cacheopt-hint">真实发送请求前缀比较（不是缓存命中率）：</div>
          <div id="cacheopt_real" class="cacheopt-report">同一聊天连续发送两次后显示。</div>
          <div class="cacheopt-hint">酒馆响应中的缓存用量（若酒馆转发了 usage 字段则自动读取；未读到不代表 0）：</div>
          <div id="cacheopt_usage" class="cacheopt-report">尚未读到服务商缓存用量。</div>
          <div class="cacheopt-hint">当前聊天与线路的近期用量（按发送时的优化模式）：</div>
          <div id="cacheopt_usage_history" class="cacheopt-report"></div>
        </div>
      </div>
    </div>`;
    $('#extensions_settings2').append(html);
    $('#cacheopt_enabled').prop('checked', settings().enabled).on('input', function () { setEnabled(!!$(this).prop('checked')); });
    bindCheckbox('#cacheopt_route', 'routeWorldInfo');
    bindCheckbox('#cacheopt_hoist', 'hoistStatic');
    bindCheckbox('#cacheopt_argon', 'argonStablePrefix');
    bindCheckbox('#cacheopt_compact', 'argonCompactDynamic');
    $('#cacheopt_compact_turns').val(settings().argonMaxHistoryTurns).on('change', function () {
        settings().argonMaxHistoryTurns = Math.min(100, Math.max(0, Math.floor(Number($(this).val())) || 0));
        $(this).val(settings().argonMaxHistoryTurns);
        save();
    });
    bindCheckbox('#cacheopt_learn', 'learn');
    bindCheckbox('#cacheopt_sticky', 'stickyLore');
    $('#cacheopt_sticky_turns').val(settings().stickyTurns).on('change', function () {
        settings().stickyTurns = Math.min(50, Math.max(1, Math.floor(Number($(this).val())) || DEFAULTS.stickyTurns));
        $(this).val(settings().stickyTurns);
        save();
    });
    $('#cacheopt_keep').val(settings().keepPatterns).on('change', function () {
        settings().keepPatterns = String($(this).val());
        save();
    });
    $('#cacheopt_check').on('click', () => checkStability().catch(e => $('#cacheopt_report').text(`检查失败：${e?.message || e}`)));
    $('#cacheopt_forget').on('click', () => {
        settings().learnedHeads = [];
        save();
        renderLearned();
    });
    $('#cacheopt_last').text(lastRun);
    renderCacheUsage();
    renderLearned();

    // 魔法棒菜单（左下角）一键开关，结构与酒馆自带的菜单项一致
    const item = $(`<div id="cacheopt_wand_container" class="extension_container interactable" tabindex="0">
        <div id="cacheopt_menu" class="list-group-item flex-container flexGap5 interactable" tabindex="0" role="listitem" title="一键开关缓存优化">
          <div class="fa-solid fa-bolt extensionsMenuExtensionButton"></div><span id="cacheopt_menu_label"></span></div></div>`);
    item.on('click', () => {
        setEnabled(!settings().enabled);
        toastr.info(`缓存优化已${settings().enabled ? '开启' : '关闭'}`, '缓存优化');
    });
    $('#extensionsMenu').append(item);
    setEnabled(settings().enabled);
}

jQuery(() => {
    settings();
    renderSettings();
    watchRealRequests();
    const c = ctx();
    c.eventSource.on(c.eventTypes.WORLDINFO_ENTRIES_LOADED, data => {
        routeEntries([data?.globalLore, data?.characterLore, data?.chatLore, data?.personaLore]);
    });
    c.eventSource.on(c.eventTypes.CHAT_COMPLETION_PROMPT_READY, onPromptReady);
    c.eventSource.on(c.eventTypes.CHAT_CHANGED, () => {
        recentReal = [];
        $('#cacheopt_real').text('同一聊天连续发送两次后显示。');
        renderCacheUsage();
    });
});
