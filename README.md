<h1 align="center">Agent Foreman (派活监工)</h1>

<p align="center">
  <strong>Turn specialized coding AIs into one coordinated team — let any AI direct Codex, DSH &amp; Antigravity like a foreman</strong><br>
  The lead writes a structured brief, dispatches execution, watches live events and network activity, answers mid-task questions, and accepts work by inspecting real output and a decision log.
</p>

<p align="center">
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue"></a>
  <img alt="Platform: macOS" src="https://img.shields.io/badge/platform-macOS-000000?logo=apple&logoColor=white">
  <img alt="Node 22 or newer" src="https://img.shields.io/badge/node-%E2%89%A5%2022-339933?logo=node.js&logoColor=white">
  <a href="README.zh-CN.md">中文</a>
</p>

Every top coding AI is heavily specialized: some excel at product reasoning, architecture and acceptance, others grind through well-defined implementation fast and reliably, others shine at front-end UI aesthetics, and others bring strong creative brainstorming and cross-domain review. Calling `codex exec` or a thin skill directly feels like mailing a postcard: twenty minutes of silence with no clue whether it hung or is thinking, no way for the worker to ask a question mid-task, and a bare "done" with no record of what it decided on its own.

**Agent Foreman** is a standalone MIT-licensed skill and supervisor script. **It is not locked to Claude Code**: Claude Code, Codex, DSH, Antigravity, or any shell-capable coding agent can act as the lead foreman, delegating work to the right specialist under live supervision, two-way Q&amp;A, and gated acceptance.

## Default Roles &amp; Natural-Language Control

Works out of the box with sensible defaults, while letting you **change rules or route any task ad-hoc in plain natural language** (e.g., *"have Antigravity review this architecture first"*, *"send this page straight to DSH"*, or *"switch Codex default to ultrafast"*):

| Role | Default Trigger | Default Model &amp; Effort | Specialty |
|---|---|---|---|
| **Lead Foreman (any session)** | Your active session | Your choice (Claude / Antigravity / Codex / DSH, etc.) | Intent, product trade-offs, root-cause &amp; plan, real-evidence acceptance |
| **Codex** | Auto by role (primary) | Latest `sol` + high reasoning (`terra` sub-agent for computer use) | Implementation, tests, refactors, source research, data processing, packaging |
| **DSH** (optional) | Auto by role / **sub-dispatch** | `deepseek-flash` (DeepSeek V4.1 Flash) + high reasoning | Front-end UI design, layout, styling, and interactive components |
| **Antigravity** (optional) | Explicit mention (`--agent agy`) | `gemini-pro-orchestrator` (supports parallel sub-agents) | Deep consultation, ideation, cross-domain design review &amp; parallel research |

- **Executor sub-dispatch with recursion guard.** When a large task is handed to Codex and includes front-end UI work, Codex can sub-dispatch that slice to DSH on its own and integrate the result. Sub-agents read the original brief directly (no telephone-game paraphrasing), and `MATOU_FOREMAN_DEPTH` prevents runaway recursion.
- **No silent model fallback.** If a requested model (especially an explicitly chosen Antigravity model) is unavailable or out of quota, the task fails cleanly with the reason so you decide where to re-route it.

## What You Get

- **Live event stream.** Every step the worker takes (commands, file edits, progress milestones) streams out as one-line events — asynchronously into `Monitor` (e.g., Claude Code) or via long-timeout shell commands in other agents.
- **Traffic-aware stall detection &amp; retries.** Silence triggers a warning, then a same-session retry with backoff. On macOS, the supervisor checks network traffic via `nettop` so long silent generation is never mistaken for a hang.
- **Exit-code-7 two-way intercom.** When the worker hits an ambiguity not covered by the brief, it pauses with exit code `7` and raises a question. The lead replies with `answer` (or asks you first), and can also send mid-run course corrections via `note`.
- **5-slot brief template.** Goal, real usage scenario, developer intent, project intent, and acceptance criteria are required slots so execution never drifts from why the task exists.
- **Gated acceptance &amp; decision confession list.** Rejects a bare "done". Every turn reports changed files, artifacts, self-checks, and **every decision the worker (or its sub-agents) made on its own** for line-by-line review.
- **Parallel work &amp; timeout-proof watching.** Includes git worktree/branch parallel guidance; the supervisor runs detached from the watcher, so a 29-minute watch timeout (exit code `8`) never kills the worker — just re-attach with `watch`.
- **Persistent config &amp; live overrides.** Supports `~/.claude/agent-foreman/config.json` for default agent/model/effort/timeouts/retries, plus `MATOU_FOREMAN_ROLES_FILE` for per-agent roles, model/speed presets, and the sub-dispatch toggle.

## Optional Bonus with Matou Workbench

Agent Foreman is completely standalone and works in any terminal. When used inside the native [Matou](https://github.com/icesword0760/matou) terminal workbench:

- **Zero-setup across all built-in agents:** `mt-foreman` (equivalent to `node <skill-dir>/scripts/foreman.mjs`) is automatically available to Claude Code, Codex, DSH, and Antigravity sessions.
- **Bottom-bar HUD:** Every dispatched task projects live into Matou's bottom `Agents` pill and hover card showing agent, task name, model, effort/speed tier, current step, and elapsed time.
- **Visual Dispatch Settings:** Tweak global defaults, per-agent niches, independent model/effort/speed presets, and the sub-dispatch toggle in **Settings → Dispatch** with instant effect.

## Requirements

- Node.js 22 or newer
- At least one logged-in worker CLI (recommended: [Codex CLI](https://github.com/openai/codex))
- macOS (developed and tested on macOS; `nettop` traffic-based stall detection is macOS-only)
- Optional: `dsh` CLI (front-end UI dispatch &amp; sub-dispatch)
- Optional: `agy` (Antigravity) CLI (explicit-mention consultation &amp; review)
- Any shell/skill-capable lead agent (e.g., [Claude Code](https://claude.com/claude-code), Codex, DSH, Antigravity)

## Install

As a Claude Code plugin:

```
/plugin marketplace add icesword0760/agent-foreman
/plugin install agent-foreman@agent-foreman
```

Or copy the skill manually (for Claude Code or other compatible agents):

```bash
git clone https://github.com/icesword0760/agent-foreman.git
cp -R agent-foreman/skills/agent-foreman ~/.claude/skills/
```

## Use

Ask your lead agent in plain language — for example:
- *"Hand the cart pricing engine and tests to Codex, and let it sub-dispatch the drawer UI to DSH."*
- *"Ask Antigravity to review this architecture plan first."*
- *"Set Codex default speed to ultrafast."*

To make your lead agent use Agent Foreman by default, add a line to your instruction file (`CLAUDE.md` / `AGENTS.md`):

```
When work is handed to Codex or split into sub-tasks for agents, load the agent-foreman skill first and follow it.
```

Commands in `skills/agent-foreman/scripts/foreman.mjs` (or `mt-foreman` inside Matou):

| Command | Purpose |
|---|---|
| `start <task> --cd <dir>` | Start a task; brief comes from stdin or `--brief <file>` (`--agent codex\|dsh\|agy`) |
| `send <task>` | Continue in the same session (rework, next gate, user decision) |
| `watch <task>` | Re-attach to the live event stream |
| `answer <task> [n]` / `note <task>` | Answer an exit-code-7 question / leave a mid-run note |
| `status <task>` / `stop <task>` | Inspect / stop and clean up |
| `roles` | Inspect active per-agent roles, default models, and sub-dispatch policy |
| `guide <brief\|parallel\|reference>` | Read the brief template, parallel guide, or full CLI reference |
| `models` | Show how model keywords currently resolve |

Run records live in `~/.claude/agent-foreman/runs/<task>/`: briefs, full event logs, Q&amp;A, decision logs, and final replies. See [`reference.md`](skills/agent-foreman/reference.md) for all flags, event symbols, and exit codes.

## Safety: Read This

By default Codex runs **without a sandbox and without approval prompts** (`danger-full-access`, approval policy `never`), matching how most people run Codex by hand so it can run `git add`, start dev servers, open browsers, and call MCP tools. That means **the brief is the only guardrail against paid, external, or irreversible actions**: list them under "must ask first" in every brief. The supervisor's run rules forbid `git push` and only allow commits when explicitly requested. Pass `--sandbox` for tasks that must stay strictly inside their working directory.

## Language

The skill instructions, brief template, supervisor events, and run rules are written in Chinese. Major models handle them cleanly, and you can talk to your lead agent in any language while seeing Chinese event lines.

## Tests

```bash
node --test skills/agent-foreman/tests/*.test.mjs
```

Tests run against local mock `codex`, `dsh`, and `agy` executables with no network or accounts required.

## License

MIT
