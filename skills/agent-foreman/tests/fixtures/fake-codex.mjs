#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
const dir = process.env.FAKE_CODEX_STATE_DIR;
fs.mkdirSync(dir, { recursive: true });
let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;
const argv = process.argv.slice(2);
if (argv[0] === 'debug' && argv[1] === 'models') {
  fs.appendFileSync(path.join(dir, 'model-calls.jsonl'), JSON.stringify({ argv, pid: process.pid }) + '\n');
  if (process.env.FAKE_MODELS_MODE === 'timeout') await new Promise((resolve) => setTimeout(resolve, 600_000));
  if (process.env.FAKE_MODELS_MODE === 'fail') process.exit(1);
  fs.writeFileSync(1, process.env.FAKE_MODELS_MODE === 'invalid' ? 'not json' : fs.readFileSync(
    process.env.FAKE_MODELS_FILE || new URL('./models-sample.json', import.meta.url), 'utf8'));
  process.exit(0);
}
const countFile = path.join(dir, 'count');
const count = Number(fs.existsSync(countFile) ? fs.readFileSync(countFile, 'utf8') : 0) + 1;
fs.writeFileSync(countFile, String(count));
const resume = argv.indexOf('resume');
const thread = resume < 0 ? 'fake-thread-001' : argv[resume + 1];
fs.appendFileSync(path.join(dir, 'calls.jsonl'), JSON.stringify({ argv, prompt, pid: process.pid, thread }) + '\n');
const emit = (event) => console.log(JSON.stringify(event));
const item = (type, data = {}, event = 'item.completed') => emit({ type: event, item: { type, ...data } });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
emit({ type: 'thread.started', thread_id: thread });
emit({ type: 'turn.started' });
const scenario = process.env.FAKE_CODEX_SCENARIO;
if (scenario === 'fatal' || (scenario === 'retry-then-ok' && count === 1)) {
  const message = scenario === 'fatal' ? '401 Unauthorized' : '429 Selected model is at capacity';
  emit({ type: 'error', message });
  emit({ type: 'turn.failed', error: { message } });
  process.exitCode = 1;
} else {
  item('command_execution', { command: "/bin/zsh -lc 'echo hello\necho second'" }, 'item.started');
  if (scenario === 'network') {
    const worker = spawn(process.execPath, ['-e', 'const parent = process.ppid; setInterval(() => { if (process.ppid !== parent) process.exit(0); }, 100)'], { stdio: 'ignore' });
    fs.writeFileSync(path.join(dir, 'worker.pid'), String(worker.pid));
    item('agent_message', { text: process.env.FAKE_INTENT || '编写长文件\n这里不是首行' });
    if (process.env.FAKE_EVENT_DELAY) setTimeout(() => item('command_execution', { command: 'echo event' }, 'item.started'), Number(process.env.FAKE_EVENT_DELAY));
    if (process.env.FAKE_EVENT_FILE) {
      const timer = setInterval(() => {
        if (!fs.existsSync(process.env.FAKE_EVENT_FILE)) return;
        clearInterval(timer);
        item('command_execution', { command: 'echo event' }, 'item.started');
      }, 50);
    }
    await sleep(600_000);
  }
  if (scenario === 'stall-then-ok' && count === 1) await sleep(600_000);
  let reply = '假 Codex 回复：任务完成。\n第二行完整保留。';
  if (scenario === 'ask-protocol' || scenario === 'ask' || scenario === 'ask-timeout' || scenario === 'ask-no-wait') {
    const protocolAsk = scenario === 'ask-protocol' ? prompt.match(/^  (FOREMAN_RUN_DIR=.* node .* ask .*?) <<'EOF'$/m)?.[1] : null;
    if (scenario === 'ask-protocol' && !protocolAsk) throw new Error('Missing protocol ask command');
    const child = protocolAsk ? spawn('/bin/sh', ['-c', protocolAsk], { stdio: ['pipe', 'pipe', 'inherit'] }) : spawn(process.execPath, [process.env.FAKE_RUNNER, 'ask', 'task', ...(scenario === 'ask-timeout' ? ['--wait-min', '0.003'] : scenario === 'ask-no-wait' ? ['--no-wait'] : [])], { stdio: ['pipe', 'pipe', 'inherit'] });
    fs.appendFileSync(path.join(dir, 'ask-pids.jsonl'), String(child.pid) + '\n');
    child.stdin.end(process.env.FAKE_QUESTION || '问题：选哪一种？\n倾向 A，因为简单。');
    // Model a resumed executor while the separate ask process is shutting down.
    const answerActivity = process.env.FAKE_ANSWER_ACTIVITY ? setInterval(() => {
      const answers = path.join(process.env.FOREMAN_RUN_DIR, 'task', 'answers');
      if (fs.existsSync(answers) && fs.readdirSync(answers).length) item('reasoning');
    }, 50) : null;
    let answer = '';
    child.stdout.on('data', (chunk) => { answer += chunk; });
    const code = await new Promise((resolve) => child.on('close', resolve));
    clearInterval(answerActivity);
    if (code !== 0) throw new Error('ask failed');
    fs.writeFileSync(path.join(dir, 'answer.txt'), answer);
    if (scenario === 'ask-protocol') {
      const command = prompt.match(/每完成一个步骤，运行 (FOREMAN_RUN_DIR=.*? inbox .*?)，查看/)?.[1];
      if (!command) throw new Error('Missing protocol inbox command');
      const result = spawnSync('/bin/sh', ['-c', command], { encoding: 'utf8' });
      if (result.status !== 0) throw new Error(result.stderr);
      fs.writeFileSync(path.join(dir, 'inbox.txt'), result.stdout);
    }
    await sleep(Number(process.env.FAKE_AFTER_ANSWER_MS) || (scenario === 'ask-no-wait' ? 1200 : 0));
    reply = `按回答完成：${answer}\n我自己做的决定：无`;
  }
  if (scenario === 'decisions') reply += '\n我自己做的决定：无';
  if (scenario === 'delayed-ok') await sleep(2000);
  if (scenario === 'scope-change') {
    fs.writeFileSync(path.join(process.env.FAKE_SCOPE_ROOT, 'outside', `turn-${count}.txt`), 'outside change');
    fs.writeFileSync(path.join(process.cwd(), `inside-${count}.txt`), 'inside change');
  }
  if (scenario === 'slow') for (let i = 0; i < 60; i++) {
    item('reasoning');
    await sleep(1000);
  }
  item('command_execution', { command: 'echo hello', exit_code: 0 });
  item('file_change', { changes: [{ path: 'src/example.js' }, { path: 'src/other.js' }] });
  item('file_change'); // Missing optional fields must be harmless.
  item('agent_message', { text: reply });
  fs.writeFileSync(argv[argv.indexOf('-o') + 1], reply);
  emit({ type: 'turn.completed' });
}
