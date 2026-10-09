# FINDINGS — 实测结论存档

> 这些结论都是抓包级或跑出来的，重验成本很高。**改动相关代码前先读对应条目。**
> 环境：omp 18.6.1（bun 1.4.2 单文件可执行）、`@opencode/cli` v2.0.23、win32 x64。
> 记录时间：2026-10-06。

---

## 1. `registerProvider` 的真实时序

| 事实 | 证据 |
| --- | --- |
| 扩展工厂的 `registerProvider` **不立即生效**，而是进 `pendingProviderRegistrations` 队列，会话初始化时才应用 | `src/extensibility/extensions/loader.ts:104`、`types.ts:1861` |
| 工厂可以是 `async`，宿主会 `await factory(api)`；抛错会回滚该工厂排队的注册项 | `loader.ts:397-414` |
| 同名 provider **重复注册 = 整体替换全部模型**，随后失效该 provider 的缓存 | `config/model-registry.ts:3227-3228`、`:3258`、`:3273` |
| `supportsTools` 会被自定义模型构造器读取并落到模型上 | `config/custom-models.ts:90`、`:125-136` |
| 但扩展侧 `ProviderModelConfig`（`extensibility/extensions/types.ts:1750-1777`）**没有声明该字段** | 同上 |

**结论**：工厂必须 async；探测写回靠"再注册一次"，不需要别的通道；
`supportsTools` 需要自己补声明（`src/provider.ts` 的 `ProviderModelDefinition`）。

## 2. `omp models` 会列出扩展注册的 provider

实测 `omp models` 输出含 `opencode-zen-cli (10)`。

**结论**：与"运行时注册的 provider 不出现在静态模型库"的直觉相反。README 已按实测写。

## 3. `--provider` 对扩展 provider 无效

`omp --provider opencode-zen-cli` 报 `Unknown provider`，因为参数校验发生在扩展注册
生效之前。必须用 `--model <provider>/<id>`。

## 4. Windows 上停机会留下孤儿 `opencode.exe`

**这是本项目唯一一个会造成用户可见故障的坑。**

链条：Windows 上 `opencode` 是 `.cmd` shim → `spawn(cmd, { shell: true })` 起的是
cmd.exe wrapper → `child.kill('SIGTERM')` 结束 wrapper → **真正的 `opencode serve`
继续运行**，而此时 `child.exitCode !== null`，任何"进程还活着才 taskkill"的后续判断
都不会触发。

实测：修复前每跑一次 `omp -p` 就漏一个 `opencode serve`（PID 存活，命令行
`serve --hostname 127.0.0.1 --port <random>`）。

**正确做法**（`src/runtime.ts`）：win32 下一律 `taskkill /PID <pid> /T /F`，不走信号；
`process.on('exit')` 兜底同样走 `killTree()`。

验证方式：跑一次 `omp -p ...`，退出后
`Get-CimInstance Win32_Process -Filter "Name='opencode.exe'"` 只应剩用户自己开的
`serve --service`。

## 5. `Effort` 是 `const enum`

`@oh-my-pi/pi-catalog` 的 `Effort` 是 `const enum`，`"minimal"` 这类普通字符串**不能**
赋给它。`Model["thinking"]` 因此无法用字面量对象构造，只能在唯一的交汇点做一次
`as unknown as readonly EffortLevel[]`（`src/provider.ts`）。

## 6. 宿主类型从 `@oh-my-pi/pi-coding-agent` 取，锁 18.6.1

npm 上的 `@earendil-works/pi-ai` 是更早的构建，没有 `registerCustomApi` 等 API 面，
装了会把类型指向宿主根本不存在的符号。本项目只依赖 `@oh-my-pi/pi-coding-agent`，
版本与 omp 对齐。

## 7. 子进程的环境隔离

`opencode serve` 必须**同时**做三件事才不污染用户环境：

1. `XDG_{CONFIG,DATA,CACHE,STATE}_HOME` 全部指到 `<dataDir>/opencode/*`；
2. `OPENCODE_CONFIG_CONTENT` 注入隔离配置（关自动更新、关分享、审批全 `ask`）；
3. env 白名单继承，**不继承**任何 provider key 或 OpenCode 认证覆盖。

就绪探测：v2 用 `GET /api/info` 的 `version`，v1 用 `GET /global/health` 的
`healthy + version`，版本号必须与 CLI 输出一致。上限 60s。

v2 的 agent 注册是异步的（config agent 可能几秒后才出现），所以
`buddy-bridge` 存在性要轮询（120 × 500ms），不能只读一次。

## 8. v1 与 v2 的差异（移植时踩到的）

| 项 | v1 | v2 |
| --- | --- | --- |
| serve 参数 | `serve --pure --hostname … --port …` | 无 `--pure` |
| 配置注入 | `permission` map + `agent.prompt/permission` | `permissions` 规则数组 + `agents[].system/permissions` |
| 模型目录 | `GET /provider` → `providers.all[]` | `GET /api/model` → `data[]` |
| cost 形状 | `cost: { input, output, cache }` | `cost: [{ input, output, cache }]`（**数组**） |
| capability 形状 | `capabilities.output.text: boolean` | `capabilities.output: ["text"]`（**数组**） |
| reasoning | `capabilities.reasoning` | **无此字段**，代码里固定 false，不猜 |
| 推理执行 | 请求内同步 | 异步：prompt 之后轮询 message 列表 + 执行结果事件 |
| 事件 | `/event`，字段在 `payload` | `/api/event`，字段在 `data`，事件名带 `session.` 前缀 |
| 中断 | `POST …/abort` | `POST …/interrupt` |

## 9. 协议层：为什么 `backend.ts` 不能"简化"

每一条分支都对应一次真实故障（全部来自 bridge 的实测记录）：

- **信封三选一都要认**：`info.structured`、已完成的 `StructuredOutput` 调用、纯文本。
  只读前两者曾把一次正确回答判成格式错误。
- **`content: null` + `calls: [...]`（工具轮）与 `content: "..."`（文本轮）都是合法的**，
  只有两者都缺才是无效信封。
- **原生动作要外化交接（handoff），不能靠"让模型重述"**——重述正是模型最容易失败的
  一步，而且要多花一整轮上游。
- **交接必须过接收方 schema**（`validateAction`）：名字没被提供、参数越界、必填缺失
  一律拒绝，翻译不能放宽任何东西。
- **修正路径有界**：correction 一次 → translate 一次 → resend 一次，之后抛错。
  检测路径（probe）**永不翻译**，否则测的就不是模型而是翻译器的水平。
- **`no_action`（只回文本）不是失败**，是"仅对话"：发布成 `supportsTools: false`，
  而不是撤下模型。
- **图片只接受 base64 data URL**，绝不把不可信的文件 URL 变成原生读文件。

## 10. 本地服务的面

- 只绑 `127.0.0.1`，bearer 令牌**只存在于内存**（`runtime-host.ts` 的 `apiKey()`），
  端口一关就失效，没有落盘文件需要清理。
- 带 `Origin` 的请求一律 403：omp 是本地 Node 进程，永远不发 Origin，发的一定是浏览器。
- 同时保留 `/v1/…` 与无前缀别名路由，两边等价。
- 并发上限 4，超了 429（与上游限流语义区分开：本地是 `busy`）。
- `opencode.log` 超 5MB 轮转为 `opencode.log.previous`。

## 11. 免费目录的判定顺序（两条链路不同）

**v1**（`freeModels`）：`cost.input === 0 && cost.output === 0 && cache.read === 0 &&
cache.write === 0` 且 `capabilities.output.text !== false` 且 `status !== 'deprecated'`。

**v2**（`v2FreeModels`）：`providerID === 'opencode'` 且未废弃未禁用，且**任一** cost
档位四项皆 0，且 `capabilities.output` 数组含 `'text'`。

两条都**必须**再经过一道"文本输出"判定：免费但只能出图像/音频的模型进列表就是坑。

## 12. 失败分类为什么与 opencode2pi 不同

Zen 直连有 `SHAPE_REJECTED` / `AUTH`（403/401 的几种来源），本机链路**不存在**这两种形态；
取而代之的是 `RUNTIME_MISSING`——opencode CLI 缺失、serve 未就绪、本地代理不可达，
这三者在直连方案里根本不存在。

401/403 默认是**本地代理自己**的两种拒绝（令牌不匹配 / 浏览器 Origin），
归入 `UNKNOWN` 并在 summary 里写明"内部错误"，否则用户会去查根本用不到的 API key。

**但 403 不是只有这两种。** 实测 2026-10-06：`oc-fledge-alpha-free` 返回
`HTTP 403 · This model is not available in your country`——地区封锁来自 Zen 上游，
经本地链路透传上来。最初的判断（本链路不存在地区封锁，因此删掉 `REGION_BLOCKED`）
是错的，已加回：判定顺序里它排在最前，因为它和本地 403 撞同一个状态码。
## 13. 免费名单复测（两条通道对照）

同一批免费模型，两条通道各测一次，结论并不一致——这是"只标注不隐藏"这条规则的直接依据。

| 模型 | Zen 直连（2026-10-08，opencode2pi） | 本地链路（2026-10-06，本项目） |
| --- | --- | --- |
| `big-pickle` / `mimo-v2.6-flash-free` / `nemotron-3.5-lightning-free` | ✅ 200 | ✅ |
| `space-bunny-free` / `longcat-2.5-preview-free` / `ling-3.1-flash-free` | ✅ 200 | ✅ |
| `fledge-alpha-free` | ✅ 200 | ❌ 403 地区封锁 |
| `muse-spark-1.2/1.3-contributor-free` | ❌ 403 地区封锁 | ✅（1.3） |
| `nemotron-3-ultra-free` | 401 `ModelError` | ✅ |
| `ling-3.0-flash-fin-free` / `exo-free` | 400 / 503 `Endpoint is unavailable`（判为上游抖动，保留） | ❌ 400 同上 |
| `mimo-v2.5-free` | 401 且已从 `/models` 消失 → 下线 | 不在本机目录里 |

两条结论值得记住：

1. **地区封锁与 401 都随出口和时间变化。** 同一个模型在两条通道上一条被封锁、一条正常。
   所以任何"某模型永久不可用"的判断都必须由**当前出口**的探测得出，跨通道照抄结论
   会误伤——这正是本项目把健康状态做成标注而非删除的直接原因。

2. **`Endpoint is unavailable` 是上游抖动，不是模型拒绝输入。** 400 与 503 都出现过这条
   文本，且过几分钟就恢复。它归到 `REQUEST_REJECTED`（⚠️）是状态码优先的产物，
   保留在目录里是正确的处理。

另有一条只对 `opencode2pi` 成立、**本项目不适用**的教训：它的 `UNAVAILABLE` 名单里
`nemotron-3.ultra-free`（点）拼错，真实 id 是连字符，于是这条 denylist 静默空转。
本项目的模型 id 全部来自本机 OpenCode 目录，没有任何手写 id，不存在这类拼写风险。

## 14. 交互能力实测（omp 18.6.1）

`ExtensionUIContext` 提供的交互原语，比"只有 notify"多得多：

| API | 可用 | 说明 |
| --- | --- | --- |
| `ctx.ui.notify(message, type)` | ✅ | `info` → 状态行，`warning` / `error` 各自样式。**它不是 toast，是写进对话区的行**，所以逐条调用就是逐条输出 |
| `ctx.ui.select(title, options)` | ✅ | 返回选中的 `label`（取消返回 `undefined`）。选项带 `description` |
| `ctx.ui.confirm(title, message)` | ✅ | 布尔确认 |
| `ctx.ui.input(title, placeholder)` | ✅ | 文本输入 |
| `ctx.ui.setWorkingMessage(text)` | ✅ | 页脚一行进度；传 `undefined` 清除 |
| `ctx.ui.setWidget(key, string[])` | ✅ | 编辑器上方的常驻面板，可反复重绘 |

**唯一的边界是 `ctx.hasUI`**：打印模式（`-p`）下为 `false`，`select` / `confirm` 不可用，
必须提前判断并直接返回，不要让无头运行挂在一个没人能看的对话框上。

本项目据此做了两件事：`probe` 用 `notify` 逐条实时输出（而不是等全部结束），
`filter` 用 `select` 询问是否隐藏模型。**过滤只能是用户的选择**——同一条通道上
`fledge-alpha-free` 与 `muse-spark-1.3-contributor-free` 在两台机器上分别是
"被封锁"和"正常"，自动规则有一半时间是错的。
