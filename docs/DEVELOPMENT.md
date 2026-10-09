# DEVELOPMENT — 架构与设计

面向改代码的人。只想用它看 [`../README.md`](../README.md)；只想接手看
[`../AGENTS.md`](../AGENTS.md) 与 [`FINDINGS.md`](FINDINGS.md)。

---

## 1. 为什么是「插件」而不是独立进程

前身 `opencode-omp-bridge` 是一个独立 Node 进程：它拉起 `opencode serve`、开本地 HTTP
服务、然后**改写 `~/.omp/agent/models.yml`** 把 provider 注入进去。代价有三个：

1. 用户要另开一个终端，并且知道它还活着；
2. 用户要手动删配置，忘了删就会留下一个指向已死端口的死 provider；
3. 桥接进程和 omp 是两个生命周期，任一方崩溃另一方还在等。

插件形态把这三件事都消掉了：`registerProvider` 在内存里注册模型表，`session_shutdown`
负责停机，用户看到的是一个正常的 omp 扩展。

代价是**必须 async 工厂**：`registerProvider` 排到会话初始化才生效，所以要先把本地服务
`listen` 了、拿到真实端口，再注册。这是整个入口唯一的设计约束，其余都还是原来的东西。

## 2. 模块地图与依赖方向

```
index.ts ──> runtime-host.ts ──> runtime.ts ──> backend.ts ──> protocol.ts
     │             │                                  │            ↑
     │             ├──> server.ts ────────────────────┘            │
     │             ├──> health.ts ──> probe.ts ──> errors.ts        │
     │             └──> provider.ts ──> reasoning.ts                 │
     └──> commands.ts ──> doctor.ts                                 │
                                        repair.ts <─────────────────┘
                                        handoff.ts
```

- **无环**：`runtime-host` 只 type-import `health`，`health` 不 import `runtime-host`
  （探测所需的 endpoint/key 由调用方作为参数传入）。
- **平台/协议/投影三层分离**：`platform` + `system-proxy` + `atomic` + `json` 是可独立
  测试的纯工具；`protocol`/`backend`/`handoff`/`repair` 是协议层，与 omp 无关；
  `provider` 是唯一的"把协议层翻译成宿主契约"的地方。
- **`commands`/`doctor` 只读 `runtime-host` 暴露的函数**，不碰模块内部状态。

## 3. 启动编排（`runtime-host.ts` 的 `boot_`）

严格顺序，任何一步失败都把 `phase` 置为 `error` 并把原因交回调用方：

1. 建数据目录（`0o700`）
2. 决定是否走系统代理（`OPENCODE_ZEN_CLI_PROXY` > `settings.json` > 平台默认）
3. `locateOpencode()` —— 找不到就报"未找到可用的 OpenCode"并列出试过的候选
4. `startBackend()` —— 拉起隔离的 `opencode serve` 并等就绪（上限 60s）
5. 确认 `buddy-bridge` agent 存在（v2 轮询 120 × 500ms）
6. 读免费目录：优先实时，失败回落 `models-cache.json`
7. `listen`：默认 `41980`，被占用则退让到系统分配端口（显式指定端口时不退让）
8. `phase = 'ready'`，广播 `endpoint`

**探测不在这条路径上**。它可能跑几分钟，放进启动就是拿 omp 的启动速度换一个可有可无的
结论。

## 4. 引用计数（`createLifecycle`）

- 每个 main 会话 `acquire()` 一次；并发调用共享同一个 boot promise。
- 启动失败**不记忆**：下一次 `acquire` 从头再来，而不是继承一个死句柄。
- `release()` 归零才停机；多释放不会重复执行 teardown。
- 单独抽出 `createLifecycle(start)` 就是为了让这段逻辑能被假实现直接测
  （`test/lifecycle.test.ts`）。

## 5. 模型表投影（`provider.ts`）

`freeModels` / `v2FreeModels` 产出目录条目，`toProviderModels` 逐字段映射：

| 字段 | 规则 |
| --- | --- |
| `id` / `name` | 原样（保留 `oc-` 前缀） |
| `reasoning` | `m.reasoning === true` |
| `thinking` | 仅当目录里存在 effort 档位时写；升序、**排除 `none`**、`defaultLevel` 取最弱档 |
| `input` | `images === true ? ['text','image'] : ['text']` |
| `supportsTools` | `toolcall === true && !chatOnly.has(id)` |
| `cost` | 四项恒为 0（免费池） |
| `contextWindow` | `m.input ?? m.context`，非正整数回落 `128000` |
| `maxTokens` | `m.output`，非正整数回落 `8192` |

**故意不注册 `fetchDynamicModels`**：目录在启动时已从本地服务读到，宿主 24h 动态缓存
只会让这份表变旧。

**不注册 `streamSimple`**：本地服务实现的就是标准 OpenAI 协议，让宿主内建引擎处理即可。

## 6. 探测与健康（`health.ts`）

- 走**本地服务**而不是直连 OpenCode：这样测到的就是 omp 会遇到的东西，
  `chatOnly` 也能直接从结论里读出来。
- 判定只有三档结果：`ok`（含 `chatOnly` 标记）、按 `errors.ts` 分类的失败。
- **带工具的请求最多试两轮**才判定"仅对话"：实测 `oc-big-pickle` 在相邻两轮探测里
  一次给出合法动作调用、一次去执行本地工具。单次即降级会让一个能用的模型白丢工具。
- 每次探测一次带工具的真实对话，单模型 60s 上限；并发 2、间隔 500ms
  （免费上游按模型计费，一次全放会挤掉自己的后续配额）。
- 存储 `<dataDir>/health.json`，TTL 6 小时；一次成功清零计数；
  **只标注不隐藏**——模型永远留在目录里。
- 探测结束若 `chatOnly` 变化，`runtime-host.publishChatOnly()` 返回 true，
  触发 `refreshProvider()` 重新注册 provider，把 `supportsTools: false` 写回注册表。

## 7. 谁来决定隐藏（`filters.ts`）

默认一个都不隐藏。探测结束后弹一次选择（`/opencode2pi-cli filter` 可随时改），存进
`<dataDir>/filters.json`，`publishFilters` 重算隐藏集并触发一次 `registerProvider`。

可隐藏的失败只有 `MODEL_GONE` / `REGION_BLOCKED` / `REQUEST_REJECTED` / `UPSTREAM`——
这四类是模型自己的问题。**`RATE_LIMIT` 与 `RUNTIME_MISSING` 永不可隐藏**：
实测同一分钟里一个模型 429、邻居全部 200；本地服务没起来时更没有任何模型该被隐藏。
隐藏只影响注册表里的模型行，`status` 仍然列出全部。

## 8. 失败分类（`errors.ts`）

判定顺序 = 判错的代价顺序（地区封锁排在最前，它和本地代理的 403 撞状态码）：

```
REGION_BLOCKED → RATE_LIMIT → MODEL_GONE → REQUEST_REJECTED → UPSTREAM → 本地令牌/来源 → RUNTIME_MISSING → UNKNOWN
```

- 429 优先于一切：配额头和模型下线可以同时出现在一段错误文本里，配方才是能操作的那条信息。
- 401/403 是**本地代理自己**的两种拒绝，不是上游对某个模型的判决。
- 每条 summary 都写清"是什么 + 怎么办"，中文，一句话。

## 9. 协议层为什么这么长

`backend.ts` 约 950 行，其中大部分是 v1/v2 双分支和错误恢复。它们看起来啰嗦，但每条都
对应一次真实故障——逐条清单见 [`FINDINGS.md`](FINDINGS.md) §8、§9。

移植原则：**不要重写，只改编排**。协议层的行为差异要么是上游变了（那时应该改并测），
要么就是 bug。

## 10. 宿主契约的三处硬约束

1. 工厂必须 async（`registerProvider` 排队生效）。
2. 同名重复注册 = 整体替换（这是写回机制，不是 bug）。
3. `ProviderModelConfig` 没有 `supportsTools`，但注册表会读 —— 自己在
   `provider.ts` 补声明。

`thinking.efforts` 的元素是 `const enum Effort`，字面量字符串赋值会被编译拒绝，
唯一交汇点在 `EFFORT_ORDER`。

## 11. 验证

```sh
npm run typecheck && bun test
omp -p --model opencode-zen-cli/oc-space-bunny-free "Reply with exactly OK"
omp -p --model opencode-zen-cli/oc-space-bunny-free "用 bash 工具列出当前目录的文件，只回显命令输出"
```

改了启停路径还要确认没有残留 `opencode.exe`（见 [`FINDINGS.md`](FINDINGS.md) §4）。

测试分工：

| 文件 | 覆盖 |
| --- | --- |
| `atomic` / `platform` / `system-proxy` | 平台差异（Windows 共享冲突、代理地址解析） |
| `repair` | 完整走一遍「correction → translate → resend」，用假 `request` 驱动 |
| `provider` | 免费判定（v1/v2 各四种淘汰条件）+ 逐字段投影 |
| `errors` | 表驱动分类，含 401/403 的本地语义 |
| `health` | 两次才判死、成功清零、TTL、剪枝、汇总顺序 |
| `lifecycle` | 引用计数、失败不记忆、子代理不触发停机 |

## 12. 发布

```
vX.Y.Z tag → release.yml
  校验 tag/版本一致 → npm ci → typecheck → test
  → 校验 tarball 含全部入口模块 → npm publish → GitHub Release → stable ref
```

- 无构建步骤：包只含 `src/` 的 TypeScript 源码，由宿主加载。
- 双 manifest（`pi.extensions` + `omp.extensions`）指向同一个入口。
- 认证二选一：`NPM_TOKEN` 或 OIDC Trusted Publishing；release 用 `if: always()`
  保证即使 publish 失败也产出，因为两个宿主都能从 git ref 装。
- 新增 `src/*.ts` 后要同步 `release.yml` 里的 tarball 断言列表，否则拼错文件要到用户
  首次执行命令时才会暴露。

### 现状：npm 尚未发布，`Publish to npm` 步骤注定失败

v0.1.0 的 `Publish to npm` 挂在 `ENEEDAUTH`：仓库没有 `NPM_TOKEN` secret，而
`opencode2pi-cli` 在 npmjs.com 上还不存在（`npm view opencode2pi-cli` → 404），
没有包可以配置 Trusted Publisher。

所以 **GitHub Release + `stable` ref 前移才是当前唯一有效的发版产物**，README 的安装
命令只给 git URL。要真正上 npm，必须先补一次 token 首发：

```sh
gh secret set NPM_TOKEN   # npm automation token，需对本包有 publish 权限
git tag -d v0.1.0 && git push origin :refs/tags/v0.1.0   # 版本号不可重用
git tag -a v0.1.1 -m "Release v0.1.1" && git push origin v0.1.1
```

此后 CI 才能走 OIDC。因为 workflow 里 publish 之后的步骤都带 `if: always()`，这个失败
不会挡住 Release 和 `stable` —— 但也意味着**没人盯着就会一直失败而无人察觉**，
排查发版问题时先看 `Publish to npm` 这一步的结论。

## 13. 从 bridge 移植时改了什么

| 位置 | 改动 |
| --- | --- |
| `cli.js` / `main.js` | 删除，由 `runtime-host.ts` + `index.ts` 取代 |
| `config-snippet.js` | 整体删除（不再写 models.yml） |
| `platform.js` | 删 `runtimePackage`；`APP_DIR` 改名 |
| `server.js` | 删 `/admin/probe`（探测改由斜杠命令驱动）；其余路由逐字保留 |
| `probe.js` | 逐字移植，被 `health.ts` 调用 |
| 停机 | Windows 改为按 pid 杀进程树（见 FINDINGS §4） |
| API key | 落盘文件 → 进程内存 |
| 单实例锁 / `status.json` | 删除（进程内无需） |
| 类型 | 全部 `any` → `unknown` + 类型守卫；外部数据一律守卫读取，不用内联断言 |