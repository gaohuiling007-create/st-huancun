// ST-Cache-Optimizer 2.6.0
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
const MAX_LEARNED = 40;
const MAX_LEARN_CHARS = 20000;
// 多数模型要求可缓存前缀达到约 1k tokens 才开始命中。
const MIN_CACHE_TOKENS = 1024;
const KEY_CHARS = 28;

// 服务端报告 0 命中时，按前缀形状给出不同结论，避免“没提升”变成猜谜。
const ZERO_HINTS = {
    identical: '两次请求内容完全相同仍报 0：多半是上游或中转没有启用提示词缓存。',
    append: '内容只在末尾追加，理论上应命中：确认模型支持缓存、前缀达到门槛，且两次间隔在缓存有效期内。',
    partial: '前缀在中途断开：看上方「真实请求对比」里的首个变化位置。',
};

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

function tauriReady() {
    return window.__TAURITAVERN__?.ready ?? window.__TAURITAVERN_MAIN_READY__;
}

function isTauriTavern() {
    return typeof window !== 'undefined' && Boolean(window.__TAURITAVERN__ || tauriReady());
}

function settings() {
    const all = ctx().extensionSettings;
    all[MODULE] ??= {};

    for (const [key, value] of Object.entries(DEFAULTS)) {
        all[MODULE][key] ??= Array.isArray(value) ? [...value] : value;
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
        1, Math.min(50, Math.floor(Number(s.stickyTurns) || DEFAULTS.stickyTurns)),
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

// 用来认出「同一个块」。第一行里的数字、书名号、引号每轮都可能变，
// 去掉这些之后仍相同，才视为同一块，才能观察它是否真的在变。
function blockKey(value) {
    return normalize(String(value ?? '').slice(0, 600))
        .replace(/[0-9０-９]+/g, '#')
        .replace(/[「」『』〔〕【】《》〈〉"“”'‘’`]/g, '')
        .slice(0, KEY_CHARS);
}

function isTopBlock(message) {
    const value = text(message).trimStart();
    return value.startsWith(STATIC_OPEN)
        || value.startsWith(STICKY_OPEN);
}

function isVolatileHead(value) {
    const head = normalize(value).slice(0, 80);
    const key = blockKey(value);
    const s = settings();

    return [...s.volatileHeads, ...s.learnedHeads]
        .some(item => item && (head.startsWith(item) || key === item));
}

function normalize(value) {
    return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function historyText(value) {
    return normalize(value).replace(/^"([\s\S]*)"$/, '$1');
}

function matchesHistory(source, target) {
    if (source.role !== target.role) return false;
    if (source.value === target.value) return true;
    // 扩展可能包裹或局部改写正文。短消息只允许完整匹配。
    if (source.value.length < 90) return false;
    const first = Math.floor(source.value.length * 0.25);
    const second = Math.floor(source.value.length * 0.65);
    const at = target.value.indexOf(source.value.slice(first, first + 24));
    return at >= 0 && target.value.includes(source.value.slice(second, second + 24), at + 24);
}

function findHistoryRange(chat) {
    const turns = [];
    for (const [index, message] of chat.entries()) {
        if (!['user', 'assistant'].includes(message?.role)) continue;
        const value = historyText(text(message));
        if (value) turns.push({ index, role: message.role, value });
    }

    const local = ctx().chat ?? [];
    const history = [];
    for (let i = local.length - 1; i >= 0 && history.length <= turns.length; i--) {
        const message = local[i];
        if (message?.is_system || typeof message?.mes !== 'string') continue;
        const value = historyText(message.mes);
        if (value) history.push({ role: message.is_user ? 'user' : 'assistant', value });
    }
    history.reverse();

    // 组装可能裁掉旧历史，或在末尾追加本地尚未保存的新输入。
    // 从末尾找同角色、同顺序的连续匹配，遇到不一致即停止向前扩展。
    let best = null;
    for (const offset of [0, 1]) {
        const last = history.length - 1 - offset;
        if (last < 0) continue;
        for (let end = turns.length - 1; end >= 0; end--) {
            if (!matchesHistory(history[last], turns[end])) continue;
            let count = 1;
            while (last >= count && end >= count
                && matchesHistory(history[last - count], turns[end - count])) count++;
            if (!best || count > best.count) {
                best = { start: turns[end - count + 1].index, end: turns[end].index, count };
            }
            // 优先采用最近的匹配，避免把前面的示例对话当作历史。
            break;
        }
    }
    if (!best || best.count < 2) return null;
    return best;
}

function canMoveSystem(message, keep) {
    // 工具调用、多模态内容和保持原位的规则不参与重排。
    return message?.role === 'system'
        && typeof message.content === 'string'
        && !message.tool_calls
        && !message.tool_call_id
        && !isTopBlock(message)
        && !keep.test(headOf(message));
}

// 一条消息若和它前面的消息构成不可拆的相邻关系，就标为锚点。
// 工具调用必须紧跟产生它的 assistant，模型签名也不能和正文分开。
function isAnchor(message, previous) {
    if (message?.role === 'tool' || message?.tool_call_id) return true;
    if (previous?.tool_calls && message?.role !== 'tool') return true;
    if (message?.signature || previous?.signature) return true;
    if (Array.isArray(message?.content)) return true;
    return false;
}

function isMovableVolatile(message, keep) {
    return canMoveSystem(message, keep)
        && message.content.length <= MAX_LEARN_CHARS
        && (isVolatileHead(message.content)
            || message.content.trimStart().startsWith(WRAP_OPEN));
}

// 认不出聊天记录范围时不做猜测，只把已确认的易变块挪到最后。
function reorderFallback(chat, keep) {
    const moved = [];
    const kept = [];

    for (const message of chat) {
        (isMovableVolatile(message, keep) ? moved : kept).push(message);
    }

    if (!moved.length) return 0;

    const next = [...kept, ...moved];
    if (next.every((message, index) => message === chat[index])) return 0;

    chat.length = 0;
    chat.push(...next);
    return moved.length;
}

function reorder(chat, range, keep) {
    // 工具调用、签名、多模态只能保护它们自己所在的局部区间，
    // 不该让整段前缀优化瘫痪。先算出锚点，再在锚点围出的安全段里移动。
    const anchors = new Set();
    for (let i = 0; i < chat.length; i++) {
        if (isAnchor(chat[i], chat[i - 1])) anchors.add(i);
    }

    const safe = index => !anchors.has(index);

    if (!range) return reorderFallback(chat, keep);

    const { start, end } = range;

    const moved = [];
    let write = 0;
    for (let i = 0; i <= end; i++) {
        const message = chat[i];
        const early = i < start;
        const movable = canMoveSystem(message, keep) && safe(i);

        // 锚点所在位置以及紧邻锚点之前的那条都保持原序，避免拆散工具链。
        if (i < end && i !== start && movable && safe(i - 1)
            && (!early || isMovableVolatile(message, keep))) {
            moved.push(message);
        } else {
            chat[write++] = message;
        }
    }
    for (const message of moved) chat[write++] = message;
    return moved.length;
}

function learnFrom(chat, range, keep) {
    const s = settings();
    if (!s.learn || !range) return [];

    const currentChat = chatId();

    if (lastSystemBlocks
        && lastSystemBlocks.chatId !== currentChat) {
        changeCounts.clear();
    }

    const firstTurn = chat.findIndex(message => message?.role !== 'system');
    // 学习范围：聊天记录之前的所有 system 块，加上聊天记录中间插入的
    // system 块。中间的世界书条目、记忆块每轮内容在变，同样会截断前缀，
    // 必须一并观察。锚点（工具调用/签名/多模态）不参与。
    const stop = firstTurn < 0 ? chat.length : firstTurn;
    const learnedIndexes = new Set();
    for (let i = 0; i < stop; i++) learnedIndexes.add(i);
    if (range) {
        for (let i = range.start; i <= range.end; i++) learnedIndexes.add(i);
    }

    // 同名块只取第一次出现，重复内容不算变化。
    const blocks = [];
    const seen = new Set();

    for (const i of [...learnedIndexes].sort((a, b) => a - b)) {
        const message = chat[i];
        if (!canMoveSystem(message, keep)) continue;
        if (message.content.length > MAX_LEARN_CHARS) continue;
        if (isAnchor(message, chat[i - 1])) continue;

        const key = blockKey(message.content);
        if (!key || seen.has(key)) continue;

        seen.add(key);
        blocks.push({ key, body: message.content });
    }

    const currentKeys = new Set(blocks.map(block => block.key));
    for (const key of changeCounts.keys()) {
        if (!currentKeys.has(key)) changeCounts.delete(key);
    }

    const learned = [];
    const remember = key => {
        if (!key || s.learnedHeads.includes(key) || isVolatileHead(key)) {
            return false;
        }

        s.learnedHeads.push(key);
        learned.push(key);
        return true;
    };

    if (lastSystemBlocks?.chatId === currentChat) {
        const previous = new Map(
            lastSystemBlocks.blocks.map(block => [block.key, block.body]),
        );

        for (const block of blocks) {
            const before = previous.get(block.key);

            // 首次出现可能只出现这一轮，先不标记，等它消失再处理，
            // 否则会把只出现一次的稳定内容也挪到尾部，白白损失可缓存前缀。
            if (before === undefined) continue;

            if (before === block.body) continue;

            const count = (changeCounts.get(block.key) ?? 0) + 1;
            changeCounts.set(block.key, count);

            if (count >= 2) remember(block.key);
        }

        // 上一轮有、这一轮消失的块，同样会截断前缀。
        for (const block of lastSystemBlocks.blocks) {
            if (!currentKeys.has(block.key)) remember(block.key);
        }
    }

    if (learned.length) {
        s.learnedHeads = [...new Set(s.learnedHeads)].slice(-MAX_LEARNED);
        save();
    }

    lastSystemBlocks = { chatId: currentChat, blocks };
    return learned;
}

function onPromptReady(data) {
    if (!settings().enabled || !Array.isArray(data?.chat)) return;

    const range = findHistoryRange(data.chat);
    const keep = keepRegex();
    const simulated = data.dryRun || checking;
    const learned = simulated ? [] : learnFrom(data.chat, range, keep);
    const count = reorder(data.chat, range, keep);
    if (simulated) return;

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

// 中日韩字符按 1 个 token、其余按 4 字符 1 个 token 粗估，仅用于判断是否够门槛。
function estimateTokens(value) {
    const source = String(value ?? '');
    let wide = 0;

    for (const char of source) {
        if (char.codePointAt(0) > 0x2e7f) wide++;
    }

    return Math.round(wide + (source.length - wide) / 4);
}

function excerpt(value, at, span = 36) {
    return String(value ?? '')
        .slice(Math.max(0, at - span), at + span)
        .replace(/\s+/g, ' ')
        .trim();
}

// 指出前缀具体断在哪一块、断在哪几个字，而不只是给一个位置数字。
function diffLines(previous, current, index) {
    const before = previous.contents?.[index] ?? '';
    const after = current.contents?.[index] ?? '';
    const role = current.roles[index];

    if (before === after) {
        return [
            `首个变化：第 ${index + 1} 条（${role}），正文相同但附加字段变化。`,
            '常见原因：消息名、模型签名、工具调用字段或图片内容不同。',
        ];
    }

    let at = 0;
    while (at < before.length
        && at < after.length
        && before[at] === after[at]) at++;

    const head = headOf({ content: before }) || '（空块）';

    const hints = role === 'system'
        ? [isVolatileHead(before)
            ? '该块已标记为易变：本次仍留在前面，检查是否夹带工具调用或多模态消息。'
            : '该块还没标记为易变：再生成一轮会自动识别，也可把块开头填进易变块列表。']
        : ['变化落在聊天记录里：通常是历史被改写，或上下文窗口把旧消息挤出去了。'];

    if (before.length < 40 || after.length < 40) {
        hints.push('该块很短，可能只是临时插入的提示或标记。');
    }

    return [
        `首个变化：第 ${index + 1} 条（${role}），正文第 ${at} 个字符。`,
        `变化所在块开头：${head}`,
        `原文：…${excerpt(before, at)}…`,
        `现文：…${excerpt(after, at)}…`,
        ...hints,
    ];
}

function prefixTokenLines(contents, count) {
    const tokens = estimateTokens(contents.slice(0, count).join('\n'));

    return [
        `相同前缀估算：约 ${tokens.toLocaleString()} tokens。`,
        tokens > 0 && tokens < MIN_CACHE_TOKENS
            ? `⚠ 低于常见 ${MIN_CACHE_TOKENS.toLocaleString()} tokens 门槛，`
                + '即使内容一致也可能不返回缓存。'
            : '',
    ].filter(Boolean);
}

async function captureDryRun() {
    const c = ctx();
    let captured = null;

    const handler = data => {
        if (data?.dryRun === true && Array.isArray(data.chat)) {
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
    if (checking || isTauriTavern()) return;

    const c = ctx();
    const report = $('#cacheopt_report');

    if (c.mainApi !== 'openai') {
        report.text('只支持对话补全（Chat Completion）接口。');
        return;
    }

    const history = c.chat;
    const lastUser = history.findLastIndex(message => message?.is_user && !message.is_system);
    const previousUser = history.findLastIndex((message, i) => i < lastUser
        && message?.is_user && !message.is_system);

    if (previousUser < 0) {
        report.text('聊天记录太短，至少需要两条用户消息。');
        return;
    }
    if ($('#mes_stop').is(':visible')) {
        report.text('当前正在生成，请等回复完成后再检查。');
        return;
    }

    checking = true;
    $('#cacheopt_check').prop('disabled', true);
    report.text('模拟检查中，不调用模型。请等待完成后再操作聊天。');

    const startingChatId = chatId();
    const sameChat = () => ctx().chat === history && chatId() === startingChatId;
    const captureThrough = async userIndex => {
        // 两次都保留该轮用户输入，仅截去后续消息。
        const boundary = userIndex + 1;
        const removed = history.splice(boundary);
        try {
            return await captureDryRun();
        } finally {
            // 避免向切换后的会话或已重载的历史写回旧消息。
            if (sameChat()) {
                for (const [offset, message] of removed.entries()) {
                    history.splice(boundary + offset, 0, message);
                }
            } else if (ctx().chat !== history) {
                for (const message of removed) history.push(message);
            }
        }
    };

    try {
        const previous = await captureThrough(previousUser);
        if (!sameChat()) {
            report.text('检查期间切换了聊天，请在当前聊天重新检查。');
            return;
        }
        const current = await captureThrough(lastUser);
        if (!sameChat()) {
            report.text('检查期间切换了聊天，请在当前聊天重新检查。');
            return;
        }

        if (!previous || !current) {
            report.text('检查失败：没有捕获到组装后的提示词。');
            return;
        }

        const a = previous.map(stableJSON);
        const b = current.map(stableJSON);
        const { k, chars } = sharedPrefix(a, b);
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

        const before = {
            contents: previous.map(text),
            roles: previous.map(message => message.role ?? '?'),
        };
        const after = {
            contents: current.map(text),
            roles: current.map(message => message.role ?? '?'),
        };

        report.text([
            `开头系统消息一致：${systemSame ? '✅ 是' : '❌ 否，可能影响缓存'}`,
            `消息序列化前缀相同：${
                total ? (chars / total * 100).toFixed(1) : '0.0'
            }%（${chars.toLocaleString()} / ${total.toLocaleString()} 字符）`,
            `前 ${k} 条消息完整相同。`,
            ...(k < previous.length && k < current.length
                ? diffLines(before, after, k)
                : ['其中一组消息是另一组的完整前缀。']),
            ...prefixTokenLines(after.contents, k),
            '这是字符稳定性比较，不是实际缓存 token 命中率。',
            '模拟不包含后端 Google 格式转换，以及部分扩展仅在真实生成时执行的修改。',
        ].join('\n'));
    } finally {
        checking = false;
        $('#cacheopt_check').prop('disabled', false);
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
        contents: body.messages.map(text),
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
        const { k, chars } = sharedPrefix(
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
            cur.lines.push(...diffLines(previous, cur, k));
        }

        cur.prefixState = k === cur.texts.length && k === previous.texts.length
            ? 'identical'
            : k === previous.texts.length ? 'append' : 'partial';

        cur.lines.push(...prefixTokenLines(cur.contents, k));

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
    publishUsage(cur, '等待本次响应的缓存用量。');
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
            const total = google.promptTokenCount ?? google.prompt_token_count;
            state.total = validCount(total) ? total : null;
            state.field = 'usageMetadata.cachedContentTokenCount';
        }
    }

    const usage = value.usage;

    if (usage && typeof usage === 'object') {
        state.sawUsage = true;

        const fields = [
            ['prompt_tokens_details.cached_tokens', usage.prompt_tokens_details?.cached_tokens],
            ['input_tokens_details.cached_tokens', usage.input_tokens_details?.cached_tokens],
            ['cached_tokens', usage.cached_tokens],
            ['prompt_cache_hit_tokens', usage.prompt_cache_hit_tokens],
            ['cache_read_input_tokens', usage.cache_read_input_tokens],
            ['cachedContentTokenCount', usage.cachedContentTokenCount],
        ];
        const hit = fields.find(([, count]) => validCount(count));
        if (hit) {
            const [field, count] = hit;
            let total = usage.prompt_tokens ?? usage.promptTokenCount ?? usage.input_tokens;
            // Claude 的原始 input_tokens 不含缓存读取和写入。
            if (field === 'cache_read_input_tokens' && usage.prompt_tokens == null && validCount(usage.input_tokens)) {
                total = usage.input_tokens + (usage.cache_creation_input_tokens ?? 0) + count;
            }
            state.cached = count;
            state.total = validCount(total) ? total : null;
            state.field = `usage.${field}`;
        }
    }

    // 部分中转将响应包在这些字段中。
    for (const key of ['data', 'response', 'result', ...(value.type === 'message_start' ? ['message'] : [])]) {
        if (value[key] && typeof value[key] === 'object') {
            readUsage(value[key], state);
        }
    }
}

function publishUsage(cur, message) {
    // 清空诊断后，忽略仍在完成的旧请求。
    if (latestReal !== cur) return;

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
            const ratio = state.total > 0 && state.cached <= state.total
                ? `\n输入缓存比例：${(state.cached / state.total * 100).toFixed(1)}%（${state.cached.toLocaleString()} / ${state.total.toLocaleString()} tokens）`
                : '';
            publishUsage(
                cur,
                (state.cached > 0
                    ? `响应报告缓存命中：${state.cached.toLocaleString()} tokens`
                    : '响应明确报告缓存为 0'
                        + (ZERO_HINTS[cur.prefixState]
                            ? `\n判断：${ZERO_HINTS[cur.prefixState]}`
                            : ''))
                    + ratio + `\n字段：${state.field}` + suffix,
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

            const page = new URL(window.location.href);
            const target = url ? new URL(url, page) : null;
            // iOS WebView 的自定义协议可能返回字符串 'null' 作为 origin。
            watched = target?.protocol === page.protocol && target.host === page.host
                && target.pathname === GENERATE_PATH;

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
          <b>⚡ 缓存优化 2.6.0</b>
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
            ${isTauriTavern() ? '' : `<button id="cacheopt_check" type="button" class="menu_button">
              检查提示词稳定性（免费）
            </button>`}
            <button id="cacheopt_forget" type="button" class="menu_button">
              清空已学到的易变块
            </button>
            <button id="cacheopt_clear" type="button" class="menu_button">
              清空请求诊断
            </button>
          </div>

          <div id="cacheopt_learned" class="cacheopt-hint"></div>
          <div id="cacheopt_last" class="cacheopt-hint"></div>

          <div id="cacheopt_report" class="cacheopt-report">${isTauriTavern()
            ? 'TauriTavern 使用真实请求对比。请在同一聊天和模型下连续生成两轮。'
            : '免费检查比较消息字符前缀，不代表实际缓存命中率。'}</div>

          <div class="cacheopt-hint">
            真实请求对比：按聊天、接口、模型和请求用途分组，
            比较同组紧邻上一次请求。
          </div>
          <div id="cacheopt_real" class="cacheopt-report">等待新的真实请求。</div>

          <div class="cacheopt-hint">
            最新请求的响应诊断：
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

async function initialize() {
    if (isTauriTavern()) await tauriReady();
    if (document.querySelector('.cacheopt-settings')) return;
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
}

jQuery(() => {
    initialize().catch(error => console.error('[Cache Optimizer] 初始化失败', error));
});