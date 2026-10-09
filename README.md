# opencode2pi-cli

在 **omp** / **pi** 里直接用 [OpenCode Zen](https://opencode.ai/zen) 的**免费模型**，
由**你自己机器上的 OpenCode CLI** 提供。

**无需 API key · 无需注册 · 无需另开终端 · 无需手改配置文件**

> ⚠️ **免费池随时可能变动。** 模型上下线、限流、临时故障都是常态。
> 出问题先跑 `/opencode2pi-cli doctor`，它会逐项告诉你链路断在哪一环。

与 [`opencode2pi`](https://github.com/FanchangWang/opencode2pi) 的区别：那一个直连 Zen 的
匿名通道（无子进程）；这一个走本机 `opencode serve`，所以**需要你先装好 OpenCode CLI**，
好处是工具调用与多模态由 OpenCode 自己承接，模型池也跟着它的目录走。

---

## 安装

前置条件：本机装了 OpenCode CLI，且 `opencode -v` 能输出版本号。

```sh
# v2（推荐）
npm i -g @opencode/cli
# v1
npm i -g opencode-ai
```

然后装扩展：

```sh
# 当前可用：从 git 装。注意：omp/pi 不支持 .tgz，只能用 git URL
omp install git:https://github.com/FanchangWang/opencode2pi-cli@stable
pi  install git:https://github.com/FanchangWang/opencode2pi-cli@stable

# npm 尚未上线（仓库没有 NPM_TOKEN，OIDC 首发也未配置），下面的命令暂时不可用：
# omp install npm:opencode2pi-cli
# pi  install npm:opencode2pi-cli

# 追踪最新代码：装的是"此刻 main 指向的 commit"，含未发布的改动，之后不会自动更新
omp install git:https://github.com/FanchangWang/opencode2pi-cli@main
pi  install git:https://github.com/FanchangWang/opencode2pi-cli@main
```

`@stable` 是最近一次发版的版本，随发版前移；要固定到某一版，去
[releases](https://github.com/FanchangWang/opencode2pi-cli/releases) 挑一个 tag，
把 `@stable` 换成那个 tag 名或 commit SHA。本扩展跟着本机 OpenCode CLI 的目录走，
上游随时可能改模型池或协议行为，只有钉死才能复现"当时能用"的状态。

`@latest` 用不了：git 没有这个 ref，omp 解析会报错。

### 从源码运行（开发用）

```sh
git clone https://github.com/FanchangWang/opencode2pi-cli.git
cd opencode2pi-cli
npm install

# 链接当前目录：改代码立即生效，不用重装
omp install .

# 单次试用，不落盘
omp -e ./src/index.ts -p --model opencode-zen-cli/oc-space-bunny-free "你好"
```

`omp install .` 是**链接而非拷贝**：改 `src/` 下的代码下次启动就生效。代价是删掉或移动
这个目录扩展就失效了——本地开发用它，给别人用请走上面的 npm 或 git。

> **不要只复制 `src/index.ts`**。扩展是多文件模块，删任何一个都会在启动时炸。

装完后**完全退出所有 omp 进程并重启**。启动时插件会自动定位 CLI、拉起隔离的
`opencode serve`、开本地服务，通常几秒内完成，会话开始时给你一条就绪通知：

```
opencode-zen-cli 已就绪 · 10 个免费模型 · http://127.0.0.1:41980/v1
```

---

## 使用

### 选模型

会话里用 `/model` 选择，provider 名是 `opencode-zen-cli`，模型 id 一律带 `oc-` 前缀
（如 `oc-big-pickle`、`oc-space-bunny-free`）。

命令行要用 `--model <provider>/<model>`，**不要**用 `--provider`：

```sh
# 对
omp -p --model opencode-zen-cli/oc-space-bunny-free "你好"

# 错，会报 Unknown provider
omp --provider opencode-zen-cli
```

`omp models` **会**列出 `opencode-zen-cli` 和它当前的模型清单（实测 2026-10-06：
`opencode-zen-cli (10)`），清单随上游目录变化。

### 工具调用是通的

模型提出动作、执行由 omp 完成，本地 OpenCode 服务只负责把动作翻译成它的格式再翻译回来。
命令行直接验证：

```sh
omp -p --model opencode-zen-cli/oc-space-bunny-free \
  "用 bash 工具列出当前目录的文件，只回显命令输出"
```

### 能力参数

上下文长度、最大输出都取自 OpenCode 目录的真实值；上游没给时落到保守默认值
（128000 / 8192），而不是悄悄用一个错的数字。推理档位（thinking effort）只声明
目录里真实存在的档位，不做臆测。

---

## `/opencode2pi-cli`

omp 没有扩展设置页，斜杠命令是本扩展唯一的界面。

| 命令 | 作用 |
| --- | --- |
| `/opencode2pi-cli doctor` | 逐项检查五个环节：CLI、`serve`、本地代理、模型目录、一次真实推理 |
| `/opencode2pi-cli status` | 显示上次探测的结果；**从未探测过的模型（含新加入的）会当场补测** |
| `/opencode2pi-cli probe` | 重新探测全部模型，并把「仅对话」结论写回模型列表、询问过滤设置 |
| `/opencode2pi-cli filter` | 选择要在 `/model` 里隐藏哪些模型（默认一个都不隐藏） |

不带参数执行会弹出四项菜单。

### 健康标记

| 标记 | 含义 |
| --- | --- |
| ✅ | 可用，支持工具调用 |
| ⚠️ | **现在不行**（上游 5xx，或没被分类器识别的错误），不代表模型没了 |
| 🚧 | **限流 / 配额耗尽，或本地链路不可达**。前者等配额恢复，后者跑 `doctor` |
| ❌ | 确定不可用：连续两次确认下线，或上游按地区封锁（403 · not available in your country） |

每行末尾直接带上原因（上游原文、HTTP 状态或超时秒数）和探测时间，所以不存在
「这个模型到底怎么回事」需要另外去查的情况。

这四个都是**判决**，都关于模型本身。另有一种情况不是判决：`·` 表示**从没探测过**
（通常是目录里新增的模型）——`status` 会当场补测它，模型本身照常出现在 `/model` 里可用。

`status` 显示的是**最近一次探测的结论**，它只在自己补测那些从没问过的模型时发请求。
**结论超过 6 小时不会自动重测**，而是在末尾提醒你跑 `probe`：一次全量探测要几分钟真实
推理，这是你的调用，不该由看一眼状态替他决定。6 小时而不是一天，是因为免费池按小时级别
变动（实测 2026-10-06：同一会话里一个模型 ✅、邻居 ❌）。

**默认只标注、不隐藏。** 免费池波动大，单次失败不足以判死刑——所以一次
"模型消失"只标 ⚠️，连续两次才升级 ❌，任何一次成功都会清零。

要不要从列表里隐藏，是你的决定：探测结束后（或随时 `/opencode2pi-cli filter`）
会弹一个选项——全部保留 / 只隐藏地区封锁的 / 隐藏所有探测失败的。
**配额耗尽和本地链路故障不会隐藏任何模型**：那是通道的状态，不是模型的。
被隐藏的只是不进 `/model` 和 `--model`，`status` 里照样能看到全部。

探测是真发请求（每个模型一次带工具的对话），整轮数分钟量级。
**探测只在交互式 TUI 下可用**：打印模式没有进度对话框，会直接提示而不挂起。

---

## 排障

### 先跑 doctor

五项检查各自独立，能直接定位是 CLI 没装、`serve` 没起来、本地端口没开、目录为空，
还是推理本身坏了——这五种情况的处理方式完全不同。

### 错误对照表

扩展会把上游错误翻译成人能看懂的原因：

| 你看到的 | 归类 | 原因 / 处理 |
| --- | --- | --- |
| 上游限流或配额耗尽（429） | `RATE_LIMIT` | 等配额恢复，或换一个模型 |
| 模型已不可用（404 / ModelError） | `MODEL_GONE` | 上游已不再支持该模型，换一个 |
| 该模型在当前网络地区不可用 | `REGION_BLOCKED` | 上游的地区封锁，不是本机问题；换一个模型，或 `OPENCODE_ZEN_CLI_PROXY=1` 走系统代理换出口 |
| 上游拒绝了这次请求（400） | `REQUEST_REJECTED` | 多半是给「仅对话」模型派发了工具，跑 `probe` 让结论写回 |
| 上游暂时不可用（5xx） | `UPSTREAM` | 稍后重试 |
| 本地链路未就绪 | `RUNTIME_MISSING` | 跑 `doctor`，看是 CLI、serve 还是代理这一环 |
| 本地代理令牌不匹配 | `UNKNOWN` | 内部错误，请提 issue |

### 想让失败的模型不出现在 `/model` 里

`/opencode2pi-cli filter`（或每次探测结束后自动询问）可以隐藏地区封锁的、以及所有探测失败的模型。
这个选择会记在数据目录的 `filters.json` 里，重启后仍然有效；随时可以改回「全部保留」。

### 其它常见问题

| 现象 | 处理 |
| --- | --- |
| `Unknown provider "opencode-zen-cli"` | 用了 `--provider`。改用 `--model opencode-zen-cli/<id>` |
| 启动时提示未找到 OpenCode | 没装 CLI，或不在 PATH 上。`opencode -v` 验证 |
| 启动时提示启动失败 | 跑 `/opencode2pi-cli doctor`；细节在数据目录的 `opencode.log` |
| `serve` 60 秒没就绪 | 上游模型目录拉取慢或网络不通；看 `opencode.log`，或设 `OPENCODE_ZEN_CLI_PROXY=0` 直连 |
| 端口 41980 被占用 | 默认端口会自动退让到系统分配的端口（通知里会显示真实端口）。想固定就设 `OPENCODE_ZEN_CLI_PORT`，此时占用会直接启动失败 |
| 从 `opencode-omp-bridge` 迁过来的 | `models.yml` 里的旧配置块本扩展不读不写，可自行删除；`config.yml` 里的 `modelRoles` 若指向 `opencode-zen/...`，需改成 `opencode-zen-cli/...` |

---

## 它做了什么、没做什么

宿主内建的 `opencode-zen` provider 需要付费 `OPENCODE_API_KEY`；本扩展走的是同一个
上游的**免费池**，路径是：你机器上的 `opencode` CLI → 隔离的 `opencode serve` →
插件进程内的 OpenAI 兼容本地服务 → omp provider。

**不写 `models.yml`。** 模型表由运行时 `registerProvider` 注册，卸载插件 provider 随之
消失，不留任何残留文件。API key 只存在于内存，随 omp 进程退出而消失。

**不做**：付费 Zen 通道、IP 池轮换、全局改写用户配置、模型健康过滤（只标注不隐藏）。

细节见 [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md)。

---

## 环境变量

| 变量 | 作用 |
| --- | --- |
| `OPENCODE_ZEN_CLI_PORT` | 本地服务端口（1024–65535，默认 `41980`）。显式指定时占用即启动失败；不指定时占用自动退让 |
| `OPENCODE_ZEN_CLI_PROXY` | `0` 强制直连、`1` 强制走系统代理；不设置时读 `<dataDir>/settings.json`，Windows 默认开、其它平台默认关 |
| `OPENCODE_ZEN_CLI_DATA_DIR` | 数据目录（模型缓存、健康记录、子进程日志）。默认按平台落在用户配置目录 |

数据目录内容：`models-cache.json`（目录缓存）、`health.json`（健康记录）、
`settings.json`（代理开关，手动改）、`opencode.log`（子进程日志，>5MB 轮转）、
`opencode/`（隔离的 OpenCode 运行环境）。

---

## 文档

| 文档 | 内容 |
| --- | --- |
| [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md) | 架构、模块地图、关键设计决策、宿主 API 实测行为、验证与发布流程 |
| [`docs/FINDINGS.md`](docs/FINDINGS.md) | 实测结论存档：宿主扩展 API 的真实行为、Windows 进程树停机、协议层易错点 |
| [`AGENTS.md`](AGENTS.md) | 给接手的 AI：项目地图、验证命令、别踩的坑 |

---

## 致谢

协议层、工具调用外化交接与畸形信封修正，移植自
[`opencode-omp-bridge`](https://github.com/FanchangWang/opencode-omp-bridge)（同作者的
独立进程版本）。

## 许可证

MIT