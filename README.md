# opencode-zen-cli

把 OpenCode Zen 的免费模型接进 [omp](https://github.com/oh-my-pi) 的一个原生插件。

整条链路跑在 omp 进程内部：插件定位本机的 `opencode` CLI → 拉起一个隔离的 `opencode serve` → 在 `127.0.0.1` 上开一个 OpenAI 兼容的本地服务 → 用 `registerProvider` 注册 provider `opencode-zen-cli`。**不再写 `models.yml`**，模型表只存在于内存里：卸载插件，provider 随之消失，不留任何残留文件。

> 这是 `opencode-omp-bridge` 的插件化版本：桥接协议、工具调用翻译链、修正循环都按原样移植，编排层换成了 omp 的生命周期。

---

## 安装

前置条件：本机已装 OpenCode CLI。

- v2：`npm i -g @opencode/cli`
- v1：`npm i -g opencode-ai`

确认 `opencode -v` 能输出版本号，然后：

```bash
# 本地开发（建立符号链接，改代码即时生效）
cd C:/Users/guyue/code/opencode2pi-cli
omp install .

# 或从 npm 安装
omp install npm:opencode-zen-cli
```

装完后**完全退出所有 omp 进程并重启**。启动时插件会自动拉起本地链路，通常几秒内完成；`session_start` 会给出就绪通知：

```
opencode-zen-cli 已就绪 · 10 个免费模型 · http://127.0.0.1:41980/v1
```

## 使用

```bash
omp --model opencode-zen-cli/oc-space-bunny-free
```

模型 id 一律带 `oc-` 前缀，来自 OpenCode 的免费模型目录。目录内容由上游决定，随 `/opencode-zen-cli status` 查看。

**不要用 `--provider`。** `--model` 接受 `provider/model` 形式，`--provider` 走的是另一条凭据解析路径，对这个插件没有意义。

### 模型列表出现在 `omp models` 里

`omp models` 会列出 `opencode-zen-cli` 及其当前目录中的全部模型。这是运行时的 `registerProvider` 生效的结果——它写的是模型注册表，不是 `models.yml`。模型数随上游目录变化，`status` 与 `omp models` 看到的始终是同一份表。

## 三条斜杠命令

| 命令 | 作用 |
|---|---|
| `/opencode-zen-cli doctor` | 逐项检查五个环节：opencode CLI、`opencode serve`、本地代理、免费模型目录、一次真实推理 |
| `/opencode-zen-cli status` | 列出全部模型及健康标记；记录过期时自动重新探测 |
| `/opencode-zen-cli probe` | 强制重探；被判定为「仅对话」的模型会写回模型列表，标记为不支持工具调用 |

不带参数执行 `/opencode-zen-cli` 会弹出三项菜单。

探测是真发请求（每个模型一次带工具的对话），整轮数分钟量级，结果写入 `<dataDir>/health.json`，6 小时内再次执行 `status` 直接读盘。**探测只在交互式 TUI 下可用**：打印模式（`-p`）没有进度对话框，直接提示而不挂起。

## 健康标记

| 标记 | 含义 | 建议 |
|---|---|---|
| ✅ | 可用，支持工具调用 | 正常使用 |
| ⚠️ | 当前不可用（上游 5xx / 临时故障） | 稍后重试 |
| 🚧 | 限流、配额耗尽，或本地链路不可达 | 等配额恢复；链路问题看 `doctor` |
| ❓ | 未探测，或上次结果已过期 | 执行 `probe` |
| ❌ | 模型已下线（连续两次确认） | 从目录里换掉 |

健康标记只做标注，**永远不会因为一次失败就把模型移出目录**：一个模型状态不好，不等于它不能用了。

## 错误对照

| 现象 | 判定 | 怎么办 |
|---|---|---|
| 429 / 配额耗尽 | `RATE_LIMIT` 🚧 | 等待配额恢复，或换一个模型 |
| 404 / 模型已下线 | `MODEL_GONE` ⚠️→❌ | 换一个目录里还在的模型 |
| 400（含给仅对话模型派发工具） | `REQUEST_REJECTED` ❓ | 跑 `probe`，让工具支持回写生效 |
| 5xx | `UPSTREAM` ⚠️ | 稍后重试 |
| `ECONNREFUSED` / 超时 | `RUNTIME_MISSING` 🚧 | 本地链路没起来，跑 `doctor` |
| 401 / 403 | `UNKNOWN` ❓ | 内部错误，summary 会写明「本地代理令牌不匹配」 |

## 环境变量

| 变量 | 作用 |
|---|---|
| `OPENCODE_ZEN_CLI_PORT` | 本地代理端口（1024–65535，默认 `41980`）。显式指定时端口被占用即启动失败；不指定时占用会自动退让到系统分配的端口 |
| `OPENCODE_ZEN_CLI_PROXY` | `0` 强制直连、`1` 强制使用系统代理；不设置时读取 `<dataDir>/settings.json`，Windows 默认开、其它平台默认关 |
| `OPENCODE_ZEN_CLI_DATA_DIR` | 数据目录（模型缓存、`health.json`、`opencode.log`）。默认按平台落在用户配置目录下 |

数据目录内容：

```
opencode-zen-cli/
├── models-cache.json   # 上次读到的免费模型目录
├── health.json         # 逐模型健康记录
├── settings.json       # 系统代理开关（手动改；插件只读）
├── opencode.log        # 子进程日志，超过 5MB 轮转为 opencode.log.previous
└── opencode/           # 隔离的 OpenCode 运行环境（XDG + 配置隔离）
```

## 与旧版桥接的关系

- **不再写 `~/.omp/agent/models.yml`**。`models.yml` 里如果还留有 `opencode-omp-bridge` 的配置块，插件既不读也不改它——可以自行删除。
- 插件内嵌的 API key 只存在于内存，随 omp 进程退出而消失。
- `~/.omp/agent/config.yml` 里如果引用了旧的 `opencode-zen/...` 模型名，需要改成 `opencode-zen-cli/...`，插件不会替你改配置。

## 开发

```bash
bun install
bun run typecheck   # tsc --noEmit
bun test            # bun test
bun run smoke       # 真实推理一次
```

源码结构：

| 文件 | 职责 |
|---|---|
| `index.ts` | 扩展入口：注册 provider、斜杠命令、会话生命周期 |
| `runtime-host.ts` | 进程内生命周期：引用计数启动/停机、状态广播 |
| `runtime.ts` | 定位 OpenCode CLI、拉起隔离的 `opencode serve`、就绪轮询 |
| `server.ts` | 本地 OpenAI 兼容服务（`/v1/models`、`/v1/chat/completions`） |
| `backend.ts` | OpenCode 协议层：v1/v2 分支、工具调用信封、审批闸门 |
| `handoff.ts` / `repair.ts` / `protocol.ts` | 原生动作外化交接、畸形信封修正、协议编解码 |
| `provider.ts` | 目录 → omp 模型表的逐字段投影 |
| `health.ts` / `errors.ts` | 逐模型探测与健康存储、失败分类 |
| `doctor.ts` / `commands.ts` / `probe.ts` | 五项体检、三条斜杠命令、探测原语 |

## 许可

MIT