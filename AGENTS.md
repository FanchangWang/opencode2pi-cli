# AGENTS.md

给接手 `opencode2pi-cli` 的 AI。**动手前先读完本文件。**

---

## 这是什么

一个 omp/pi 扩展：把 **OpenCode Zen 的免费模型池**暴露成一个原生 provider，
数据通路是

```
omp / pi 进程
  └─ 本扩展
       ├─ spawn 隔离的 `opencode serve`（本机 CLI，随宿主生命周期起停）
       └─ 起一个 127.0.0.1 的 OpenAI 兼容服务 → registerProvider('opencode-zen-cli')
```

两个宿主共用这条通路，差异只在 `src/host.ts` 一处（对照表见
[`docs/FINDINGS.md`](docs/FINDINGS.md) §16）。

用户不需要 API key、不需要另开终端、不需要改任何配置文件。**不写 `models.yml`**。

代码大部分是 [`opencode-omp-bridge`](https://github.com/FanchangWang/opencode-omp-bridge)
（独立进程版）的逐段移植，改的是编排层。移植时**不要**顺手"简化"协议层——那里每一条
分支都对应一个上游实际发生过的故障。

---

## 先读这两份

| 顺序 | 文件 | 为什么 |
| --- | --- | --- |
| 1 | [`docs/FINDINGS.md`](docs/FINDINGS.md) | **实测结论，不要重新推导**：宿主扩展 API 的真实行为、Windows 停机的坑、协议层易错点 |
| 2 | [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md) | 架构、模块地图、设计决策的理由、发布流程 |

只想**用它**看 [`README.md`](README.md) 就够了。

---

## 改代码前必须知道的事

都是实测踩出来的，**不要凭直觉推翻**：

1. **`registerProvider` 是排队生效的**，会话初始化时才应用。所以工厂必须是 `async`，
   且必须在本地服务 `listen` 之后拿真实 `baseUrl` 再注册。

2. **重复注册同名 provider 会整体替换该 provider 的全部模型**——这是探测结论写回
   `supportsTools: false` 和过滤生效的**唯一**机制（`index.ts` 的 `publishRoster()`
   再调一次即可）。不是"合并"。但 `models` 为空数组时宿主整段跳过（`model-registry.ts:3205`），
   所以隐藏完全部模型时要 warn 而不是假装生效。

3. **不要注册 `fetchDynamicModels`**。模型表在启动时从本地 opencode 目录读出，
   宿主 24h 动态缓存只会把它藏起来。

4. **`supportsTools` 不在扩展侧 `ProviderModelConfig` 的类型声明里**，但注册表的
   自定义模型构造器确实会读它。`src/provider.ts` 里显式声明了
   `ProviderModelDefinition extends ProviderModelConfig` 来补这个字段（pi 侧的
   `thinkingLevelMap` 同理补在这里）——别删，也别改成 `any`。

5. **`Effort` 是 `@oh-my-pi/pi-catalog` 的 `const enum`**，普通字符串赋不过去。
   `provider.ts` 里那一处 `as unknown as readonly EffortLevel[]` 是有意的。

6. **Windows 上 `shell: true` spawn 出来的 cmd.exe wrapper 必须用 `taskkill /T /F` 杀**。
   `child.kill('SIGTERM')` 只会结束 wrapper，把真正的 `opencode serve` 留成孤儿——
   而且 wrapper 已退出后 `child.exitCode !== null`，任何"还活着才 taskkill"的后续判断
   都不会触发。`runtime.ts` 的 `stop()` 与 `killTree()` 就是为此存在，别改回信号。

7. **`session_shutdown` 每个会话都会触发**，包括 task/eval/advisor 子会话。
   omp 侧必须先过滤 `agent.kind === 'main'`，否则第一个退出的子代理就会拆掉父会话的服务；
   这条判定在 `src/host.ts` 的 `isMainSession()` 里，别在 `index.ts` 里再写一遍。
   （pi 侧没有 `agent`，但它的 shutdown 每次都伴随会话替换 = 工厂重跑，见 FINDINGS §16。）

8. **探测可能长达数分钟，绝不能放在启动路径上。** 启动只做：定位 → 拉起 → 就绪 →
   读目录 → listen → 注册。探测由斜杠命令驱动。

9. **一次失败不能判死模型。** 连续两次 `MODEL_GONE` 才升级 ❌，任何一次成功清零。
   同理，`RATE_LIMIT` 不是对模型的判决（上游按模型计费），单列 🚧。唯一的例外是
   `REGION_BLOCKED`：同一出口下（地区封锁，或上游拒绝该出口 IP 的
   `abusive traffic`）封锁是确定性的，一次即判死——它判的是**出口**，换出口必须重测
   （见 FINDINGS §17）。

10. **隐藏模型必须由用户选择。** `filters.json` 里只有两个开关，都默认为关；
    配额耗尽（`RATE_LIMIT`）与本地链路故障（`RUNTIME_MISSING`）**永远不隐藏任何模型**——
    那是通道的状态。规则集中在 `src/filters.ts` 的 `MODEL_VERDICTS`，别在别处再写一遍。

11. **工具轮最多试两次才判定"仅对话"。** 实测 `oc-big-pickle` 在相邻两轮探测里一次给出
    合法动作调用、一次去执行本地工具；单次即降级会让能用的模型白丢工具。

12. **`status` 读 store，不重探；只有它从没有记录过的模型是当场补测。** 结论超过 6 小时
    （`HEALTH_TTL_MS`）只在行尾标 `（已过期）` 并提醒跑 `probe`——全量探测要几分钟真实
    推理，该由用户发起。`status` 与 `probe` 的差别只在事后动作：只有 `probe` 询问过滤。

13. **上下文窗口的本地覆盖只写在 `src/provider.ts` 的 `LOCAL_MODEL_OVERRIDES`**（当前只有
    `oc-mimo-v2.6-flash-free` → 1048576，理由与回退方法见 `docs/FINDINGS.md` §15）。注册表与
    本地代理的 `/v1/models` 两处都必须经 `publishedContextWindow()` 取值，别在别处再写一遍；
    每次生效写一条 note 并由 `applyProvider` 记进日志，不静默。

14. **两个宿主（omp / pi）的扩展 API 差异只写在 `src/host.ts`。** pi 1.3.0 没有 `logger`、
   上下文里没有 `agent`、`ui.select` 只收字符串、模型 thinking 从 `thinking` 换成
   `thinkingLevelMap`，也没有 `supportsTools` 字段（逐项对照与出处见
   `docs/FINDINGS.md` §16）。判别器只有一条：**API 对象上有没有 `logger`**——
   别去嗅探版本号，也别在调用方写 `if (是 pi)`；一律走 `host()`。
   代价要说清：pi 上"仅对话"结论写不回模型表，`applyProvider` 会 warn 而不是假装生效。

---

## 项目地图

```
src/
  index.ts         扩展入口：注册 provider / 命令 / session_start / session_shutdown
  host.ts          宿主适配层：omp 与 pi 的扩展 API 差异（logger / 扩展名 / 主会话判定 /
                   菜单选项形状 / 模型 thinking 投影 / supportsTools 是否生效）
  runtime-host.ts  进程内生命周期：引用计数、状态广播、就绪编排
  runtime.ts       定位 CLI、隔离 env、拉起 serve、就绪轮询、停机
  server.ts        本地 OpenAI 兼容服务（/v1/models、/v1/chat/completions）
  backend.ts       OpenCode 协议层：v1/v2 分支、信封、审批闸门、修正循环
  protocol.ts      请求编解码、信封校验、SSE 输出
  handoff.ts       原生动作 → 外部工具调用的交接表
  repair.ts        畸形信封的二次翻译（correction → translate → resend）
  provider.ts      目录 → omp 模型表的逐字段投影
  health.ts        逐模型探测、判定规则、落盘
  errors.ts        失败分类（本机链路语义，与 Zen 直连不同）
  filters.ts       隐藏开关的读写（filters.json，两个开关默认全关）
  doctor.ts        五项体检
  commands.ts      /opencode2pi-cli 三条命令与 TUI
  probe.ts         探测原语（工具调用探测体）
  platform.ts      数据目录（含 OPENCODE_ZEN_CLI_DATA_DIR 覆盖）
  system-proxy.ts  系统代理读取（win32 注册表 / macOS scutil）
  atomic.ts        Windows 下的原子写
  json.ts          去 BOM 的 JSON.parse
  reasoning.ts     reasoning effort → OpenCode variant 映射
  model-status.ts  请求结果记录
test/
  atomic / platform / system-proxy / repair   移植自 bridge
  provider / errors / health / lifecycle       本项目新增
  host                                         omp/pi 判别、菜单折叠、日志缓冲
```

`backend.ts`（~950 行）是移植量最大的一块，**逐段对应 bridge 的同名文件**。

---

## 验证

改完代码，下面三条全绿才算完成（都在**仓库根目录**执行）：

```sh
npm run typecheck                     # tsc --noEmit
bun test                              # 70 项
omp -p --model opencode-zen-cli/oc-space-bunny-free "Reply with exactly OK"

# 工具调用链路（handoff + repair 全程）
omp -p --model opencode-zen-cli/oc-space-bunny-free \
  "用 bash 工具列出当前目录的文件，只回显命令输出"
```

**冒烟一律带 `OPENCODE_ZEN_CLI_PROXY=0`**（或先确认当前出口没被 Zen 拒）：本机系统代理
`192.168.31.50:7890` 的出口会让免费池全部回"abusive traffic from this IP"，
那是**出口**的属性，不是项目故障（FINDINGS §17）。

改的是本地源码、还没装进宿主时，用 `-e` 直接加载当前工作区，两个宿主都支持：

```sh
omp -p --no-session --no-extensions -e ./src/index.ts --model opencode-zen-cli/oc-space-bunny-free "Reply with exactly OK"
pi  -p --no-session -ne            -e ./src/index.ts --model opencode-zen-cli/oc-space-bunny-free "Reply with exactly OK"
```

pi 侧改了什么（`host.ts`）就必须这样跑一遍：它的模型投影和 omp 不是同一个键
（FINDINGS §16），只有真跑才说明注册没被 schema 拒。

期望：类型检查干净、单测全过、第一条输出恰好 `OK`、第二条列出真实文件。

改了 `runtime.ts` 或 `runtime-host.ts` 的启停路径，还要额外确认**不留残留进程**：

```sh
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='opencode.exe'\" | Select-Object ProcessId"
```

（用户自己可能开着 `opencode serve --service`，那是无关进程。）

`/opencode2pi-cli doctor` 与探测（`status` 的补测、`probe`）需要交互式 TUI；打印模式下
`status` 照常打印已有结论并点名哪些模型没探测过，`probe` 直接提示不可用。
要无头验证 doctor，直接 `import { runDoctor } from './src/doctor.ts'` 跑即可。

---

## 发布

打 `vX.Y.Z` tag，`.github/workflows/release.yml` 自动：校验 tag 与版本一致 →
`npm ci` → typecheck → test → **校验 tarball 的 `src/` 与仓库一致（双向比对，从 `src/` 派生，
不再手写清单）** → `npm publish` → GitHub Release → 移动 `stable` ref。

一次 publish 同时服务 pi 和 omp（两者都从 npm 解析）。认证二选一：配了
`NPM_TOKEN` secret 走 token；没有则走 OIDC Trusted Publishing。release 始终产出
（`if: always()`），因为两个宿主都能从 git ref 安装。

**首发只能用 token**：包必须先存在，Trusted Publisher 的 Settings 页才有得配。
v0.3.0（2026-10-11）用 token 首发成功，v0.3.1 起改走 OIDC Trusted Publishing，
仓库不再持有长期凭据（`gh secret list` 为空；v0.3.1 与 v0.3.2 的 `Publish to npm`
步骤都打印 `No NPM_TOKEN; using OIDC trusted publishing.`，可回查运行日志核实）。
完整迁移步骤见 `docs/DEVELOPMENT.md` §12.1。

本机全局 registry 是 npmmirror，**不要改**。所有 npm 操作用脚本显式指定官方源：
`npm run whoami` / `npm run dry-run` / `npm run release:check`，
其余命令走 `npm run registry <cmd>`。

---

## 明确不要做

- ❌ 写 `~/.omp/agent/models.yml`（这是本项目存在的核心区别）
- ❌ 改用户的 `config.yml`（旧 `opencode-zen/...` 引用由用户自己迁移）
- ❌ 把探测挪进启动路径
- ❌ **自动**用健康状态过滤模型列表（只标注；隐藏与否是用户的决定，由 `filter` 询问后落盘）
- ❌ 把 API key 落盘（它只在内存里，随进程消失）
- ❌ 在 `session_shutdown` 里漏掉 `kind === 'main'` 过滤
- ❌ 重写 `backend.ts` 的协议分支（先读 FINDINGS.md）