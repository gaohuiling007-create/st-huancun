const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(require.resolve('./index.js'), 'utf8');
const user = content => ({ role: 'user', content });
const assistant = content => ({ role: 'assistant', content });
const system = content => ({ role: 'system', content });

function load(history, host = {}) {
    let id = 'chat-a';
    const ui = new Map();
    const context = {
        chat: history.map(({ role, content }) => ({ is_user: role === 'user', mes: content })),
        extensionSettings: {}, chatCompletionSettings: {}, mainApi: 'openai',
        eventSource: new EventEmitter(), eventTypes: { CHAT_COMPLETION_PROMPT_READY: 'ready' },
        getCurrentChatId: () => id, saveSettingsDebounced() {},
    };
    const sandbox = vm.createContext({
        SillyTavern: { getContext: () => context }, jQuery() {},
        structuredClone, TextDecoder, URL, Request, ...host,
        $: selector => ({ text: value => ui.set(selector, value), prop() {}, is: () => false }),
    });
    const api = vm.runInContext(source + `\n({ onPromptReady, settings, checkStability,
        recordRealRequest, observeRealResponse, captureDryRun, sharedPrefix, stableJSON,
        watchRealRequests, initialize })`, sandbox);
    return { ...api, context, ui, switchChat: next => { id = next; } };
}

const history = [user('你好'), assistant('这是上一轮真实回复。'), user('继续探索')];

test('TauriTavern 等待宿主就绪，且免费检查不截短窗口化聊天', async () => {
    let ready;
    let mountChecked = false;
    const window = { __TAURITAVERN__: { ready: new Promise(resolve => { ready = resolve; }) } };
    const document = { querySelector() { mountChecked = true; return {}; } };
    const { initialize, checkStability, settings, context } = load(history, { window, document, structuredClone: undefined });
    const originalHistory = [...context.chat];
    const initializing = initialize();
    assert.equal(mountChecked, false);
    assert.equal(settings().enabled, true);
    context.generate = () => assert.fail('窗口化历史不应执行免费组装');
    await checkStability();
    assert.deepEqual(context.chat, originalHistory);
    ready();
    await initializing;
    assert.equal(mountChecked, true);
});

test('iOS 自定义协议捕获宿主生成请求，跳过同路径不同主机', async () => {
    const endpoint = '/api/backends/chat-completions/generate';
    const window = { location: { href: 'tauri://localhost/index.html', origin: 'null' } };
    let forwarded = 0;
    window.fetch = () => {
        forwarded++;
        return Promise.resolve(new Response(JSON.stringify({ usage: { prompt_tokens: 500, cached_tokens: 100 } })));
    };
    const { watchRealRequests, ui } = load(history, { window });
    watchRealRequests();
    const init = { method: 'POST', body: JSON.stringify({ messages: history }) };
    await window.fetch(`tauri://elsewhere${endpoint}`, init);
    assert.equal(ui.has('#cacheopt_real'), false);
    const response = await window.fetch(endpoint, init);
    assert.equal((await response.json()).usage.cached_tokens, 100);
    await new Promise(resolve => setImmediate(resolve));
    assert.match(ui.get('#cacheopt_usage'), /20\.0%/);
    await window.fetch(endpoint, init);
    assert.match(ui.get('#cacheopt_real'), /100\.0%/);
    assert.equal(forwarded, 3);
});

test('TauriTavern 转发的 Claude 流式数据计入缓存写入和读取', async () => {
    const { recordRealRequest, observeRealResponse, ui } = load(history);
    const cur = recordRealRequest(JSON.stringify({ stream: true, messages: history }));
    const usage = { input_tokens: 100, cache_creation_input_tokens: 200, cache_read_input_tokens: 700 };
    const event = { type: 'message_start', message: { usage } };
    await observeRealResponse(new Response(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`), cur);
    assert.match(ui.get('#cacheopt_usage'), /70\.0%/);
});

test('示例里的短句及其中的规则不参与真实历史重排', () => {
    const { onPromptReady } = load(history);
    const example = [user('你好'), system('示例规则'), assistant('示例回答')];
    const variable = system('历史中注入的动态世界书');
    const chat = [system('固定规则'), ...example, ...history.slice(0, 2), variable, history[2], system('尾部格式')];
    onPromptReady({ chat });
    assert.deepEqual(chat, [system('固定规则'), ...example, ...history, variable, system('尾部格式')]);
});

test('缺乏连续历史依据时不动没标记过的块', () => {
    const { onPromptReady } = load(history);
    const chat = [system('普通规则'), user('继续探索'), system('示例规则'), assistant('不同的回复')];
    const original = [...chat];
    onPromptReady({ chat });
    assert.deepEqual(chat, original);
});

test('认不出历史范围时，已确认的易变块仍会挪到最后', () => {
    const { onPromptReady } = load(history);
    const volatileBlock = system('〔记忆系统私密简报\n这一轮的内容');
    const chat = [volatileBlock, system('普通规则'), user('继续探索'), assistant('不同的回复')];
    onPromptReady({ chat });
    assert.deepEqual(chat, [system('普通规则'), user('继续探索'), assistant('不同的回复'), volatileBlock]);
});

test('历史裁剪后仍可识别尾部，按原顺序集中动态块并延长共同前缀', () => {
    const base = [system('固定规则'), ...history.slice(1)];
    const builds = ['旧变量', '新变量'].map(value => [base[0], base[1], system(value), base[2]]);
    const { onPromptReady, sharedPrefix, stableJSON } = load(history);
    const prefix = () => sharedPrefix(...builds.map(chat => chat.map(stableJSON))).k;
    assert.equal(prefix(), 2);
    for (const chat of builds) onPromptReady({ chat });
    assert.equal(prefix(), 3);
});

test('工具链、多模态、模型签名保持相邻，易变块仍被移出前缀', () => {
    const { onPromptReady } = load(history);
    const volatileBlock = system('〔记忆系统私密简报\n动态');

    const toolChain = [
        { role: 'assistant', content: '', tool_calls: [{ id: 'one' }] },
        { role: 'tool', content: 'result', tool_call_id: 'one' },
    ];

    const chat = [volatileBlock, ...history, ...toolChain];
    onPromptReady({ chat });

    // 工具调用与结果必须保持相邻且顺序不变。
    assert.equal(chat.indexOf(toolChain[0]) + 1, chat.indexOf(toolChain[1]));
    // 易变块被移出前缀，不再排在历史之前。
    assert.ok(chat.indexOf(volatileBlock) > chat.indexOf(history.at(-1)));

    const signature = { role: 'assistant', content: '签名', signature: 'opaque' };
    const chat2 = [volatileBlock, ...history, signature];
    onPromptReady({ chat: chat2 });
    assert.ok(chat2.indexOf(volatileBlock) > chat2.indexOf(history.at(-1)));

    const multimodal = { role: 'user', content: [{ type: 'text', text: '附件' }] };
    const chat3 = [volatileBlock, ...history, multimodal];
    onPromptReady({ chat: chat3 });
    assert.ok(chat3.indexOf(volatileBlock) > chat3.indexOf(history.at(-1)));
});

test('已知易变块立即后移，内容变化在第二次观察到时生效', () => {
    const { onPromptReady, settings } = load(history);
    const known = system('〔记忆系统私密简报\n已知');
    const withKnown = [known, ...history];
    onPromptReady({ chat: withKnown });
    assert.equal(withKnown.at(-1), known);

    const stable = system('固定规则');
    const fresh = load(history);
    fresh.onPromptReady({ chat: [stable, system('剧情状态记录\n版本 0'), ...history] });

    for (let i = 1; i <= 2; i++) {
        const dynamic = system(`剧情状态记录\n版本 ${i}`);
        const chat = [stable, dynamic, ...history];
        fresh.onPromptReady({ chat });
        assert.equal(chat.indexOf(dynamic), i < 2 ? 1 : chat.length - 1);
    }
    assert.equal(fresh.settings().learnedHeads.at(-1), '剧情状态记录 版本 #');
});

test('第一行带序号的状态块仍被认作同一块，学习后立即后移', () => {
    const { onPromptReady, settings } = load(history);
    const stable = system('固定规则');
    onPromptReady({ chat: [stable, system('第 0 轮记录\n当前状态 0'), ...history] });
    for (let i = 1; i <= 2; i++) {
        const dynamic = system(`第 ${i} 轮记录\n当前状态 ${i}`);
        const chat = [stable, dynamic, ...history];
        onPromptReady({ chat });
        assert.equal(chat.indexOf(dynamic), i < 2 ? 1 : chat.length - 1);
    }
    assert.equal(settings().learnedHeads.at(-1), '第 # 轮记录 当前状态 #');
});

test('时有时无的系统块被认出来后固定在尾部', () => {
    const { onPromptReady, settings } = load(history);
    const stable = system('固定规则');
    const sometimes = system('偶尔命中的世界书条目');

    onPromptReady({ chat: [stable, sometimes, ...history] });
    onPromptReady({ chat: [stable, ...history] });
    assert.ok(settings().learnedHeads.includes('偶尔命中的世界书条目'));

    const chat = [stable, sometimes, ...history];
    onPromptReady({ chat });
    assert.equal(chat.at(-1), sometimes);
});

test('聊天记录中间每轮变化的系统块被学习并移出前缀', () => {
    const { onPromptReady, settings } = load(history);
    const stable = system('固定规则');
    // 记忆块插在历史中间（用户消息之后），每轮内容不同。
    for (let i = 0; i <= 2; i++) {
        const mid = system(`剧情状态记录\n版本 ${i}`);
        const chat = [stable, history[0], mid, history[1], history[2]];
        onPromptReady({ chat });
        // 稳定块和历史保持前缀，变化块被移到历史之后。
        assert.ok(chat.indexOf(mid) > chat.indexOf(history.at(-1)));
    }
    assert.equal(settings().learnedHeads.at(-1), '剧情状态记录 版本 #');
});

test('真实请求对比指出断点所在块与前后原文', () => {
    const { recordRealRequest, ui } = load(history);
    recordRealRequest(JSON.stringify({ model: 'mock', messages: [
        system('固定规则，每次都一样'), user('你好'),
    ] }));
    recordRealRequest(JSON.stringify({ model: 'mock', messages: [
        system('固定规则，第 2 次不同'), user('你好'),
    ] }));
    const report = ui.get('#cacheopt_real');
    assert.match(report, /变化所在块开头：固定规则，每次都一样/);
    assert.match(report, /原文：…固定规则，每次都一样…/);
    assert.match(report, /现文：…固定规则，第 2 次不同…/);
    assert.match(report, /还没标记为易变/);
    assert.match(report, /相同前缀估算：约 0 tokens/);
});

test('聊天记录被改写时提示窗口或历史变化', () => {
    const { recordRealRequest, ui } = load(history);
    recordRealRequest(JSON.stringify({ model: 'mock', messages: history }));
    recordRealRequest(JSON.stringify({ model: 'mock', messages: [
        user('换了一段完全不同的开头'), ...history.slice(1),
    ] }));
    assert.match(ui.get('#cacheopt_real'), /变化落在聊天记录里/);
});

test('免费检查保留两轮各自的用户输入并恢复完整历史', async () => {
    const { context, checkStability } = load([...history, assistant('末尾回复')]);
    const snapshot = [...context.chat];
    const captures = [];
    context.generate = async (_, options, dryRun) => {
        assert.equal(dryRun, true);
        captures.push(context.chat.map(message => message.mes));
        context.eventSource.emit('ready', { chat: [], dryRun: false });
        context.eventSource.emit('ready', { chat: history, dryRun });
    };
    await checkStability();
    assert.deepEqual(captures, [history.slice(0, 1).map(m => m.content), history.map(m => m.content)]);
    assert.deepEqual(context.chat, snapshot);
    assert.equal(context.eventSource.listenerCount('ready'), 0);
});

test('模拟失败仍恢复历史并移除监听', async () => {
    const { context, checkStability } = load(history);
    const snapshot = [...context.chat];
    context.generate = async () => { throw new Error('mock failure'); };
    await assert.rejects(checkStability(), /mock failure/);
    assert.deepEqual(context.chat, snapshot);
    assert.equal(context.eventSource.listenerCount('ready'), 0);
});

test('切换会话时不把旧消息写进新会话', async () => {
    const { context, checkStability, switchChat, ui } = load(history);
    const snapshot = [...context.chat];
    const incoming = [{ is_user: true, mes: '另一段会话' }];
    context.generate = async () => {
        switchChat('chat-b');
        context.chat.splice(0, context.chat.length, ...incoming);
    };
    await checkStability();
    assert.notDeepEqual(context.chat, snapshot);
    assert.deepEqual(context.chat, incoming);
    assert.match(ui.get('#cacheopt_report'), /切换了聊天/);
});

test('流式兼容响应上报的 token 用量可计算缓存比例', async () => {
    const { recordRealRequest, observeRealResponse, ui } = load(history);
    const cur = recordRealRequest(JSON.stringify({ stream: true, messages: history }));
    const sse = 'data: {"usage":{"prompt_tokens":400,"prompt_tokens_details":{"cached_tokens":100}}}\r\n\r\ndata: [DONE]\r\n\r\n';
    await observeRealResponse(new Response(sse, { headers: { 'Content-Type': 'text/event-stream' } }), cur);
    assert.match(ui.get('#cacheopt_usage'), /25\.0%/);
});

test('报告零命中时按前缀形状给出不同结论', async () => {
    const { recordRealRequest, observeRealResponse, ui } = load(history);
    const body = messages => JSON.stringify({ model: 'mock', messages });
    const first = recordRealRequest(body(history));
    await observeRealResponse(new Response(JSON.stringify({ usage: {
        prompt_tokens: 900, prompt_tokens_details: { cached_tokens: 0 },
    } })), first);
    assert.match(ui.get('#cacheopt_usage'), /响应明确报告缓存为 0/);

    const same = recordRealRequest(body(history));
    await observeRealResponse(new Response(JSON.stringify({ usage: {
        prompt_tokens: 900, prompt_tokens_details: { cached_tokens: 0 },
    } })), same);
    assert.match(ui.get('#cacheopt_usage'), /上游或中转没有启用提示词缓存/);

    const grown = recordRealRequest(body([...history, assistant('新的回复'), user('再问一句')]));
    await observeRealResponse(new Response(JSON.stringify({ usage: {
        prompt_tokens: 900, prompt_tokens_details: { cached_tokens: 0 },
    } })), grown);
    assert.match(ui.get('#cacheopt_usage'), /内容只在末尾追加/);
});

test('真实响应中的输入缓存比例可见，较早请求不能覆盖新报告', async () => {
    const { recordRealRequest, observeRealResponse, ui } = load(history);
    const body = JSON.stringify({ model: 'mock', messages: history });
    const early = recordRealRequest(body);
    const newest = recordRealRequest(body);
    await observeRealResponse(new Response(JSON.stringify({ usageMetadata: {
        promptTokenCount: 1000, cachedContentTokenCount: 250,
    } })), newest);
    assert.match(ui.get('#cacheopt_usage'), /25\.0%/);
    await observeRealResponse(new Response(JSON.stringify({ usage: {
        prompt_tokens: 1000, prompt_tokens_details: { cached_tokens: 0 },
    } })), early);
    assert.match(ui.get('#cacheopt_usage'), /25\.0%/);
});
