# NLTodo

PaperTodo 的 Web 插件。直接在 Todo 正文里写时间，插件会调用 PaperTodo 原生的提醒 API，把「什么时候提醒」交给宿主去调度。

Todo 本身不被改写，不会多出一张插件专属的纸片，也不引入新的任务体系。

```text
□ 询问详细信息 明天下午三点
```

> 打包下载：[GitHub Releases](https://github.com/Hallocrux/NLTodo.PaperTodo.Plugins/releases) —— 解压到 PaperTodo 的 `plugins/` 即可，不需要 clone。

## 语法

不需要任何前缀，正文里说人话就行。

| 写法 | 含义 |
|---|---|
| `明天下午三点交材料` | 明天 15:00 |
| `20分钟后提醒我` | 当前时间 + 20 分钟 |
| `下周一交报告` | 下周一 09:00 |
| `周三上午10点开会` | 最近的周三 10:00 |
| `今晚8点` | 今天 20:00 |
| `12月1日` | 最近的那个 12 月 1 日 09:00 |
| `后天` / `大后天` | 对应日期 09:00 |
| `tomorrow at 5pm` | 英文同样可用 |

规则：

- **只识别第一条时间说法**。`3天后再说，5点开会` 只认 `3天后`，后面的忽略。
- 只有日期没有时刻的，补 **09:00**。
- 只写时刻且今天已过的，默认**不设提醒**，也不会自动顺延；可在设置里打开「顺延到明天」。
- 中文 `三点` 这类没有上下午限定的，1–6 点按下午理解（15:00），7–12 点按字面。
- 解析出的时间已经过去时，不设提醒，只记一条诊断。

> **0.2.0 是破坏性变更**：`@17tomorrow` 这类旧标记已废弃。存量 Todo 里的 `@` 标记不会再被识别，提醒会随该 Todo 的下一次正文改动被清空。

## 目录结构

```text
nltodo/
├── plugin.json          插件清单（id 必须与安装目录名一致）
├── web/
│   ├── index.html       Body 占位页（语法说明）
│   ├── runtime.html     后台 Runtime：事件监听 + 对账
│   ├── parser.js        时间解析器（纯函数，可单测）
│   └── vendor/          chrono-node 中英定制包（77 KB）+ NOTICE
├── test/
│   ├── parser.test.js   解析器单测
│   ├── runtime.test.js  Runtime 集成测试（vm + 宿主桩）
│   └── host-e2e.mjs     通过宿主 MCP 管道的端到端脚本
├── prds/11-9.md         产品需求文档 v0.2（第 3 章的 @ 语法已作废）
├── prds/nl-time-implementation-proposal.md  自然语言识别方案
└── package.json
```

## 前置条件（两个都必须满足，否则插件静默不工作）

1. **PaperTodo 必须是带插件系统的版本。**
   v3.40 及更早的正式版**完全没有插件系统**——源码里连一个 plugin 相关文件都没有，`plugins/` 目录不会被扫描。插件能力从 v4 开始才有（v4.0.0-beta1 只到协议 2.1，不支持本插件需要的 `presentation: hidden` 与 Runtime 事件订阅；需要 `main` 分支即 v4.0.0-beta2）。

2. **设置里必须打开 Labs 的「待办提醒」实验特性。**
   默认关闭。关闭时 `todos.setReminder` 会返回 `reminders_disabled`，插件会把它记进 `runtime.notice = "todo_reminders_disabled"`，不写任何提醒。

## 安装

插件根目录固定为 **PaperTodo 可执行文件所在目录** 下的 `plugins/`（源码里是 `AppContext.BaseDirectory`，不是 AppData）。目录名必须与 `plugin.json` 的 `id` 完全一致：

```text
<PaperTodo 所在目录>/plugins/nltodo.papertodo.plugins/
├── plugin.json
└── web/
    ├── index.html
    ├── runtime.html
    └── parser.js
```

便携版的 `<PaperTodo>` 就是 exe 所在目录，例如：

```text
<PaperTodo>\plugins\nltodo.papertodo.plugins\
```

安装只需 `plugin.json` 和 `web/` 三件套，`test/`、`prds/`、`package.json` 不必拷进去。

**改完文件必须重启 PaperTodo** —— 协议 2.x 没有插件热重载，manifest 和 Web 文件都在下次启动时才被发现。重启后在设置里确认「启用 NLTodo」是开启状态（默认开启）。

改动后重新部署（在仓库根目录执行，把 `<PaperTodo>` 换成本机安装目录）：

```bash
cp plugin.json <PaperTodo>/plugins/nltodo.papertodo.plugins/ && \
cp web/index.html web/runtime.html web/parser.js <PaperTodo>/plugins/nltodo.papertodo.plugins/web/ && \
cp web/vendor/* <PaperTodo>/plugins/nltodo.papertodo.plugins/web/vendor/
```

## 验证是否真的在跑

Runtime 没有界面。启动后它会往 `plugins/data/nltodo.papertodo.plugins.json` 的 `runtime` 域写一份状态：

```text
<PaperTodo>\plugins\data\nltodo.papertodo.plugins.json
```

```json
{
  "runtime": {
    "version": 1,
    "todos": {},
    "diagnostics": [],
    "stats": {
      "startCount": 1,
      "startedAt": "2026-11-09T18:02:11.000+08:00",
      "applied": 0,
      "skipped": 0,
      "failed": 0
    }
  }
}
```

`startCount` 增加、`startedAt` 变化，说明 Runtime 起来了。之后新建一条 `测试 @in2m`：

- `stats.applied` 加 1；
- `todos.<paperId>.<todoId>` 出现 `expression` / `resolvedAt` / `lastAppliedReminderAt`；
- PaperTodo 里那条 Todo 的提醒时间变成 2 分钟后。

到点后是 PaperTodo 自己的提醒弹窗，不是插件弹的。

## 跑测试

```bash
npm test
# 或者
node --test test/parser.test.js test/runtime.test.js
```

`parser.test.js` 覆盖 23 条识别与规则用例（含两条回禁用例：`周三` 必须落到未来、`11月12日` 必须是今年）；`runtime.test.js` 用 `vm` 加载真实的 `runtime.html` 内联脚本，配一个内存宿主桩，覆盖 18 条事件处理路径（幂等、changedFields 门控、提醒触发、时间说法增删改、启动对账、完成态、孤儿状态清理）。

## 四个必须知道的行为

**隐藏纸片是 Runtime 的唯一生命线。** PaperTodo 只在「provider 至少有一张实体 Paper」时启动 Runtime。本插件靠 `startupPaper.presentation: "hidden"` 造一张隐藏纸片来满足这个条件。用户删掉它，本次会话内插件立即失效；下次启动时宿主会按 `instanceKey` 自动恢复，功能随之恢复。

**宿主事件是尽力投递，没有重放。** Runtime 挂掉期间的 Todo 变更不会补发，靠启动时的 `todos.list` 全量对账兜底 —— 这也是 `FR-06` 存在的原因。

**启动对账有竞态。** Runtime 在第一张纸片出现时就启动，此时宿主的 Todo 模型可能还没装载完，`todos.list` 会返回空数组。空数组分不清「真的没有 Todo」和「还没加载好」，所以 `reconcileWithRetry` 对空结果按 2s / 4s 退避重试，最多三次。

**宿主请求可能永不返回。** Runtime 文档在启动阶段会重新导航，在途请求的响应会被丢弃，promise 不 settle。所有宿主调用都走 `hostRequest` 的超时包装（`todos.list` 6s，`todos.setReminder` 8s），超时即失败，由重试层接手，不让整条链路挂死。

## 与文档的关系

实现依据 `prds/11-9.md`（v0.2）。其中与宿主协议相关的契约来自 PaperTodo 源码核对：

- `PaperTodo.Plugin.Abstractions/PaperTodoHostContracts.cs`：`SetTodoReminderRequest`、`TodoSnapshot`、`TodoChangedFields`、事件记录
- `src/WebPluginWorkspaceRequests.cs`：`todos.setReminder` / `todos.list` 的 Web 侧分发
- `src/WebPluginRuntime.cs`：Runtime 桥接对象与 `onHostEvent`
- `plugin-samples/PaperTodo.Plugin.OfficialClockWeb`：manifest 与 Runtime 通信范式

注意：宿主用 `JsonStringEnumConverter(CamelCase)` 序列化事件枚举，`changedFields` 实际是 `"text, reminder"` 这类逗号串，不是位数字。`runtime.html` 里的 `readChangedFields` 同时兼容数字、字符串和数组三种形态，避免依赖单一编码。

## License

[MIT](LICENSE) © 2026 Hallocrux
