#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const dir = process.env.FAKE_CODEX_STATE_DIR;
fs.mkdirSync(dir, { recursive: true });
const argv = process.argv.slice(2);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
if (argv[0] === 'models') {
  fs.appendFileSync(path.join(dir, 'agy-model-calls.jsonl'), JSON.stringify({ argv, pid: process.pid }) + '\n');
  if (process.env.FAKE_AGY_MODELS_MODE === 'timeout') await sleep(600_000);
  if (process.env.FAKE_AGY_MODELS_MODE === 'fail') {
    console.error(process.env.FAKE_AGY_STDERR || 'catalog unavailable');
    process.exit(1);
  }
  console.log(process.env.FAKE_AGY_MODELS || 'gemini-4-hydrogen-high\ngemini-4-hydrogen-xhigh\ngemini-4-hydrogen-medium\ngemini-4-hydrogen-low\ngemini-4-argon-high\ngemini-4-argon-medium\ngemini-4-argon-low');
  process.exit(0);
}
let stdin = '';
for await (const chunk of process.stdin) stdin += chunk;
const prompt = argv[argv.indexOf('-p') + 1];
const countFile = path.join(dir, 'count');
const count = Number(fs.existsSync(countFile) ? fs.readFileSync(countFile, 'utf8') : 0) + 1;
fs.writeFileSync(countFile, String(count));
const thread = argv.includes('--conversation') ? argv[argv.indexOf('--conversation') + 1] : 'conversation-fake-agy-001';
fs.appendFileSync(path.join(dir, 'calls.jsonl'), JSON.stringify({ argv, prompt, stdin, cwd: process.cwd(), pid: process.pid, thread }) + '\n');
const emit = (ev) => console.log(JSON.stringify(ev));
const step = (value) => emit({ event: 'step_update', step_update: value });
const scenario = process.env.FAKE_CODEX_SCENARIO;
emit({ event: 'init', conversation_id: thread });
// Later init events must not replace the first conversation id.
emit({ event: 'init', conversation_id: 'do-not-replace' });
if (process.env.FAKE_AGY_STDERR) console.error(process.env.FAKE_AGY_STDERR);
if (scenario === 'abnormal' || (scenario === 'missing-result-then-ok' && count === 1)) {
  console.error('executor exited unexpectedly');
  process.exit(Number(process.env.FAKE_AGY_EXIT || 0));
}
if (scenario === 'fatal' || (scenario === 'retry-then-ok' && count === 1)) {
  emit({ event: 'result', result: { status: process.env.FAKE_AGY_STATUS || 'ERROR', error: process.env.FAKE_AGY_ERROR } });
  if (process.env.FAKE_AGY_HANG_ERROR) await sleep(600_000);
  process.exit(Number(process.env.FAKE_AGY_EXIT || 0));
}
step({ step_index: 1, state: 'ACTIVE', step_type: 'tool', tool_name: 'run_command', tool_info: { parameters: { CommandLine: "/bin/zsh -lc 'echo hello'" } } });
if (scenario === 'activity') {
  const updates = [
    { step_index: 1, state: 'DONE', step_type: 'tool', tool_name: 'run_command', tool_info: { parameters: { CommandLine: 'echo hello' } } },
    { step_index: 2, state: 'ACTIVE', step_type: 'agent_response', text_delta: '正在' },
    { step_index: 2, state: 'ACTIVE', step_type: 'agent_response', text_delta: '整理数据' },
    { step_index: 3, state: 'ACTIVE', step_type: 'agent_response', text_delta: '新的一步' },
    { step_index: 4, state: 'ACTIVE', step_type: 'tool', tool_name: 'write_file', tool_info: { parameters: { Content: 'body', Path: '/tmp/example.txt' } } },
    { step_index: 5, state: 'ACTIVE', step_type: 'tool', tool_name: 'search_web', tool_info: { parameters: { query: 'Argon 使用说明' } } },
  ];
  for (const [i, update] of updates.entries()) {
    while (!fs.existsSync(`${process.env.FAKE_AGY_GATE}.${i}`)) await sleep(20);
    step(update);
  }
  while (!fs.existsSync(`${process.env.FAKE_AGY_GATE}.done`)) await sleep(20);
}
if (scenario === 'network') {
  const worker = spawn(process.execPath, ['-e', 'const parent = process.ppid; setInterval(() => { if (process.ppid !== parent) process.exit(0); }, 100)'], { stdio: 'ignore' });
  fs.writeFileSync(path.join(dir, 'worker.pid'), String(worker.pid));
}
if (scenario === 'hang' || scenario === 'network' || (scenario === 'stall-then-ok' && count === 1)) await sleep(600_000);
let response = '假 Antigravity 回复：任务完成。\n第二行完整保留。\n我自己做的决定：无';
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
  response = `按回答完成：${answer}\n我自己做的决定：无`;
}
if (scenario === 'scope-change') {
  fs.writeFileSync(path.join(process.env.FAKE_SCOPE_ROOT, 'outside', `turn-${count}.txt`), 'outside change');
  fs.writeFileSync(path.join(process.cwd(), `inside-${count}.txt`), 'inside change');
}
if (scenario === 'empty') response = '';
const result = { event: 'result', result: { status: process.env.FAKE_AGY_STATUS || 'SUCCESS', response } };
if (scenario === 'no-newline') process.stdout.write(JSON.stringify(result));
else emit(result);
if (scenario === 'result-hang') {
  fs.writeFileSync(path.join(dir, 'result-at'), String(Date.now()));
  await sleep(600_000);
}
process.exitCode = Number(process.env.FAKE_AGY_EXIT || 0);
