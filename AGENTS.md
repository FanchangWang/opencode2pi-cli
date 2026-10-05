# AGENTS.md

给接手 `opencode2pi-cli` 的 AI。**动手前先读完本文件。**

---

## 这是什么

一个 omp/pi 扩展：把 **OpenCode Zen 的免费模型池**暴露成一个原生 provider，
数据通路是

```
omp 进程
  └─ 本扩展
       ├─ spawn 隔离的 `opencode serve`（本机 CLI，随 omp 生命周期起停）
       └─ 起一个 127.0.0.1 的 OpenAI 兼容服务 → registerProvider('opencode-zen-cli')
```

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
   `supportsTools: false` 的机制（`applyProvider` 再调一次即可）。不是"合并"。

3. **不要注册 `fetchDynamicModels`**。模型表在启动时从本地 opencode 目录读出，
   宿主 24h 动态缓存只会把它藏起来。

4. **`supportsTools` 不在扩展侧 `ProviderModelConfig` 的类型声明里**，但注册表的
   自定义模型构造器确实会读它。`src/provider.ts` 里显式声明了
   `ProviderModelDefinition extends ProviderModelConfig` 来补这个字段——
   别删，也别改成 `any`。

5. **`Effort` 是 `@oh-my-pi/pi-catalog` 的 `const enum`**，普通字符串赋不过去。
   `provider.ts` 里那一处 `as unknown as readonly EffortLevel[]` 是有意的。

6. **Windows 上 `shell: true` spawn 出来的 cmd.exe wrapper 必须用 `taskkill /T /F` 杀**。
   `child.kill('SIGTERM')` 只会结束 wrapper，把真正的 `opencode serve` 留成孤儿——
   而且 wrapper 已退出后 `child.exitCode !== null`，任何"还活着才 taskkill"的后续判断
   都不会触发。`runtime.ts` 的 `stop()` 与 `killTree()` 就是为此存在，别改回信号。

7. **`session_shutdown` 每个会话都会触发**，包括 task/eval/advisor 子会话。
   必须过滤 `ctx.agent.kind === 'main'`，否则第一个退出的子代理就会拆掉父会话的服务。

8. **探测可能长达数分钟，绝不能放在启动路径上。** 启动只做：定位 → 拉起 → 就绪 →
   读目录 → listen → 注册。探测由斜杠命令驱动。

9. **一次失败不能判死模型。** 连续两次 `MODEL_GONE` 才升级 ❌，任何一次成功清零。
   同理，`RATE_LIMIT` 不是对模型的判决（上游按模型计费），单列 🚧。

---

## 项目地图

```
src/
  index.ts         扩展入口：注册 provider / 命令 / session_start / session_shutdown
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
```

`backend.ts`（~950 行）是移植量最大的一块，**逐段对应 bridge 的同名文件**。

---

## 验证

改完代码，下面三条全绿才算完成（都在**仓库根目录**执行）：

```sh
npm run typecheck                     # tsc --noEmit
bun test                              # 38 项
omp -p --model opencode-zen-cli/oc-space-bunny-free "Reply with exactly OK"

# 工具调用链路（handoff + repair 全程）
omp -p --model opencode-zen-cli/oc-space-bunny-free \
  "用 bash 工具列出当前目录的文件，只回显命令输出"
```

期望：类型检查干净、单测全过、第一条输出恰好 `OK`、第二条列出真实文件。

改了 `runtime.ts` 或 `runtime-host.ts` 的启停路径，还要额外确认**不留残留进程**：

```sh
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='opencode.exe'\" | Select-Object ProcessId"
```

（用户自己可能开着 `opencode serve --service`，那是无关进程。）

`/opencode2pi-cli doctor|status|probe` 需要交互式 TUI；打印模式下 probe 不可用。
要无头验证 doctor，直接 `import { runDoctor } from './src/doctor.ts'` 跑即可。

---

## 发布

打 `vX.Y.Z` tag，`.github/workflows/release.yml` 自动：校验 tag 与版本一致 →
`npm ci` → typecheck → test → **校验 tarball 含全部 11 个入口模块** → `npm publish`
→ GitHub Release → 移动 `stable` ref。

一次 publish 同时服务 pi 和 omp（两者都从 npm 解析）。认证二选一：配了
`NPM_TOKEN` secret 走 token；没有则走 OIDC Trusted Publishing。release 始终产出
（`if: always()`），因为两个宿主都能从 git ref 安装。

---

## 明确不要做

- ❌ 写 `~/.omp/agent/models.yml`（这是本项目存在的核心区别）
- ❌ 改用户的 `config.yml`（旧 `opencode-zen/...` 引用由用户自己迁移）
- ❌ 把探测挪进启动路径
- ❌ 用健康状态过滤模型列表（只标注，不隐藏）
- ❌ 把 API key 落盘（它只在内存里，随进程消失）
- ❌ 在 `session_shutdown` 里漏掉 `kind === 'main'` 过滤
- ❌ 重写 `backend.ts` 的协议分支（先读 FINDINGS.md）

---

## 当前状态

v0.1.0，omp 18.6.1 + `@opencode/cli` v2.0.23 实测通过（2026-10-06）：
单次推理、工具调用、doctor 五项、10 模型全量探测、进程零残留、`models.yml` 逐字节不变。