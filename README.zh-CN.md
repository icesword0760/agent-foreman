<h1 align="center">派活监工（Agent Foreman）</h1>

<p align="center">
  <strong>让 Claude Code 像工头一样指挥 Codex CLI</strong><br>
  Claude 写交代书、派活、盯进度、回答执行者的提问，最后看实物验收。
</p>

<p align="center">
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue"></a>
  <img alt="Platform: macOS" src="https://img.shields.io/badge/platform-macOS-000000?logo=apple&logoColor=white">
  <img alt="Node 22 or newer" src="https://img.shields.io/badge/node-%E2%89%A5%2022-339933?logo=node.js&logoColor=white">
  <a href="README.md">English</a>
</p>

Claude 擅长理解你要什么、做产品取舍、判断结果好不好；Codex 擅长把目标明确的活一步步做完。派活监工是一个 [Claude Code](https://claude.com/claude-code) 技能，按这个分工协作：Claude 当总指挥，Codex（也可以加上 DSH CLI）在监督下动手落地。

让 Claude 直接调用 `codex exec` 能用，但常出问题：一调用就卡半小时看不到进度，卡死和忙碌分不清，Codex 做到一半没法提问，交回「完成」时也不知道它自己拿了哪些主意。派活监工在两者之间加了一个小小的监督进程。

## 有什么用

- **实时事件**：Codex 的每一步（跑了什么命令、改了哪个文件、它自己的阶段说明）都变成一行事件，推送到 Claude 的 Monitor。Claude 照常干别的，有需要时再处理。
- **卡住检测和重试**：一段时间没动静先提醒，再在同一会话里退避重试。macOS 上监督进程会读 Codex 的网络流量，长时间闷头生成不会被误判成卡死。
- **双向提问**：Codex 可以阻塞提问（等 Claude 回答），也可以不阻塞提问（先按它说明的做法继续）。Claude 也可以随时留言，Codex 每做完一步会查看。
- **关卡和决定清单**：Codex 到交代书写的关卡就停下，每轮回复都写明做了什么、产物在哪、自检结果，以及**它自己做的每一个决定**。Claude 逐条复核，而不是只听一句「完成了」。
- **防止做偏的交代书模板**：目标、实际场景、开发者意图（用户原话）、项目意图、验收标准各占一栏，每栏必填。Codex 把一部分活交给子代理时，子代理直接读原始交代书，不靠转述；子代理做的决定也要交回，并注明来源。
- **模型选择**：默认用 Codex 主力 sol 系列的最新型号 + 高档推理，启动时解析。需要操作电脑界面的部分（点按桌面软件、Blender 建模）交给 terra 系列最新型号的子代理，主模型不来回切换。
- **可选的 DSH 前端 UI 分工**：装了 `dsh` CLI 时，前端 UI 设计和对应的界面代码派给 DSH 子任务（DeepSeek V4.1 Flash，高档推理），Codex 负责整合。
- **并行**：怎么把互不依赖的活拆到不同 git worktree 或分支、同时跑几个 agent、验收后合并，都有指引。
- **不怕 Monitor 到期**：监督进程和启动它的命令是分开的。Claude 的 Monitor 30 分钟到期时只停止跟踪，任务照常运行，用 `watch` 重新接上。
- **状态显示**：在 [码头（Matou）](https://github.com/icesword0760/matou) 终端工作台里，每个任务显示为底栏的一张卡片，写明 agent、任务名、模型和推理档位。在其他终端里，可以用状态行脚本为每个任务显示一行。

## 需要什么

- 带 Monitor 工具的 Claude Code
- 已登录的 [Codex CLI](https://github.com/openai/codex)
- Node.js 22 或更新
- macOS：开发和测试都在 macOS 上；其他系统没测过，按网络流量判断活动的功能只支持 macOS
- 可选：`dsh` CLI，用于前端 UI 子任务

## 安装

作为 Claude Code 插件安装：

```
/plugin marketplace add icesword0760/agent-foreman
/plugin install agent-foreman@agent-foreman
```

或者手动复制技能：

```bash
git clone https://github.com/icesword0760/agent-foreman.git
cp -R agent-foreman/skills/agent-foreman ~/.claude/skills/
```

## 怎么用

直接让 Claude 把事交给 Codex，比如「让 Codex 把购物车接上后端」。技能会自动加载，Claude 填好交代书，在 Monitor 里启动任务，之后自己处理各种事件。

想让 Claude 每次都通过它派活，可以在 `CLAUDE.md` 里加一句：

```
要把工作交给 Codex，或拆成子任务交给其他 agent 时，先加载 agent-foreman 技能，按其中流程执行。
```

Claude 用到的命令都在 `skills/agent-foreman/scripts/foreman.mjs`：

| 命令 | 作用 |
|---|---|
| `start <task> --cd <目录>` | 新任务，交代书从标准输入读 |
| `send <task>` | 在同一会话里继续（返工、下一关、转达用户决定） |
| `watch <task>` | 重新接上事件流 |
| `answer <task> [n]` / `note <task>` | 回答提问 / 留言 |
| `status <task>` / `stop <task>` | 查看状态 / 停止并清理 |
| `models` | 查看模型关键字解析成了哪个型号 |

运行记录在 `~/.claude/agent-foreman/runs/<task>/`：交代书、全部事件、提问和回答、决定记录，以及 Codex 每轮的最终回复。所有选项、事件符号和退出码见 [`reference.md`](skills/agent-foreman/reference.md)。

## 安全：务必先读

默认情况下 Codex **不开沙箱、不弹审批**（`danger-full-access`，审批策略 `never`），和大多数人自己用 Codex 的方式一样。这样它才能执行 `git add`、启动开发服务器、打开浏览器、调用 MCP 工具。这也意味着，**能拦住付费、对外、不可逆操作的只有交代书**。技能要求 Claude 在每份交代书的「必须先问的地方」列出这类操作；监督进程附加的运行约定禁止 `git push`，只有交代书明确要求时才允许提交。不该碰工作目录以外东西的任务，加 `--sandbox`。

## 语言

技能说明、交代书模板，以及监督进程发出的事件和运行约定都是中文。Claude 和 Codex 都能正常理解，你也可以用任何语言和 Claude 对话，只是看到的事件行是中文。

## 测试

```bash
node --test skills/agent-foreman/tests/*.test.mjs
```

测试使用假的 `codex` 和 `dsh` 可执行文件，不需要联网，也不需要账号。

## 许可证

MIT
