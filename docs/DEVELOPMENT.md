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

host.ts <── index.ts / commands.ts / provider.ts   （两个宿主的差异全在这里）
```

- **无环**：`runtime-host` 只 type-import `health`，`health` 不 import `runtime-host`
  （探测所需的 endpoint/key 由调用方作为参数传入）。
- **宿主差异只有一个出口**：`host.ts` 是全项目唯一碰宿主专有 API 的地方——`logger`、
  扩展名（`setLabel`）、主会话判定、菜单选项形状、模型 thinking 投影、
  `supportsTools` 是否生效。它不 import 本项目任何模块，所以谁都能依赖它而不成环；
  新增一处宿主差异时改这里，**不要**在调用方写 `if (是 pi)`（逐项对照见
  [`FINDINGS.md`](FINDINGS.md) §16）。
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
| `thinking` / `thinkingLevelMap` | 仅当目录里存在 effort 档位时写；升序、**排除 `none`**、`defaultLevel` 取最弱档。omp 落成 `thinking: {mode:'effort',…}`，pi 落成 `thinkingLevelMap`（档位名到档位名），由 `host.ts` 的 `modelProjection()` 分叉 |
| `input` | `images === true ? ['text','image'] : ['text']` |
| `supportsTools` | `toolcall === true && !chatOnly.has(id)`。**只有 omp 带这个键**：pi 的模型配置里没有工具能力字段，所以 pi 上"仅对话"结论写不回去，`applyProvider` 为此出一条 warn 而不是假装生效 |
| `cost` | 四项恒为 0（免费池） |
| `contextWindow` | `m.input ?? m.context`，非正整数回落 `128000`；`oc-mimo-v2.6-flash-free` 与 `oc-deepseek-v4.1-flash-free` 由本地覆盖改写为 `1048576`（见下） |
| `maxTokens` | `m.output`，非正整数回落 `8192` |

**本地覆盖（`LOCAL_MODEL_OVERRIDES`）**：feed 发布值与模型卡/官方配置/实测冲突时以审计值为准，
目前有两条：`oc-mimo-v2.6-flash-free`（200000 → 1048576）与
`oc-deepseek-v4.1-flash-free`（200000 → 1048576，免费 id 与付费 twin 的 1000000 不一致，
上游在 1,011,668 tokens 处实测召回；`maxTokens` 仍是 feed 的 32000）。理由与回退方法见
[`FINDINGS.md`](FINDINGS.md) §15。覆盖经 `publishedContextWindow()` 一个函数取值，注册表
与 `/v1/models` 两处都用它——只改一处会让两个数字互相矛盾，而 omp 读窗口以列表为准。每次
生效写一条 note，由 `applyProvider` 记进日志：看不见的覆盖等于无法回滚的覆盖。feed 自己
改为 1048576 后条目自动停火，留作回归护栏。

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
- 存储 `<dataDir>/health.json`（跨会话保留，供过滤集计算与跨次判死计数使用）；
  **只标注不隐藏**——模型永远留在目录里。
- `status` 展示 store 里最近一次探测的结论，**只对从未探测过的模型（含目录新增的）当场补测**；
  超过 6 小时的结论只标注 `（已过期）` 并提醒跑 `probe`，不自动重测——全量探测要几分钟真实
  推理，是用户的调用。`probe` 才做全量重探并询问过滤。
- 探测结束有两处结论要写回注册表：`chatOnly`（`supportsTools: false`）与隐藏集。
  `publishChatOnly()` / `publishHealth()` 都返回"注册表里的列表是否真的变了"，
  任一为真就 `refreshProvider()`。

## 7. 谁来决定隐藏（`filters.ts`）

默认一个都不隐藏。探测结束后弹一次选择（`/opencode2pi-cli filter` 可随时改），存进
`<dataDir>/filters.json`。

可隐藏的失败只有 `MODEL_GONE` / `REGION_BLOCKED` / `REQUEST_REJECTED` / `UPSTREAM`——
这四类是模型自己的问题。**`RATE_LIMIT` 与 `RUNTIME_MISSING` 永不可隐藏**：
实测同一分钟里一个模型 429、邻居全部 200；本地服务没起来时更没有任何模型该被隐藏。
隐藏只影响注册表里的模型行，`status` 仍然列出全部。

隐藏集由 `runtime-host` 单点推导（`hiddenFromStore`），**只有一处**：启动时按
`filters.json` + `health.json` 算出来，改过滤时重算，探测后按新判决重算。
两处曾经各错一次：启动只读了开关没推导隐藏集（注册的是全量列表，却报告"过滤已生效"），
以及重选同一项时被判为"没变化"而不再注册。

写回注册表的唯一通道是 `index.ts` 的 `publishRoster()`：`registerProvider` 传同名
provider 会整体替换它的模型列表，这是唯一能到达 `/model` 的机制。**但传空数组会被
宿主整段跳过**（`model-registry.ts:3205`），所以隐藏完全部模型时它会 warn 而不是
假装生效。

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

## 10. 宿主契约：三处硬约束 + 两套 API

omp 侧的三处硬约束：

1. 工厂必须 async（`registerProvider` 排队生效）。
2. 同名重复注册 = 整体替换（这是写回机制，不是 bug）。
3. `ProviderModelConfig` 没有 `supportsTools`，但注册表会读 —— 在 `provider.ts` 的
   `ProviderModelDefinition` 里补声明。

`thinking.efforts` 的元素是 `const enum Effort`，字面量字符串赋值会被编译拒绝，
`provider.ts` 的 `EFFORT_ORDER` 是 omp 这一侧的唯一起点（pi 那一侧对应
`host.ts` 的 `modelProjection`）。

**但 pi 不是同一套 API**：它没有 `logger`、上下文里没有 `agent`、`ui.select` 只收字符串、
模型 thinking 叫 `thinkingLevelMap`、也没有 `supportsTools`。这些差异全部由 `host.ts`
吸收，调用方一律走 `host()`；判别器只有一条——**API 对象上有没有 `logger`**。
逐项对照与出处见 [`FINDINGS.md`](FINDINGS.md) §16。

## 11. 验证

```sh
npm run typecheck && bun test
omp -p --model opencode-zen-cli/oc-space-bunny-free "Reply with exactly OK"
omp -p --model opencode-zen-cli/oc-space-bunny-free "用 bash 工具列出当前目录的文件，只回显命令输出"
```

改的是工作区、还没装进宿主时用 `-e` 直接加载（两个宿主都支持），pi 侧改完必须这样跑一遍——
它的模型投影键和 omp 不同，只有真跑才说明注册没被 schema 拒：

```sh
omp -p --no-session --no-extensions -e ./src/index.ts --model opencode-zen-cli/oc-space-bunny-free "Reply with exactly OK"
pi  -p --no-session -ne            -e ./src/index.ts --model opencode-zen-cli/oc-space-bunny-free "Reply with exactly OK"
```

冒烟带上 `OPENCODE_ZEN_CLI_PROXY=0`：本机系统代理的出口目前被 Zen 拒，
免费池会整片回"abusive traffic from this IP"，那是出口的属性（`FINDINGS.md` §17）。

改了启停路径还要确认没有残留 `opencode.exe`（见 [`FINDINGS.md`](FINDINGS.md) §4）。

测试分工：

| 文件 | 覆盖 |
| --- | --- |
| `atomic` / `platform` / `system-proxy` | 平台差异（Windows 共享冲突、代理地址解析） |
| `repair` | 完整走一遍「correction → translate → resend」，用假 `request` 驱动 |
| `provider` | 免费判定（v1/v2 各四种淘汰条件）+ 逐字段投影 |
| `errors` | 表驱动分类，含 401/403 的本地语义 |
| `health` | 两次才判死、成功清零、剪枝、汇总顺序 |
| `lifecycle` | 引用计数、失败不记忆、子代理不触发停机 |
| `host` | omp/pi 判别、菜单 description 的折叠与还原、无 logger 宿主的日志缓冲与回放 |

## 12. 发布

```
vX.Y.Z tag → release.yml
  校验 tag/版本一致 → npm ci → typecheck → test
  → 校验 tarball 的 src/ 清单与仓库双向一致 → npm publish → GitHub Release → stable ref
```

- 无构建步骤：包只含 `src/` 的 TypeScript 源码，由宿主加载。
- 双 manifest（`pi.extensions` + `omp.extensions`）指向同一个入口。
- `actions/setup-node` 用 v7 且关掉 `package-manager-cache`：缓存步骤会往 `.npmrc`
  里写内容，可能污染 OIDC 认证。首次发布走 token 时无害，切到 OIDC 后它是唯一的
  认证路径，那时才是真风险。
- 认证二选一：`NPM_TOKEN` 或 OIDC Trusted Publishing；release 用 `if: always()`
  保证即使 publish 失败也产出，因为两个宿主都能从 git ref 装。
- 新增 `src/*.ts` 后**不必**再改 `release.yml`：tarball 断言已改为从 `src/` 派生
  （`find src -name '*.ts'`）再与 `npm pack` 的清单双向比对——少一个文件与多一个文件
  都算失败，空清单另有非空护栏。`npm pack` 成功不代表打包内容正确，只有比对才说明得了；
  而手写清单在新增模块的当天就会过期。

### 本机 registry 固定用官方源，但不改全局配置

开发机全局 registry 是 `registry.npmmirror.com`（国内镜像），**刻意不改**：
换掉会影响本机其它项目的依赖安装。本包所有 npm 操作一律用参数显式指定官方源，
并固化成脚本，省得每次手打：

```sh
npm run whoami         # npm --registry=https://registry.npmjs.org/ whoami
npm run dry-run        # 打包预演，发布前必看
npm run release:check  # typecheck + test + dry-run 三合一
npm run registry <cmd> # 其余命令：npm run registry login / publish / view …
```

CI runner 默认就是 `registry.npmjs.org`，无需处理。

### 首次发布：只能用 token，且已走完（v0.3.0，2026-10-11）

v0.1.0 / v0.2.0 / v0.2.1 三次发版的 `Publish to npm` 全部挂在 `ENEEDAUTH`：
仓库没有 `NPM_TOKEN` secret，而 `opencode2pi-cli` 在 npmjs.com 上还不存在
（`curl https://registry.npmjs.org/opencode2pi-cli` → 404），**没有包就没有
Settings 页，配不了 Trusted Publisher**。这不是配置错误，是顺序问题。

所以首发这一步只能靠 token。v0.3.0 补上 secret 后一次跑通：workflow 12 步全绿，
`opencode2pi-cli@0.3.0` 已上线，带 SLSA provenance，`stable` ref 同步前移。

验证首发是否真的上去了（`npm view` 走缓存且 registry 有几十秒同步延迟，
查证要直接读原始数据）：

```sh
curl -s https://registry.npmjs.org/opencode2pi-cli | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log(Object.keys(j.versions),j['dist-tags'])})"
```

首发时 npm 会先建一个 `0.0.0-stage` 占位版本、真实版本稍后异步落地，
期间 `latest` 指向占位符。这**不是** staged publishing 卡住，也不需要人工
promote，等几十秒即可。

### 12.1 从 token 迁到 Trusted Publishing（OIDC）

token 是**能用但要自己保管**的长期凭据：它躺在 GitHub secret 里，泄露了要手工吊销，
还要防 CI 日志意外打印。OIDC（Trusted Publishing）里 CI 用**一次性短期凭据**，
由 GitHub 的 OIDC token 换取，没有可泄露的长期密钥，还能自动生成 provenance。
两者产出的包完全一样，差别只在认证方式。

**前提：包已经存在**（所以 §12 的首发必须先成功）。v0.3.1（2026-10-11）已按下面
配好并验证通过，以下步骤留作下次换包或换仓库时复用。

1. https://www.npmjs.com/package/opencode2pi-cli/settings/access 页面
2. 找到 **Trusted Publisher**（部分账号在 **Settings → Trusted Publisher**）
3. **Organization**：`FanchangWang`
4. **Repository**：`FanchangWang/opencode2pi-cli`
5. **Workflow filename**：`release.yml`
   ⚠️ 填**文件名即可，不要填 `.github/workflows/release.yml`**。填错不会报错，
   只在发布那一刻报权限错
6. 勾选 **Allow npm publish**（**必须勾**）

配好后删 secret，workflow 就会自动改走 OIDC，**workflow 文件不用改任何一行**：

```sh
gh secret delete NPM_TOKEN
```

**v0.3.1 已完成这一步**：Trusted Publisher 配好后删掉 secret，workflow 日志里
`Publish to npm` 打印的是 `No NPM_TOKEN; using OIDC trusted publishing.`，
provenance 由 npm 自动生成。**仓库现在不持有任何长期凭据。**

**token 是要长期保管的资产，不要提交进仓库、不要贴进聊天工具。**

### OIDC 常见故障对照

| 现象 | 原因 | 处置 |
| --- | --- | --- |
| `npm <11.5.1 cannot use OIDC` | runner 的 npm 太老 | workflow 已提前拦截并明确报错；升级 setup-node 的 node-version |
| `E401/E403 Unauthorized` | Trusted Publisher 的 org / repo / workflow 名填错 | 回上一步逐字核对，**workflow 只填文件名** |
| 明明配了却仍走 token | secret 还没删 | `gh secret delete NPM_TOKEN` 后重推 tag |
| provenance 徽章没出现 | 走了 token 分支且未加 `--provenance` | 迁到 OIDC 后由 npm 自动生成，无需手工加 |
| `npm view` 只看到 `0.0.0-stage` | 首发占位符，真实版本异步落地中 | 等几十秒；**不是** staged 卡住，不要去 promote |
| npm 页面 README 还是旧的 | npm 只在 publish 时刷新 README | 再发一版；`npm view` 有缓存，直接读 registry 原始 JSON |

### 其它

- **npmjs.com 的 README 不会跟着 GitHub 自动更新**：npm 只读你 publish 的 tarball
  里那份 README，所以改完仓库 README 也要**再发一版**才同步到 npm 页面。
- 宿主**不支持**直接安装 `.tgz`（实测报 `package.json not found`）。支持的源是：
  npm spec、git ref、`https://` 仓库地址、本地目录。所以 release 里的 tarball 附件
  只作存档，不是安装路径。

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