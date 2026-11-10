#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const dir = process.env.FAKE_CODEX_STATE_DIR;
fs.mkdirSync(dir, { recursive: true });
let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;
const argv = process.argv.slice(2);
const countFile = path.join(dir, 'count');
const count = Number(fs.existsSync(countFile) ? fs.readFileSync(countFile, 'utf8') : 0) + 1;
fs.writeFileSync(countFile, String(count));
const thread = argv.includes('--session-id') ? argv[argv.indexOf('--session-id') + 1] : 'session-fake-dsh-001';
const patch = fs.readFileSync(argv[argv.indexOf('--patch') + 1], 'utf8');
fs.appendFileSync(path.join(dir, 'calls.jsonl'), JSON.stringify({ argv, prompt, patch, cwd: process.cwd(), pid: process.pid, thread }) + '\n');
// Mimic the launcher's pass-through boundary; a late --patch must fail in tests too.
if (argv.indexOf('--patch') > argv.indexOf('--json')) throw new Error('Launcher --patch must precede headless --json');
const emit = (event) => console.log(JSON.stringify(event));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const gate = async (name) => { while (!fs.existsSync(`${process.env.FAKE_DSH_GATE}.${name}`)) await sleep(20); };
const scenario = process.env.FAKE_CODEX_SCENARIO;
emit({ type: 'session', sessionId: thread, cwd: process.cwd() });
emit({ type: 'status', phase: 'turn_start', turn: count });
emit({ type: 'status', phase: 'step_start', turn: count, step: 1 });
if (scenario === 'fatal' || (scenario === 'retry-then-ok' && count === 1)) {
  const error = JSON.parse(process.env.FAKE_DSH_ERROR || '{"code":"MISSING_CREDENTIAL","message":"No credential configured"}');
  emit({ type: 'final', sessionId: thread, reason: { kind: 'error', error }, text: '' });
  process.exit(1);
}
if (scenario === 'abnormal' || (scenario === 'missing-final-then-ok' && count === 1)) {
  process.stderr.write('executor exited unexpectedly\n');
  process.exit(scenario === 'abnormal' ? 1 : 0);
}
emit({ type: 'thinking', text: '' });
emit({ type: 'tool_call', callId: 'call-1', tool: 'bash', input: { command: "/bin/zsh -lc 'echo hello'", description: 'Print hello' } });
if (scenario === 'activity') {
  await gate('text');
  emit({ type: 'tool_result', callId: 'call-1', status: 'completed', result: 'hello' });
  emit({ type: 'text', text: '正在整理数据\n第二行' });
  await gate('tool');
  emit({ type: 'tool_call', callId: 'call-2', tool: 'read', input: { path: '/tmp/example' } });
  await gate('done');
}
if (scenario === 'network') {
  const worker = spawn(process.execPath, ['-e', 'const parent = process.ppid; setInterval(() => { if (process.ppid !== parent) process.exit(0); }, 100)'], { stdio: 'ignore' });
  fs.writeFileSync(path.join(dir, 'worker.pid'), String(worker.pid));
  await sleep(600_000);
}
if (scenario === 'hang') await sleep(600_000);
if (scenario === 'heartbeat') for (let i = 0; i < 25; i++) {
  await sleep(40);
  emit({ type: 'status', phase: 'step_start', turn: count, step: i + 2 });
  emit({ type: 'tool_result', callId: 'call-1', status: 'completed', result: 'hello' });
}
let reply = '假 DSH 回复：任务完成。\n第二行完整保留。\n我自己做的决定：无';
if (scenario === 'ask-protocol') {
  const ask = prompt.match(/^  (FOREMAN_RUN_DIR=.* node .* ask .*?) <<'EOF'$/m)?.[1];
  if (!ask) throw new Error('Missing protocol ask command');
  const child = spawn('/bin/sh', ['-c', ask], { stdio: ['pipe', 'pipe', 'inherit'] });
  fs.appendFileSync(path.join(dir, 'ask-pids.jsonl'), String(child.pid) + '\n');
  child.stdin.end('问题：选择 A 吗？');
  let answer = '';
  child.stdout.on('data', (chunk) => { answer += chunk; });
  if (await new Promise((resolve) => child.on('close', resolve)) !== 0) throw new Error('ask failed');
  fs.writeFileSync(path.join(dir, 'answer.txt'), answer);
  const inbox = prompt.match(/每完成一个步骤，运行 (FOREMAN_RUN_DIR=.*? inbox .*?)，查看/)?.[1];
  if (!inbox) throw new Error('Missing protocol inbox command');
  const result = spawnSync('/bin/sh', ['-c', inbox], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
  fs.writeFileSync(path.join(dir, 'inbox.txt'), result.stdout);
  reply = `按回答完成：${answer}\n我自己做的决定：无`;
}
if (scenario === 'scope-change') {
  fs.writeFileSync(path.join(process.env.FAKE_SCOPE_ROOT, 'outside', `turn-${count}.txt`), 'outside change');
  fs.writeFileSync(path.join(process.cwd(), `inside-${count}.txt`), 'inside change');
}
if (scenario === 'empty') reply = '';
emit({ type: 'tool_result', callId: 'call-1', status: 'completed', result: 'hello' });
emit({ type: 'text', text: reply });
emit({ type: 'status', phase: 'turn_end', turn: count, reason: { kind: 'completed' } });
const final = { type: 'final', sessionId: thread, reason: { kind: 'completed' }, text: reply };
if (scenario === 'no-newline') process.stdout.write(JSON.stringify(final));
else emit(final);
