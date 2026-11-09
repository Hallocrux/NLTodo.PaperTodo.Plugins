'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const RUNTIME_HTML = fs.readFileSync(path.join(ROOT, 'web', 'runtime.html'), 'utf8');
const PARSER_SRC = fs.readFileSync(path.join(ROOT, 'web', 'parser.js'), 'utf8');
const RUNTIME_SRC = /<script>([\s\S]*?)<\/script>/.exec(RUNTIME_HTML)[1];

function tick(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms || 10));
}

/** 用内存桩模拟 PaperTodo 宿主，跑真实的 runtime.html 内联脚本 */
function createHarness(options) {
  const opts = options || {};

  const host = {
    settings: opts.settings || { autoStart: true },
    state: opts.state || null,
    todos: opts.todos ? opts.todos.map((t) => ({ ...t })) : [],
    calls: [],
    saved: 0,
    listener: null,
    subscribeOptions: null,
    eventTypes: null
  };

  const papertodo = {
    settings: {
      get: async () => host.settings
    },
    state: {
      get: async () => host.state,
      save: async (value) => {
        host.state = JSON.parse(JSON.stringify(value));
        host.saved += 1;
      }
    },
    workspace: {
      request: async (method, params) => {
        host.calls.push({ method, params: { ...params } });
        if (method === 'todos.list') return host.todos.map((todo) => ({ ...todo }));
        if (method === 'todos.setReminder') {
          const todo = host.todos.find((item) => item.id === params.todoId && item.paperId === params.paperId);
          if (todo) todo.reminderAt = params.reminderAt;
          return { paperId: params.paperId, todoId: params.todoId, reminderAt: params.reminderAt };
        }
        return null;
      }
    },
    onHostEvent: (types, listener, listenerOptions) => {
      host.eventTypes = types;
      host.listener = listener;
      host.subscribeOptions = listenerOptions;
      return () => { host.listener = null; };
    }
  };

  const listeners = [];
  const windowObj = {
    papertodo,
    addEventListener: (name, fn) => { listeners.push({ name, fn }); }
  };

  const sandbox = {
    window: windowObj,
    console: { log() {} },
    setTimeout: () => 0,
    clearTimeout: () => {},
    Promise,
    Date,
    JSON,
    Math,
    Set,
    Map,
    Object,
    Array,
    String,
    Number,
    Boolean,
    isFinite,
    RegExp,
    Error
  };
  sandbox.globalThis = sandbox;

  const context = vm.createContext(sandbox);
  vm.runInContext(PARSER_SRC, context, { filename: 'parser.js' });
  windowObj.NLTodoParser = context.NLTodoParser;
  assert.ok(windowObj.NLTodoParser, '解析器未挂到 window 上');

  vm.runInContext(RUNTIME_SRC, context, { filename: 'runtime.js' });

  const bridge = listeners.find((item) => item.name === 'papertodo');
  assert.ok(bridge, 'runtime 未注册 papertodo 事件监听');

  function initialize() {
    bridge.fn({
      detail: { type: 'initialize', settings: host.settings, state: host.state }
    });
  }

  function emit(event) {
    assert.ok(host.listener, 'runtime 尚未订阅宿主事件');
    host.listener(event);
  }

  function setReminderCalls() {
    return host.calls.filter((call) => call.method === 'todos.setReminder');
  }

  return { host, initialize, emit, setReminderCalls, tick };
}

function recordOf(host, paperId, todoId) {
  return host.state && host.state.todos[paperId] ? host.state.todos[paperId][todoId] : undefined;
}

test('启动：订阅三个事件并带上 excludeOwnOperations', async () => {
  const h = createHarness({ todos: [] });
  h.initialize();
  await tick();

  assert.deepStrictEqual(
    Array.from(h.host.eventTypes).sort(),
    ['todo.changed', 'todo.created', 'todo.deleted']
  );
  assert.strictEqual(h.host.subscribeOptions.excludeOwnOperations, true);
  assert.strictEqual(h.host.state.stats.startCount, 1);
});

test('创建：@in25m 写入约 25 分钟后的提醒', async () => {
  const h = createHarness({ todos: [{ paperId: 'p1', id: 't1', text: '喝水 @in25m', reminderAt: null }] });
  h.initialize();
  await tick();

  const calls = h.setReminderCalls();
  assert.strictEqual(calls.length, 1);
  const target = Date.parse(calls[0].params.reminderAt);
  const delta = target - Date.now();
  assert.ok(delta > 24 * 60 * 1000 && delta < 26 * 60 * 1000, `偏差过大: ${delta}ms`);

  const record = recordOf(h.host, 'p1', 't1');
  assert.strictEqual(record.expression, '@in25m');
  assert.strictEqual(record.managedByPlugin, true);
});

test('启动对账：已有提醒与状态一致时不重复写入', async () => {
  const resolvedAt = '2026-11-10T17:00:00+08:00';
  const h = createHarness({
    state: {
      version: 1,
      todos: {
        p1: { t1: { expression: '@17tomorrow', resolvedAt, lastAppliedReminderAt: resolvedAt, managedByPlugin: true } }
      }
    },
    todos: [{ paperId: 'p1', id: 't1', text: '交材料 @17tomorrow', reminderAt: resolvedAt }]
  });
  h.initialize();
  await tick();

  assert.strictEqual(h.setReminderCalls().length, 0, '不应重复补设提醒');
});

test('启动对账：@in25m 重启后不延长倒计时', async () => {
  const resolvedAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  const h = createHarness({
    state: {
      version: 1,
      todos: {
        p1: { t1: { expression: '@in25m', resolvedAt, lastAppliedReminderAt: resolvedAt, managedByPlugin: true } }
      }
    },
    todos: [{ paperId: 'p1', id: 't1', text: '喝水 @in25m', reminderAt: resolvedAt }]
  });
  h.initialize();
  await tick();

  assert.strictEqual(h.setReminderCalls().length, 0, '重启不应重算相对时间');
});

test('启动对账：提醒被清空时用旧解析时间补回，不重算', async () => {
  const resolvedAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  const h = createHarness({
    state: {
      version: 1,
      todos: {
        p1: { t1: { expression: '@in25m', resolvedAt, lastAppliedReminderAt: resolvedAt, managedByPlugin: true } }
      }
    },
    todos: [{ paperId: 'p1', id: 't1', text: '喝水 @in25m', reminderAt: null }]
  });
  h.initialize();
  await tick();

  const calls = h.setReminderCalls();
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].params.reminderAt, resolvedAt);
});

test('重复事件：同一表达式不重复写入', async () => {
  const h = createHarness({ todos: [] });
  h.initialize();
  await tick();

  const todo = { paperId: 'p1', id: 't1', text: '喝水 @in25m', reminderAt: null };
  h.emit({ kind: 'todoCreated', todo: { ...todo } });
  await tick();
  assert.strictEqual(h.setReminderCalls().length, 1);

  todo.reminderAt = h.setReminderCalls()[0].params.reminderAt;
  h.emit({ kind: 'todoCreated', todo: { ...todo } });
  await tick();
  assert.strictEqual(h.setReminderCalls().length, 1, '重复事件不应再写一次');
});

test('无关字段变更：changedFields 不含 text 时直接跳过', async () => {
  const h = createHarness({ todos: [] });
  h.initialize();
  await tick();

  const before = { paperId: 'p1', id: 't1', text: '喝水 @17tomorrow', done: false, reminderAt: null };
  const after = { ...before, done: true };
  h.emit({ kind: 'todoChanged', before, after, changedFields: 'completion' });
  await tick();

  assert.strictEqual(h.setReminderCalls().length, 0);
});

test('提醒触发：reminderTriggered 翻转不触发重新解析', async () => {
  const h = createHarness({ todos: [] });
  h.initialize();
  await tick();

  const before = {
    paperId: 'p1', id: 't1', text: '喝水 @17tomorrow', reminderAt: '2026-11-10T17:00:00+08:00', reminderTriggered: false
  };
  const after = { ...before, reminderTriggered: true };
  h.emit({ kind: 'todoChanged', before, after, changedFields: 'reminder' });
  await tick();

  assert.strictEqual(h.setReminderCalls().length, 0);
});

test('修改表达式：写入新时间，且不新建 Todo', async () => {
  const h = createHarness({ todos: [] });
  h.initialize();
  await tick();

  const before = { paperId: 'p1', id: 't1', text: '开会 @17tomorrow', reminderAt: null };
  h.emit({ kind: 'todoCreated', todo: { ...before } });
  await tick();
  const first = h.setReminderCalls()[0].params.reminderAt;
  before.reminderAt = first;

  const after = { ...before, text: '开会 @18tomorrow' };
  h.emit({ kind: 'todoChanged', before: { ...before }, after, changedFields: 'text' });
  await tick();

  const calls = h.setReminderCalls();
  assert.strictEqual(calls.length, 2);
  assert.notStrictEqual(calls[1].params.reminderAt, first);
  assert.strictEqual(new Date(Date.parse(calls[1].params.reminderAt)).getHours(), 18);
  assert.strictEqual(h.host.calls.filter((c) => c.method === 'todos.append').length, 0);
});

test('删除表达式：清空由插件管理的提醒', async () => {
  const h = createHarness({ todos: [] });
  h.initialize();
  await tick();

  const created = { paperId: 'p1', id: 't1', text: '开会 @17tomorrow', reminderAt: null };
  h.emit({ kind: 'todoCreated', todo: { ...created } });
  await tick();
  created.reminderAt = h.setReminderCalls()[0].params.reminderAt;

  h.emit({
    kind: 'todoChanged',
    before: { ...created },
    after: { ...created, text: '开会' },
    changedFields: 'text'
  });
  await tick();

  const calls = h.setReminderCalls();
  assert.strictEqual(calls.length, 2);
  assert.strictEqual(calls[1].params.reminderAt, null);
  assert.strictEqual(recordOf(h.host, 'p1', 't1'), undefined, '状态应被清理');
});

test('删除表达式但用户改过提醒：不清空', async () => {
  const h = createHarness({ todos: [] });
  h.initialize();
  await tick();

  const created = { paperId: 'p1', id: 't1', text: '开会 @17tomorrow', reminderAt: null };
  h.emit({ kind: 'todoCreated', todo: { ...created } });
  await tick();
  created.reminderAt = h.setReminderCalls()[0].params.reminderAt;

  const userReminder = '2026-12-01T09:00:00+08:00';
  h.emit({
    kind: 'todoChanged',
    before: { ...created },
    after: { ...created, text: '开会', reminderAt: userReminder },
    changedFields: 'text'
  });
  await tick();

  assert.strictEqual(h.setReminderCalls().length, 1, '不应清除用户自己的提醒');
});

test('歧义表达式：不写提醒并记录诊断', async () => {
  const h = createHarness({ todos: [] });
  h.initialize();
  await tick();

  h.emit({
    kind: 'todoCreated',
    todo: { paperId: 'p1', id: 't1', text: '两个时间 @17tomorrow @18tomorrow', reminderAt: null }
  });
  await tick();

  assert.strictEqual(h.setReminderCalls().length, 0);
  const diagnostics = h.host.state.diagnostics;
  assert.strictEqual(diagnostics.length, 1);
  assert.strictEqual(diagnostics[0].reason, 'ambiguous');
});

test('重复诊断不重复堆积', async () => {
  const h = createHarness({ todos: [] });
  h.initialize();
  await tick();

  const todo = { paperId: 'p1', id: 't1', text: 'x @in25xz', reminderAt: null };
  h.emit({ kind: 'todoCreated', todo: { ...todo } });
  await tick();
  h.emit({ kind: 'todoCreated', todo: { ...todo } });
  await tick();

  assert.strictEqual(h.host.state.diagnostics.length, 1);
});

test('已完成的 Todo 不设置提醒', async () => {
  const h = createHarness({ todos: [] });
  h.initialize();
  await tick();

  h.emit({
    kind: 'todoCreated',
    todo: { paperId: 'p1', id: 't1', text: '喝水 @17tomorrow', done: true, reminderAt: null }
  });
  await tick();

  assert.strictEqual(h.setReminderCalls().length, 0);
  assert.strictEqual(h.host.state.stats.failed, 0, '不应计入失败');
});

test('启动对账跳过已完成的 Todo', async () => {
  const h = createHarness({
    todos: [{ paperId: 'p1', id: 't1', text: '喝水 @17tomorrow', done: true, reminderAt: null }]
  });
  h.initialize();
  await tick();

  assert.strictEqual(h.setReminderCalls().length, 0);
  assert.strictEqual(h.host.state.stats.failed, 0);
});

test('取消完成状态后重新评估并设置提醒', async () => {
  const h = createHarness({ todos: [] });
  h.initialize();
  await tick();

  const before = { paperId: 'p1', id: 't1', text: '喝水 @17tomorrow', done: true, reminderAt: null };
  h.emit({ kind: 'todoChanged', before, after: { ...before, done: false }, changedFields: 'completion' });
  await tick();

  assert.strictEqual(h.setReminderCalls().length, 1, '取消勾选后应补上提醒');
});

test('删除 Todo：清理状态，不调用 setReminder', async () => {
  const h = createHarness({ todos: [] });
  h.initialize();
  await tick();

  const created = { paperId: 'p1', id: 't1', text: '开会 @17tomorrow', reminderAt: null };
  h.emit({ kind: 'todoCreated', todo: { ...created } });
  await tick();
  assert.ok(recordOf(h.host, 'p1', 't1'));

  h.emit({ kind: 'todoDeleted', todo: { ...created } });
  await tick();

  assert.strictEqual(recordOf(h.host, 'p1', 't1'), undefined);
  assert.strictEqual(h.setReminderCalls().length, 1);
});

test('启动时清理孤儿状态', async () => {
  const h = createHarness({
    state: {
      version: 1,
      todos: { p9: { gone: { expression: '@17tomorrow', resolvedAt: '2026-11-10T17:00:00+08:00', managedByPlugin: true } } }
    },
    todos: []
  });
  h.initialize();
  await tick();

  assert.strictEqual(h.host.state.todos.p9, undefined);
});
