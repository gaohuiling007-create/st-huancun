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

test('缺乏连续历史依据时保留顺序', () => {
    const { onPromptReady } = load(history);
    const chat = [system('〔记忆系统私密简报\n变化'), user('继续探索'), system('示例规则'), assistant('不同的回复')];
    const original = [...chat];
    onPromptReady({ chat });
    assert.deepEqual(chat, original);
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

test('工具链、多模态、模型签名分别保留顺序', () => {
    const { onPromptReady } = load(history);
    const preserved = [
        { role: 'assistant', content: '', tool_calls: [{ id: 'one' }] },
        { role: 'tool', content: 'result', tool_call_id: 'one' },
        { role: 'assistant', content: '签名', signature: 'opaque' },
        { role: 'user', content: [{ type: 'text', text: '附件' }] },
    ];
    for (const message of preserved) {
        const chat = [system('〔记忆系统私密简报\n动态'), ...history, message];
        const original = [...chat];
        onPromptReady({ chat });
        assert.deepEqual(chat, original);
    }
});

test('已知易变块立即后移，自动学习在第二次观察到变化时生效', () => {
    const { onPromptReady, settings } = load(history);
    const known = system('〔记忆系统私密简报\n已知');
    const withKnown = [known, ...history];
    onPromptReady({ chat: withKnown });
    assert.equal(withKnown.at(-1), known);
    for (let i = 0; i <= 2; i++) {
        const dynamic = system(`剧情状态记录\n版本 ${i}`);
        const chat = [system('固定规则'), dynamic, ...history];
        onPromptReady({ chat });
        assert.equal(chat.indexOf(dynamic), i < 2 ? 1 : chat.length - 1);
    }
    assert.equal(settings().learnedHeads[0], '剧情状态记录');
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
