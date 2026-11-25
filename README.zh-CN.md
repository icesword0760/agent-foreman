<h1 align="center">派活监工（Agent Foreman）</h1>

<p align="center">
  <strong>把偏科 AI 编成全能工程队：让任意 AI 像工头一样指挥 Codex / DSH / Antigravity</strong><br>
  总控写交代书、派活、盯实时事件与流量、双向回答提问，最后看实物与坦白书验收。
</p>

<p align="center">
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue"></a>
  <img alt="Platform: macOS" src="https://img.shields.io/badge/platform-macOS-000000?logo=apple&logoColor=white">
  <img alt="Node 22 or newer" src="https://img.shields.io/badge/node-%E2%89%A5%2022-339933?logo=node.js&logoColor=white">
  <a href="README.md">English</a>
</p>

单用任何一个顶级 AI 写代码都容易偏科：有的擅长聊产品、定方案和把关验收，有的擅长需求明确后的稳快编码，有的写前端更快、审美更好，有的创意与方案评审更强。直接裸调 `codex exec` 或官方 Skill 往往像寄平邮：黑屏二十分钟不知是卡死还是在生成、遇分歧没法举手提问、交回一句「已完成」也不知道它私下拿了哪些主意。

**派活监工（Agent Foreman）** 是一个独立开源的跨 Agent 派活监督技能与脚本。**不绑死 Claude Code**：Claude Code、Codex、DSH、Antigravity 或任何能执行 shell 命令的 Coding Agent 都能当总控监工，按强项把活派给最合适的执行者，并在两者之间加上一套实时监督、双向对讲和坦白书验收机制。

## 默认分工与自由调度

默认开箱即用，同时**支持随时用自然语言改规则或临时点名派活**（例如直接说「这轮架构评审交给反重力」「这个页面直接让 DSH 做」「以后把 Codex 默认改成超快档」）：

| 角色 | 默认触发方式 | 默认模型与档位 | 擅长生态位 |
|---|---|---|---|
| **总控监工（任意当前会话）** | 你的主会话 | 由你选择（Claude / Antigravity / Codex / DSH 等） | 理解意图、产品取舍、查清原因定方案、看实物验收 |
| **Codex** | 按职责自动派（主力） | `sol` 系列最新版 + 高档推理（桌面操作自动派 `terra` 子代理） | 方案定好后的编码落地、测试、重构、源码调研、数据处理、打包 |
| **DSH**（可选） | 按职责自动派 / **二次转包** | `deepseek-flash`（DeepSeek V4.1 Flash）+ 高档推理 | 前端 UI 设计、页面布局、视觉样式与界面组件实现 |
| **Antigravity**（可选） | 仅点名时派（`--agent agy`） | `gemini-pro-orchestrator`（可派并行子代理） | 深度咨询、创意发散、跨领域方案评审与并行调研 |

- **支持二次转包（带递归防套娃）**：把大任务派给 Codex 后，遇到前端 UI 部分，Codex 还能按约定自己拉子代理转包给 DSH 鲸鱼娘，干完自动交回整合；子代理直接读原始交代书，不靠转述，并通过递归深度保护（`MATOU_FOREMAN_DEPTH`）防止无限套娃。
- **不静默换模型**：指定模型（尤其是 Antigravity 点名模型）额度用完或不可用时直接失败并说明原因，由你决定改派给谁。

## 核心能力

- **活体监工 · 实时事件流**：执行者的每一步（跑了什么命令、读写了什么文件、阶段进度）都会实时推送一行事件。在支持 `Monitor` 的环境（如 Claude Code）里异步推送；在其他 Agent/终端里直接用长超时 shell 命令跟踪。
- **流量查假死与自动重试**：一段时间静默先提醒，再在同一会话内退避重试。macOS 上监督进程会用 `nettop` 检查网络流量，正在长时间生成吐字时不会被误判成卡死。
- **退出码 7 双向对讲机**：执行者遇到交代书没写清的分歧，立刻以退出码 `7` 暂停并举手提问，监工用 `answer` 秒回拍板（或先问你再答），绝不闷头瞎猜；中途也能用 `note` 发留言纠偏。
- **五栏交代书防跑偏**：目标、实际场景、开发者意图（用户原话）、项目意图、验收标准五栏必填；子代理直接读取原始交代书，避免多层转述失真。
- **强制交底 ·《我自己做的决定》坦白书**：拒绝一句「已完成」。每轮交工必须列出改了哪里、产物路径、自检结果，以及**每一条它自己私下做的决定**（子代理的决定也会标明来源），倒逼看实物验收。
- **并行推进与断点续跑**：内置多 worktree / 分支并行协作指引；监督进程与跟踪命令解耦，跟踪满 29 分钟退出码 `8` 交回时任务照常在后台跑，用 `watch` 随时重连。
- **配置持久化与即时生效**：支持 `~/.claude/agent-foreman/config.json` 配置默认执行者、模型、推理档位、判卡/单轮/等回答时限和重试次数，并支持通过 `MATOU_FOREMAN_ROLES_FILE` 读取生态位、各家独立模型/速度档与二次转包开关。

## 搭配 Matou（码头）终端工作台的增益体验

`agent-foreman` 完全独立、MIT 开源，在任何终端里都能单独使用。如果你同时使用原生终端工作台 [Matou（码头）](https://github.com/icesword0760/matou)：

- **全内置 Agent 开箱即用**：Claude Code、Codex、DSH、Antigravity 等会话自动注入 `mt-foreman` 命令（等价于 `node <技能目录>/scripts/foreman.mjs`），无需逐个手配。
- **底栏 HUD 实时监工**：每个外派任务实时投影到码头底栏 `Agents` 胶囊与悬停「子代理」卡片，直接看到任务名、模型、推理档位、速度档、当前动作与耗时。
- **可视化派活设置页**：在「设置 → 派活」里点几下即可修改全局默认值、各家 Agent 生态位、独立模型/推理档位/速度档以及「允许执行者二次转包」开关，保存后对当前和新开会话即时生效。

## 环境要求

- Node.js 22 或更新
- 至少一个已登录的执行者 CLI（推荐 [Codex CLI](https://github.com/openai/codex)）
- macOS：开发与测试基于 macOS；按网络流量（`nettop`）判断模型是否真在生成的功能仅支持 macOS
- 可选：`dsh` CLI（用于前端 UI 自动派发与二次转包）
- 可选：`agy`（Antigravity）CLI（用于点名派发的深度咨询与方案评审）
- 任意支持 shell / Skill 的主控 Agent（如 [Claude Code](https://claude.com/claude-code)、Codex、DSH、Antigravity 等）

## 安装

作为 Claude Code 插件安装：

```
/plugin marketplace add icesword0760/agent-foreman
/plugin install agent-foreman@agent-foreman
```

或者手动复制到技能目录（适用于 Claude Code 或其他兼容 Agent）：

```bash
git clone https://github.com/icesword0760/agent-foreman.git
cp -R agent-foreman/skills/agent-foreman ~/.claude/skills/
```

## 使用方式

直接用自然语言告诉当前主控 Agent 把活派出去，例如：
- 「把购物车结算逻辑和兼容测试交给 Codex，遇到前端抽屉转包给 DSH」
- 「这个架构方案先点名让反重力评审一下」
- 「以后默认把 Codex 切到超快档」

想让主控 Agent 默认走这套流程，可以在你的规则文件（如 `CLAUDE.md` / `AGENTS.md`）里加一句：

```
要把工作交给 Codex，或拆成子任务交给其他 agent 时，先加载 agent-foreman 技能，按其中流程执行。
```

常用命令（在 `skills/agent-foreman/scripts/foreman.mjs`，Matou 托管终端内直接用 `mt-foreman`）：

| 命令 | 作用 |
|---|---|
| `start <task> --cd <目录>` | 启动新任务，交代书从标准输入或 `--brief <文件>` 读取（支持 `--agent codex\|dsh\|agy`） |
| `send <task>` | 在同一会话里继续（返工、下一关、转达用户决定） |
| `watch <task>` | 重新接上实时事件流 |
| `answer <task> [n]` / `note <task>` | 回答退出码 7 提问 / 发送中途纠偏留言 |
| `status <task>` / `stop <task>` | 查看状态 / 停止并清理 |
| `roles` | 查看当前生效的各家 Agent 生态位、默认模型与二次转包策略 |
| `guide <brief\|parallel\|reference>` | 按需查看交代书模板、并行指引或完整命令参考 |
| `models` | 查看模型别名当前解析到的具体型号 |

运行记录保存在 `~/.claude/agent-foreman/runs/<task>/`：交代书、全部事件、提问和回答、决定记录，以及每轮最终回复。完整选项、事件符号和退出码见 [`reference.md`](skills/agent-foreman/reference.md)。

## 安全：务必先读

默认情况下 Codex **不开沙箱、不弹审批**（`danger-full-access`，审批策略 `never`），以便正常执行 `git add`、启动开发服务器、打开浏览器、调用 MCP 工具。这也意味着**能拦住付费、对外、不可逆操作的只有交代书**：每份交代书的「必须先问的地方」都应明确列出这类操作；监督进程附加的运行约定默认禁止 `git push`，只有交代书明确要求时才允许提交。不该碰工作目录以外文件的任务，请加 `--sandbox`。

## 语言

技能说明、交代书模板，以及监督进程发出的事件和运行约定均为中文。主流模型都能正常理解，你可以用任何语言和主控 Agent 对话，看到的事件行是中文。

## 测试

```bash
node --test skills/agent-foreman/tests/*.test.mjs
```

测试使用本地 mock 的 `codex`、`dsh` 和 `agy` 可执行文件，无需联网或登录账号。

## 许可证

MIT
