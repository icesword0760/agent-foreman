<h1 align="center">Agent Foreman (派活监工)</h1>

<p align="center">
  <strong>Let Claude Code direct Codex CLI like a foreman</strong><br>
  Claude writes the brief, dispatches the work, watches live progress, answers the agent's questions, and accepts the result by looking at real evidence.
</p>

<p align="center">
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue"></a>
  <img alt="Platform: macOS" src="https://img.shields.io/badge/platform-macOS-000000?logo=apple&logoColor=white">
  <img alt="Node 22 or newer" src="https://img.shields.io/badge/node-%E2%89%A5%2022-339933?logo=node.js&logoColor=white">
  <a href="README.zh-CN.md">中文</a>
</p>

Claude is good at understanding what you want, making product calls and judging results. Codex is good at grinding through long, well-defined execution. Agent Foreman is a [Claude Code](https://claude.com/claude-code) skill that splits the work that way: Claude stays the lead, and Codex (or, optionally, the DSH CLI) does the hands-on work under supervision.

Calling `codex exec` directly from Claude works until it doesn't: the call blocks for half an hour with no progress, a stalled run is indistinguishable from a busy one, Codex can't ask anything mid-task, and "done" arrives with no record of what it decided on its own. Agent Foreman puts a small supervisor in between.

## What you get

- **Live events.** Every step Codex takes (command run, file changed, its own progress notes) streams into Claude's Monitor as one line. Claude keeps working and reacts when something matters.
- **Stall detection and retries.** Silence triggers a warning, then a restart in the same session with backoff. On macOS the supervisor reads Codex's network traffic, so a long silent generation is not mistaken for a hang.
- **Two-way questions.** Codex can ask a blocking question (it waits for Claude's answer) or a non-blocking one (it proceeds with its stated default). Claude can also leave notes that Codex picks up after each step.
- **Gates and a decision list.** Codex stops at the checkpoints in the brief and ends every turn with what it did, where the output is, its self-check, and **every decision it made on its own**, so Claude reviews choices instead of trusting a "done".
- **A brief template that prevents drift.** Goal, real usage scenario, developer intent (the user's own words), project intent, and acceptance criteria are separate required slots. When Codex hands part of the work to a sub-agent, the sub-agent reads the original brief instead of a paraphrase, and its decisions are reported back labeled.
- **Model selection.** Defaults to the newest model in Codex's main (sol) family at high reasoning, resolved at start. Anything that needs computer use (clicking through desktop apps, Blender modeling) goes to a sub-agent on the newest terra model, so the main model never switches.
- **Optional DSH for front-end UI.** If the `dsh` CLI is installed, front-end UI design and its interface code go to a DSH sub-task (DeepSeek V4.1 Flash, high reasoning), and Codex integrates the result.
- **Optional Antigravity.** If the `agy` CLI is installed, a task can be handed to Antigravity with `--agent agy` (newest Gemini Hydrogen model, high reasoning; `--model argon` picks the newest Argon instead). It never falls back to another model: when the chosen model is unavailable or out of quota, the task fails with the reason.
- **Parallel work.** Guidance for splitting independent work across git worktrees or branches, running several agents at once, and merging after acceptance.
- **Survives the Monitor timeout.** The supervisor is detached from the command that started it. When Claude's 30-minute Monitor expires, only the watching stops; the task keeps running and Claude re-attaches with `watch`.
- **Status display.** In the [Matou](https://github.com/icesword0760/matou) terminal workbench, each task appears as a card in the bottom bar with the agent, task name, model and reasoning level. In other terminals, a status-line script adds one line per task.

## Requirements

- Claude Code with the Monitor tool
- [Codex CLI](https://github.com/openai/codex), logged in
- Node.js 22 or newer
- macOS. This is what it is built and tested on. Other systems are untested, and the network-based activity detection is macOS-only.
- Optional: the `dsh` CLI, for front-end UI sub-tasks
- Optional: the `agy` (Antigravity) CLI, for tasks you hand to Antigravity

## Install

As a Claude Code plugin:

```
/plugin marketplace add icesword0760/agent-foreman
/plugin install agent-foreman@agent-foreman
```

Or copy the skill by hand:

```bash
git clone https://github.com/icesword0760/agent-foreman.git
cp -R agent-foreman/skills/agent-foreman ~/.claude/skills/
```

## Use

Ask Claude to hand something to Codex, for example "让 Codex 把购物车接上后端" or "have Codex add tests for the parser". The skill loads, Claude fills in the brief, starts the task inside Monitor, and handles the events from there.

To make Claude always route execution work through it, add a line like this to your `CLAUDE.md`:

```
When work is handed to Codex or split into sub-tasks for agents, load the agent-foreman skill first and follow it.
```

The commands Claude runs, all from `skills/agent-foreman/scripts/foreman.mjs`:

| Command | Purpose |
|---|---|
| `start <task> --cd <dir>` | Start a task; the brief comes from stdin |
| `send <task>` | Continue in the same session (rework, next gate, a user decision) |
| `watch <task>` | Re-attach to the event stream |
| `answer <task> [n]` / `note <task>` | Answer a question / leave a note |
| `status <task>` / `stop <task>` | Inspect / stop and clean up |
| `models` | Show how model keywords resolve |

Run records live in `~/.claude/agent-foreman/runs/<task>/`: the briefs, every event, questions and answers, the decision log, and Codex's final replies. See [`reference.md`](skills/agent-foreman/reference.md) for every option, event symbol and exit code.

## Safety: read this

By default Codex runs **without a sandbox and without approval prompts** (`danger-full-access`, approval policy `never`), the same way most people run Codex by hand. That is what lets it run `git add`, start dev servers, open browsers and call MCP tools. It also means **the brief is the only thing stopping a paid, external or irreversible action.** The skill tells Claude to list such actions under "must ask first" in every brief, and the supervisor's run rules forbid `git push` and allow commits only when the brief asks for them. Add `--sandbox` to a task that should not touch anything outside its working directory.

## Language

The skill's instructions, the brief template, and the events and rules the supervisor sends are written in Chinese. Claude and Codex both work with them fine, and you can talk to Claude in any language, but the event lines you see will be in Chinese.

## Tests

```bash
node --test skills/agent-foreman/tests/*.test.mjs
```

The tests use fake `codex`, `dsh` and `agy` executables; they need no network or account.

## License

MIT
