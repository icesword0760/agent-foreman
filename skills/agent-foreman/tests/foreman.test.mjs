import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(repo, 'scripts/foreman.mjs');
const fake = path.join(repo, 'tests/fixtures/fake-codex.mjs');
const fakeDsh = path.join(repo, 'tests/fixtures/fake-dsh.mjs');
const sampleModels = JSON.parse(fs.readFileSync(path.join(repo, 'tests/fixtures/models-sample.json'), 'utf8')).models;
const model = (slug, extra = {}) => ({ slug, visibility: 'list', supported_in_api: true, supported_reasoning_levels: ['medium'], ...extra });
function setModels(f, models) {
  f.env.FAKE_MODELS_FILE = path.join(f.root, 'models.json');
  fs.writeFileSync(f.env.FAKE_MODELS_FILE, JSON.stringify({ models }));
}
function modelCalls(f) {
  const file = path.join(f.root, 'fake/model-calls.jsonl');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse) : [];
}
function writeModelCache(f, extra = {}) {
  fs.mkdirSync(f.runs, { recursive: true });
  fs.writeFileSync(path.join(f.runs, '.model-resolution.json'), JSON.stringify({
    model: 'gpt-5.6-astra', effort: 'medium', at: new Date().toISOString(), candidates: [], ...extra,
  }));
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function until(fn) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) { if (fn()) return; await sleep(50); }
  throw new Error('Timed out waiting for condition');
}
function fixture(t, scenario, defaultRuns = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-test-'));
  const runs = defaultRuns ? path.join(root, '.claude', 'agent-foreman', 'runs') : path.join(root, 'runs');
  const records = path.join(root, 'fake');
  const env = { ...process.env, FOREMAN_RUN_DIR: runs, CODEX_HOME: path.join(root, 'codex-home'), CODEX_BIN: fake, DSH_BIN: fakeDsh, FOREMAN_POLL_MS: '200',
    FOREMAN_NETTOP: path.join(root, 'missing-nettop'), FAKE_RUNNER: script, FAKE_CODEX_STATE_DIR: records, FAKE_CODEX_SCENARIO: scenario };
  if (defaultRuns) { env.HOME = root; delete env.FOREMAN_RUN_DIR; }
  delete env.MATOU_AGENT_STATUS_DIR;
  const state = (task = 'task') => JSON.parse(fs.readFileSync(path.join(runs, task, 'state.json'), 'utf8'));
  const calls = () => fs.readFileSync(path.join(records, 'calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const feed = (task = 'task') => fs.readFileSync(path.join(runs, task, 'feed.log'), 'utf8');
  const launched = [];
  function launch(args, input = '', pipeline = false) {
    const executable = pipeline ? '/bin/bash' : process.execPath;
    const argv = pipeline ? ['-o', 'pipefail', '-c', '"$@" | tail -3', 'pipeline', process.execPath, script, ...args] : [script, ...args];
    const child = spawn(executable, argv, { cwd: repo, env, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    let stdout = '', stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
    const result = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code) => resolve({ code, stdout, stderr }));
    });
    launched.push({ child, result });
    return { child, result, output: () => stdout };
  }
  const run = (args, input) => launch(args, input).result;
  const start = (extra = []) => ['start', 'task', '--cd', root, '--idle-min', '0.05', '--warn-min', '0.02',
    '--max-min', '1', '--backoff', '0.01', '--retries', '1', ...extra];
  t.after(async () => {
    if (fs.existsSync(runs)) for (const task of fs.readdirSync(runs)) {
      if (!fs.existsSync(path.join(runs, task, 'state.json'))) continue;
      const s = state(task);
      if (alive(s.supervisorPid) || alive(s.pid)) await run(['stop', task]);
    }
    if (fs.existsSync(path.join(records, 'calls.jsonl'))) {
      for (const call of calls()) await until(() => !alive(call.pid));
    }
    for (const { child, result } of launched) {
      if (child.exitCode == null && child.signalCode == null) child.kill('SIGTERM');
      await result;
    }
    const askPids = path.join(records, 'ask-pids.jsonl');
    const modelPids = path.join(records, 'model-calls.jsonl');
    if (fs.existsSync(modelPids)) for (const { pid } of fs.readFileSync(modelPids, 'utf8').trim().split('\n').map(JSON.parse)) {
      await until(() => !alive(pid));
    }
    if (fs.existsSync(askPids)) for (const pid of fs.readFileSync(askPids, 'utf8').trim().split('\n').map(Number)) {
      await until(() => !alive(pid));
    }
    const workerFile = path.join(records, 'worker.pid');
    if (fs.existsSync(workerFile)) await until(() => !alive(Number(fs.readFileSync(workerFile, 'utf8'))));
    const networkCalls = path.join(records, 'nettop-calls.jsonl');
    if (fs.existsSync(networkCalls)) for (const { pid } of fs.readFileSync(networkCalls, 'utf8').trim().split('\n').map(JSON.parse)) {
      await until(() => !alive(pid));
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, runs, env, state, calls, feed, launch, run, start, launchPipeline: (args, input) => launch(args, input, true) };
}

function writeConfig(f, text) {
  fs.mkdirSync(f.env.CODEX_HOME, { recursive: true });
  const file = path.join(f.env.CODEX_HOME, 'config.toml');
  fs.writeFileSync(file, text);
  return file;
}

for (const [name, flags, fullAccess] of [
  ['default danger-full-access', [], true],
  ['explicit --sandbox workspace-write', ['--sandbox'], false],
  ['compatible --full-access', ['--full-access'], true],
  ['sandbox network and add-dir', ['--sandbox', '--network', '--add-dir', os.tmpdir()], false],
  ['last access flag wins: sandbox', ['--full-access', '--sandbox'], false],
  ['last access flag wins: full-access', ['--sandbox', '--full-access'], true],
]) test(`sandbox start: ${name}`, async (t) => {
  const f = fixture(t, 'ok');
  const config = '[mcp_servers.docs]\ncommand="docs"\n[mcp_servers.docs.tools.read]\napproval_mode="prompt"\n';
  const file = writeConfig(f, config);
  const result = await f.run(f.start(flags), 'permissions');
  assert.equal(result.code, 0, result.stderr);
  assert.equal(f.state().options.fullAccess, fullAccess);
  const { argv } = f.calls()[0];
  assert.equal(argv[argv.indexOf('-s') + 1], fullAccess ? 'danger-full-access' : 'workspace-write');
  assert.equal(argv[argv.indexOf('approval_policy="never"') - 1], '-c');
  assert.equal(argv.includes('sandbox_workspace_write.network_access=true'), flags.includes('--network'));
  if (flags.includes('--add-dir')) assert.ok(argv.some((value, i) => value === '--add-dir' && argv[i + 1] === path.resolve(os.tmpdir())));
  assert.equal(fs.readFileSync(file, 'utf8'), config);
});

for (const command of ['send', 'resume']) {
  for (const stored of [undefined, false, true]) test(`sandbox ${command}: preserves ${stored === undefined ? 'legacy missing fullAccess' : stored}`, async (t) => {
    const f = fixture(t, 'ok');
    assert.equal((await f.run(f.start(), 'initial')).code, 0);
    await until(() => !alive(f.state().supervisorPid));
    const state = f.state();
    if (stored === undefined) delete state.options.fullAccess;
    else state.options.fullAccess = stored;
    fs.writeFileSync(path.join(f.runs, 'task/state.json'), JSON.stringify(state));
    const result = await f.run([command, 'task'], 'follow up');
    assert.equal(result.code, 0, result.stderr);
    const { argv, thread } = f.calls().at(-1);
    assert.equal(argv[argv.indexOf('-s') + 1], stored ? 'danger-full-access' : 'workspace-write');
    assert.equal(f.state().options.fullAccess, stored);
    assert.equal(argv[argv.indexOf('approval_policy="never"') - 1], '-c');
    assert.equal(thread, state.threadId);
  });

  test(`sandbox ${command}: explicit switches persist in both directions`, async (t) => {
    const f = fixture(t, 'ok');
    assert.equal((await f.run(f.start(['--sandbox']), 'initial')).code, 0);
    for (const flags of [['--full-access'], [], ['--sandbox'], []]) {
      await until(() => !alive(f.state().supervisorPid));
      assert.equal((await f.run([command, 'task', ...flags], 'follow up')).code, 0);
    }
    assert.deepEqual(f.calls().map(({ argv }) => argv[argv.indexOf('-s') + 1]),
      ['workspace-write', 'danger-full-access', 'danger-full-access', 'workspace-write', 'workspace-write']);
    assert.equal(f.state().options.fullAccess, false);
  });
}

test('sandbox default: reports new out-of-scope git changes each turn', async (t) => {
  const f = fixture(t, 'scope-change');
  assert.equal(spawnSync('git', ['init', f.root]).status, 0);
  // git reports the canonical root on macOS (/private/var rather than /var).
  const sub = path.join(fs.realpathSync(f.root), 'sub');
  fs.mkdirSync(sub);
  fs.writeFileSync(path.join(f.root, '.gitignore'), '/fake/\n/runs/\n');
  fs.mkdirSync(path.join(f.root, 'outside'));
  fs.writeFileSync(path.join(f.root, 'outside/existing.txt'), 'pre-existing');
  f.env.FAKE_SCOPE_ROOT = f.root;
  assert.equal((await f.run(f.start(['--cd', sub]), 'initial')).code, 0);
  assert.match(f.feed(), /outside\/turn-1\.txt/);
  assert.doesNotMatch(f.feed(), /existing\.txt|inside-1\.txt/);
  await until(() => !alive(f.state().supervisorPid));
  assert.equal((await f.run(['send', 'task'], 'next')).code, 0);
  assert.equal(f.feed().split('outside/turn-1.txt').length - 1, 1);
  assert.match(f.feed(), /outside\/turn-2\.txt/);
  await until(() => !alive(f.state().supervisorPid));
  assert.equal((await f.run(['send', 'task', '--sandbox'], 'restricted')).code, 0);
  assert.doesNotMatch(f.feed(), /outside\/turn-3\.txt/);
});

for (const command of ['start', 'send', 'resume']) test(`${command} rejects custom root instructions before launching`, async (t) => {
  const f = fixture(t, 'ok');
  if (command !== 'start') {
    assert.equal((await f.run(f.start(), 'initial')).code, 0);
    await until(() => !alive(f.state().supervisorPid));
  }
  const file = writeConfig(f, '# user config\n  model_instructions_file = "/tmp/custom # instructions.md" # comment\n[tools]\n');
  const before = command === 'start' ? null : fs.readFileSync(path.join(f.runs, 'task/state.json'), 'utf8');
  const result = await f.run(command === 'start' ? f.start() : [command, 'task'], 'blocked');
  assert.equal(result.code, 1);
  assert.equal(result.stderr.split('\n')[0], `你的 Codex 配置里设置了自定义指令文件（/tmp/custom # instructions.md）。按约定，监工派的任务只使用 Codex 官方指令。请先从 ${file} 去掉这一行再派活。`);
  if (before === null) {
    assert.equal(fs.existsSync(path.join(f.runs, 'task/state.json')), false);
    assert.equal(modelCalls(f).length, 0);
    assert.equal(fs.existsSync(path.join(f.root, 'fake/calls.jsonl')), false);
  } else {
    assert.equal(fs.readFileSync(path.join(f.runs, 'task/state.json'), 'utf8'), before);
    assert.equal(f.calls().length, 1);
  }
});

for (const config of [null, '# model_instructions_file = "ignored"\n', '[profile]\nmodel_instructions_file = "ignored"\n', '  # model_instructions_file = "ignored"\r\n[[tools]]\r\nmodel_instructions_file = "ignored"\r\n']) {
  test(`start and send allow missing or non-root instructions: ${JSON.stringify(config)}`, async (t) => {
    const f = fixture(t, 'ok');
    if (config !== null) writeConfig(f, config);
    assert.equal((await f.run(f.start(), 'initial')).code, 0);
    await until(() => !alive(f.state().supervisorPid));
    assert.equal((await f.run(['send', 'task'], 'follow up')).code, 0);
    for (const { argv } of f.calls()) {
      assert.equal(argv.includes('--ignore-user-config'), false);
      assert.equal(argv[argv.indexOf('service_tier="default"') - 1], '-c');
      assert.ok(argv.includes('--skip-git-repo-check'));
      assert.ok(argv.includes('unbounded_connection_retries'));
    }
  });
}

test('unreadable config logs the failure and allows start and send', async (t) => {
  const f = fixture(t, 'ok');
  fs.mkdirSync(path.join(f.env.CODEX_HOME, 'config.toml'), { recursive: true });
  assert.equal((await f.run(f.start(), 'initial')).code, 0);
  await until(() => !alive(f.state().supervisorPid));
  assert.equal((await f.run(['send', 'task'], 'follow up')).code, 0);
  const log = fs.readFileSync(path.join(f.runs, 'task/supervisor.log'), 'utf8');
  assert.equal(log.split('跳过配置检查。').length - 1, 2);
  assert.ok(log.includes(path.join(f.env.CODEX_HOME, 'config.toml')));
});

test('unset CODEX_HOME checks the config under HOME', async (t) => {
  const f = fixture(t, 'ok');
  f.env.HOME = f.root;
  f.env.CODEX_HOME = path.join(f.root, '.codex');
  const file = writeConfig(f, "model_instructions_file = 'custom.md'\n");
  delete f.env.CODEX_HOME;
  const result = await f.run(f.start(), 'blocked');
  assert.equal(result.code, 1);
  assert.equal(result.stderr.split('\n')[0], `你的 Codex 配置里设置了自定义指令文件（custom.md）。按约定，监工派的任务只使用 Codex 官方指令。请先从 ${file} 去掉这一行再派活。`);
});

for (const effort of ['medium', 'ultra']) test(`best selects sample astra with ${effort}, publishes model and caches resolution`, async (t) => {
  const f = fixture(t, 'ok');
  const result = await f.run(f.start(['--model', 'best', '--effort', effort]), 'select');
  assert.equal(result.code, 0, result.stderr);
  assert.equal(f.state().options.model, 'gpt-6-astra');
  assert.equal(f.state().options.modelRequest, 'best');
  assert.ok(f.feed().includes(`▶ task 第 1 轮开始（新会话 · gpt-6-astra · ${effort}）`));
  const args = f.calls()[0].argv;
  assert.equal(args[args.indexOf('-m') + 1], 'gpt-6-astra');
  assert.ok(args.includes(`model_reasoning_effort="${effort}"`));
  const status = await f.run(['status', 'task']);
  const data = JSON.parse(status.stdout.split('\n--- last message ---')[0]);
  assert.equal(data.model, 'gpt-6-astra');
  assert.equal(data.effort, effort);
  const cache = JSON.parse(fs.readFileSync(path.join(f.runs, '.model-resolution.json'))).entries[`best:${effort}`];
  assert.equal(cache.model, 'gpt-6-astra');
  assert.equal(cache.effort, effort);
  assert.ok(Number.isFinite(Date.parse(cache.at)));
  assert.ok(cache.candidates.includes('gpt-6.1-sol'));
});

const selectionCases = [
  ['without astra', sampleModels.filter((m) => m.slug !== 'gpt-6-astra'), 'gpt-6.1-sol'],
  ['filter visibility API and effort', [model('gpt-9-astra', { visibility: 'hide' }), model('gpt-8-astra', { supported_in_api: false }), model('gpt-7-astra', { supported_reasoning_levels: ['high'] }), model('gpt-6-sol', { supported_reasoning_levels: [{ effort: 'medium' }] })], 'gpt-6-sol'],
  ['numeric version segments', ['gpt-6-sol', 'gpt-6.2-sol', 'gpt-5.99-sol', 'gpt-6.10-sol', 'gpt-6.10.1-sol', 'gpt-99-luna'].map((s) => model(s)), 'gpt-6.10.1-sol'],
  ['upgrade one hop', [model('gpt-6-astra', { upgrade: 'gpt-6-sol' }), model('gpt-6-sol', { upgrade: 'gpt-6-luna' }), model('gpt-6-luna')], 'gpt-6-sol'],
  ['upgrade unavailable', [model('gpt-6-astra', { upgrade: 'gpt-7-astra' }), model('gpt-7-astra', { visibility: 'hide' })], 'gpt-6-astra'],
  ['unknown upgrade ignored', [model('gpt-6-astra', { upgrade: 'gpt-9-nova' }), model('gpt-9-nova')], 'gpt-6-astra'],
  ['strict slug', [model('gpt-99-astra-preview'), model('gpt-astra'), model('gpt-6-sol')], 'gpt-6-sol'],
];
for (const [name, models, expected] of selectionCases) test(`model selection: ${name}`, async (t) => {
  const f = fixture(t, 'ok');
  setModels(f, models);
  const result = await f.run(f.start(['--model', 'best', '--effort', 'medium']), 'select');
  assert.equal(result.code, 0, result.stderr);
  assert.equal(f.state().options.model, expected);
  if (name === 'unknown upgrade ignored') assert.match(result.stdout, /⚠ 模型目录里有未识别的系列：gpt-9-nova，本次未采用，请确认是否为更高档/);
});

test('no eligible known model fails even with a stale cache', async (t) => {
  const f = fixture(t, 'ok');
  writeModelCache(f, { at: '2000-01-01T00:00:00Z' });
  setModels(f, [model('gpt-9-nova'), model('gpt-6-astra', { supported_reasoning_levels: ['low'] })]);
  const result = await f.run(f.start(['--model', 'best', '--effort', 'medium']), 'select');
  assert.equal(result.code, 1);
  assert.match(result.stderr, /没有找到支持 medium 推理档位的可用模型/);
  assert.match(f.feed(), /未识别的系列：gpt-9-nova/);
});

for (const mode of ['fail', 'invalid']) for (const cached of [false, true]) test(`catalog ${mode}, cache=${cached}`, async (t) => {
  const f = fixture(t, 'ok');
  f.env.FAKE_MODELS_MODE = mode;
  if (cached) writeModelCache(f, { at: '2000-01-01T00:00:00Z' });
  const result = await f.run(f.start(['--model', 'best', '--effort', 'medium']), 'select');
  assert.equal(result.code, cached ? 0 : 1, result.stderr);
  if (cached) {
    assert.equal(f.state().options.model, 'gpt-5.6-astra');
    assert.match(result.stdout, /⚠ 获取模型目录失败，沿用上次解析的 gpt-5.6-astra/);
  } else assert.match(result.stderr, /无法获取 Codex 模型目录/);
});

test('catalog times out after 20 seconds and leaves no process', async (t) => {
  const f = fixture(t, 'ok');
  f.env.FAKE_MODELS_MODE = 'timeout';
  const begin = Date.now();
  const result = await f.run(f.start(['--model', 'best', '--effort', 'medium']), 'select');
  assert.equal(result.code, 1);
  assert.match(result.stderr, /无法获取 Codex 模型目录/);
  assert.ok(Date.now() - begin >= 19_000 && Date.now() - begin < 25_000);
  assert.equal(alive(modelCalls(f)[0].pid), false);
});

test('explicit main model bypasses main resolution; send inherits or explicitly resolves again', async (t) => {
  const f = fixture(t, 'ok');
  assert.equal((await f.run(f.start(['--model', 'custom-model', '--effort', 'medium']), 'one')).code, 0);
  assert.equal(modelCalls(f).length, 1); // Only the terra delegate is resolved.
  await until(() => !alive(f.state().supervisorPid));
  assert.equal((await f.run(['send', 'task', '--model', 'best'], 'two')).code, 0);
  assert.equal(f.state().options.model, 'gpt-6-astra');
  setModels(f, [model('gpt-7-astra')]);
  await until(() => !alive(f.state().supervisorPid));
  assert.equal((await f.run(['send', 'task'], 'three')).code, 0);
  assert.equal(f.state().options.model, 'gpt-7-astra');
  assert.equal(modelCalls(f).length, 3);
  await until(() => !alive(f.state().supervisorPid));
  assert.equal((await f.run(['send', 'task', '--model', 'best'], 'four')).code, 0);
  assert.equal(f.state().options.model, 'gpt-7-astra');
  assert.equal(modelCalls(f).length, 4);
  await until(() => !alive(f.state().supervisorPid));
  assert.equal((await f.run(['send', 'task', '--model', 'another', '--effort', 'high'], 'five')).code, 0);
  assert.equal(f.state().options.model, 'another');
  assert.equal(f.state().options.effort, 'high');
  assert.equal(f.state().options.modelRequest, undefined);
  assert.equal(modelCalls(f).length, 5);
});

for (const kind of ['fresh', 'expired', 'effort', 'refresh']) test(`start cache: ${kind}`, async (t) => {
  const f = fixture(t, 'ok');
  writeModelCache(f, kind === 'expired' ? { at: new Date(Date.now() - 25 * 60 * 60_000).toISOString() } : kind === 'effort' ? { effort: 'high' } : {});
  const result = await f.run(f.start(['--model', 'best', '--effort', 'medium', ...(kind === 'refresh' ? ['--refresh-models'] : [])]), 'select');
  assert.equal(result.code, 0, result.stderr);
  assert.equal(modelCalls(f).length, 1); // A fresh main cache still needs a terra resolution.
  assert.equal(f.state().options.model, kind === 'fresh' ? 'gpt-5.6-astra' : 'gpt-6-astra');
});

test('models table orders tiers, displays effort and visibility, and labels cache source', async (t) => {
  const f = fixture(t, 'ok');
  const result = await f.run(['models', '--effort', 'ultra']);
  assert.equal(result.code, 0, result.stderr);
  const lines = result.stdout.trim().split('\n');
  assert.equal(lines[0], 'slug\t档位\t版本\t支持 ultra\tvisibility');
  assert.equal(lines[1], 'gpt-6-astra\t前沿\t6\t是\tlist');
  assert.equal(lines[2], 'gpt-6.1-sol\t主力\t6.1\t是\tlist');
  assert.ok(lines.includes('gpt-6-luna\t快速\t6\t否\tlist'));
  assert.ok(lines.includes('gpt-reserve\t未识别\t-\t否\thide'));
  assert.equal(lines.at(-2), 'best → gpt-6-astra（推理档位 ultra）（刚刚解析）');
  const cached = await f.run(['models', '--effort', 'ultra']);
  assert.equal(modelCalls(f).length, 1);
  assert.match(cached.stdout, /（来自缓存，.* 解析）/);
  assert.deepEqual(cached.stdout.trim().split('\n').slice(0, -2), lines.slice(0, -2));
  const refreshed = await f.run(['models', '--effort', 'ultra', '--refresh-models']);
  assert.equal(modelCalls(f).length, 2);
  assert.match(refreshed.stdout, /（刚刚解析）/);
});

test('retries reuse one resolved model', async (t) => {
  const f = fixture(t, 'retry-then-ok');
  assert.equal((await f.run(f.start(['--model', 'best', '--effort', 'medium']), 'retry')).code, 0);
  assert.equal(modelCalls(f).length, 1);
  assert.equal(f.calls().length, 2);
  for (const call of f.calls()) assert.equal(call.argv[call.argv.indexOf('-m') + 1], 'gpt-6-astra');
});

test('ok: stdin brief, ordered feed, reply, thread id, and terminal watch', async (t) => {
  const f = fixture(t, 'ok');
  const result = await f.run(f.start(), '执行测试任务');
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /▶[\s\S]*✅[\s\S]*--- Codex 回复 ---[\s\S]*假 Codex 回复：任务完成。/);
  assert.doesNotMatch(result.stdout, /进行中/);
  assert.match(result.stdout, /^\d\d:\d\d:\d\d sol → gpt-6\.1-sol（推理档位 high）\n\d\d:\d\d:\d\d 界面操作子代理 → gpt-5\.6-terra（推理档位 high）\n\d\d:\d\d:\d\d ▶/);
  assert.equal(f.state().threadId, 'fake-thread-001');
  assert.match(f.calls()[0].prompt, /执行测试任务[\s\S]*运行约定/);
  const replay = await f.run(['watch', 'task']);
  assert.equal(replay.code, 0);
  assert.match(replay.stdout, /✅[\s\S]*第二行完整保留。/);
  assert.doesNotMatch(replay.stdout, /▶/);
  t.diagnostic('ok feed.log 原文：\n' + f.feed());
});

test('send: stdin and legacy resume --message preserve thread', async (t) => {
  const f = fixture(t, 'ok');
  assert.equal((await f.run(f.start(), 'initial')).code, 0);
  await until(() => !alive(f.state().supervisorPid));
  const sent = await f.run(['send', 'task'], '继续修改');
  assert.equal(sent.code, 0);
  assert.doesNotMatch(sent.stdout, /进行中/);
  assert.match(sent.stdout, /^\d\d:\d\d:\d\d sol → gpt-6\.1-sol（推理档位 high）\n\d\d:\d\d:\d\d 界面操作子代理 → gpt-5\.6-terra（推理档位 high）\n\d\d:\d\d:\d\d ▶/);
  await until(() => !alive(f.state().supervisorPid));
  const message = path.join(f.root, 'message.md');
  fs.writeFileSync(message, '旧调用');
  assert.equal((await f.run(['resume', 'task', '--message', message])).code, 0);
  for (const call of f.calls().slice(1)) {
    assert.deepEqual(call.argv.slice(call.argv.indexOf('resume'), -1), ['resume', 'fake-thread-001']);
  }
  assert.match(f.calls()[1].prompt, /^继续修改/);
  assert.match(f.calls()[2].prompt, /^旧调用/);
});

test('stall-then-ok: warning, watchdog, retry, completion', async (t) => {
  const f = fixture(t, 'stall-then-ok');
  const result = await f.run(f.start(), '继续任务');
  assert.equal(result.code, 0, result.stderr);
  assert.match(f.feed(), /⏸[\s\S]*✖[\s\S]*⚠ task 卡住；0\.01 分钟后第 1\/1 次重试[\s\S]*✅/);
  assert.equal(f.calls().length, 2);
  assert.equal(f.state().turns[0].result, 'stalled');
  t.diagnostic('stall-then-ok feed.log 原文：\n' + f.feed());
});

test('retry-then-ok: capacity failure resumes and succeeds', async (t) => {
  const f = fixture(t, 'retry-then-ok');
  assert.equal((await f.run(f.start(), 'retry')).code, 0);
  assert.match(f.feed(), /⚠.*429 Selected model is at capacity.*1\/1 次重试[\s\S]*✅/);
  assert.equal(f.calls()[1].thread, f.calls()[0].thread);
});

test('fatal: failure feed and exit 2', async (t) => {
  const f = fixture(t, 'fatal');
  assert.equal((await f.run(f.start(), 'fatal')).code, 2);
  assert.match(f.feed(), /❌ task 失败：401 Unauthorized/);
  assert.equal(f.calls().length, 1);
});

test('stop: detached supervisor and Codex both exit; watch returns 5', async (t) => {
  const f = fixture(t, 'slow');
  assert.equal((await f.run(f.start(['--no-watch']), 'slow')).code, 0);
  await until(() => f.state().pid && fs.existsSync(path.join(f.root, 'fake', 'calls.jsonl')));
  const s = f.state();
  assert.equal((await f.run(['send', 'task'], 'busy')).code, 1);
  assert.equal((await f.run(['stop', 'task'])).code, 0);
  assert.equal((await f.run(['watch', 'task'])).code, 5);
  assert.match(f.feed(), /■ task 已手动停止/);
  assert.equal(alive(s.supervisorPid), false);
  assert.equal(alive(s.pid), false);
});

test('watch: reattach skips history; killing caller leaves supervisor and Codex alive', async (t) => {
  const f = fixture(t, 'slow');
  const caller = f.launch(f.start(), 'slow');
  await until(() => caller.output().includes('▶') && f.state().pid);
  caller.child.kill('SIGTERM');
  await caller.result;
  assert.equal(alive(f.state().supervisorPid), true);
  assert.equal(alive(f.state().pid), true);
  const watcher = f.launch(['watch', 'task']);
  await until(() => watcher.output().includes('进行中'));
  await sleep(2100);
  watcher.child.kill('SIGTERM');
  const result = await watcher.result;
  assert.match(result.stdout.split('\n')[0], /^\d\d:\d\d:\d\d … task 进行中：/);
  assert.doesNotMatch(result.stdout, /▶/);
  assert.equal((await f.run(['stop', 'task'])).code, 0);
});

test('watch: unexpected supervisor death returns 6 and stop cleans orphan', async (t) => {
  const f = fixture(t, 'slow');
  assert.equal((await f.run(f.start(['--no-watch']), 'slow')).code, 0);
  await until(() => f.state().pid);
  const s = f.state();
  process.kill(s.supervisorPid, 'SIGKILL');
  await until(() => !alive(s.supervisorPid));
  const result = await f.run(['watch', 'task']);
  assert.equal(result.code, 6);
  assert.match(result.stdout, /监督进程意外退出/);
  assert.equal((await f.run(['stop', 'task'])).code, 0);
  assert.equal(alive(s.pid), false);
});

test('validation: empty stdin and invalid numeric options return 1', async (t) => {
  const f = fixture(t, 'ok');
  for (const [extra, input] of [[[], '  '], [['--warn-min', 'NaN'], 'brief'], [['--backoff', '-1'], 'brief']]) {
    assert.equal((await f.run(f.start(extra), input)).code, 1);
  }
});

test('retry exhaustion returns 3; maximum turn duration returns 4', async (t) => {
  const retry = fixture(t, 'retry-then-ok');
  assert.equal((await retry.run(retry.start(['--retries', '0']), 'retry')).code, 3);
  assert.equal((await retry.run(['watch', 'task'])).code, 3);
  const timeout = fixture(t, 'slow');
  assert.equal((await timeout.run(timeout.start(['--max-min', '0.02']), 'timeout')).code, 4);
  assert.match(timeout.feed(), /⏱.*已停下，等待处理[\s\S]*❌/);
});

test('activity: command shell stripped; quiet warning recovers on stdout', async (t) => {
  const stalled = fixture(t, 'stall-then-ok');
  assert.equal((await stalled.run(stalled.start(['--no-watch']), 'activity')).code, 0);
  await until(() => stalled.state().activity === '运行 echo hello');
  assert.ok(stalled.state().activityAt);
  assert.ok(stalled.state().lastActivityAt);
  await stalled.run(['stop', 'task']);
  const slow = fixture(t, 'slow');
  assert.equal((await slow.run(slow.start(['--warn-min', '0.005', '--max-min', '0.045']), 'recover')).code, 4);
  assert.match(slow.feed(), /⏸[\s\S]*↺ task 恢复活动：思考中/);
});

test('terminal watch rereads reply and truncates to 6000 characters', async (t) => {
  const f = fixture(t, 'ok');
  const brief = path.join(f.root, 'brief.md');
  fs.writeFileSync(brief, '文件交代书');
  assert.equal((await f.run(f.start(['--brief', brief]))).code, 0);
  assert.match(f.calls()[0].prompt, /^文件交代书/);
  const last = f.state().turns.at(-1).files.last;
  fs.writeFileSync(last, '字'.repeat(6100));
  const replay = await f.run(['watch', 'task']);
  assert.equal(replay.code, 0);
  assert.equal([...replay.stdout].filter((char) => char === '字').length, 6000);
  assert.ok(replay.stdout.includes('…（完整内容见 ' + last + '）'));
});

test('outOfScope: repository root allows all; outside directories do not match', () => {
  const source = fs.readFileSync(script, 'utf8');
  const fn = source.slice(source.indexOf('function outOfScope('), source.indexOf('// One codex invocation.'));
  const outOfScope = vm.runInNewContext(fn + '\noutOfScope', { path, REPO: repo, runDir: () => '/tmp/runs/task' });
  const before = new Set([' M existing.js']);
  const after = new Set([...before, ' M tests/a.mjs', ' M scripts/b.mjs', ' M ../outside/file']);
  assert.equal(outOfScope(before, after, { task: 'task', options: { gitRoot: repo, cd: repo, addDirs: [] } }).length, 0);
  const result = outOfScope(before, after, { task: 'task', options: {
    gitRoot: repo, cd: path.join(repo, 'tests'), addDirs: [path.resolve(repo, '../outside')],
  } });
  assert.deepEqual(Array.from(result), [' M scripts/b.mjs', ' M ../outside/file']);
  assert.equal(outOfScope(before, after, { task: 'task', options: {
    gitRoot: repo, cd: path.join(repo, 'tests'), addDirs: [repo],
  } }).length, 0);
});

test('killTree: permanently alive processes stop waiting 5 seconds after SIGKILL', async () => {
  const source = fs.readFileSync(script, 'utf8');
  const fn = source.slice(source.indexOf('async function killTree('), source.indexOf('// Without the sandbox'));
  let elapsed = 0;
  const signals = [];
  const killTree = vm.runInNewContext(fn + '\nkillTree', {
    processTree: () => [123, 456],
    process: { kill: (pid, sig) => signals.push([pid, sig, elapsed]) },
    pidAlive: () => true,
    Date: { now: () => elapsed },
    sleep: async (ms) => { elapsed += ms; },
  });
  await killTree(123);
  assert.equal(elapsed, 15_000);
  assert.deepEqual(signals, [[456, 'SIGTERM', 0], [123, 'SIGTERM', 0],
    [456, 'SIGKILL', 10_000], [123, 'SIGKILL', 10_000]]);
});

const statusline = path.join(repo, 'scripts/foreman-statusline.mjs');
const stripAnsi = (text) => text.replace(/\x1b\[[0-9;]*m/g, '');
function statusFixture(t) {
  const now = Date.now();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-statusline-test-'));
  const runs = path.join(root, 'runs');
  const home = path.join(root, 'home');
  fs.mkdirSync(runs);
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const settings = (command) => fs.writeFileSync(path.join(home, '.claude/settings.json'),
    JSON.stringify({ statusLine: { command } }));
  const state = (task, value) => {
    fs.mkdirSync(path.join(runs, task), { recursive: true });
    fs.writeFileSync(path.join(runs, task, 'state.json'), JSON.stringify({ task, ...value }));
  };
  const run = (input = '{}') => spawnSync(process.execPath, ['--input-type=module', '-e',
    `Date.now = () => ${now}; await import(${JSON.stringify(statusline)});`], {
    env: { ...process.env, HOME: home, FOREMAN_RUN_DIR: runs }, input, encoding: 'utf8', timeout: 5000,
  });
  return { root, runs, home, settings, state, run, now };
}

test('statusline: HUD, activity, idle warning, recent completion, invalid stdin, and cat -v', (t) => {
  const f = statusFixture(t);
  const now = f.now;
  const ago = (ms) => new Date(now - ms).toISOString();
  f.settings('echo HUD');
  f.state('running', { status: 'running', supervisorPid: process.pid,
    activity: '运行 npm test', runStartedAt: ago(45_000), lastActivityAt: ago(1000) });
  f.state('quiet', { status: 'running', supervisorPid: process.pid,
    activity: '思考中', runStartedAt: ago(3900_000), lastActivityAt: ago(300_000) });
  f.state('completed', { status: 'completed', runStartedAt: ago(252_000), endedAt: ago(60_000) });
  f.state('old', { status: 'completed', runStartedAt: ago(3700_000), endedAt: ago(3600_000) });
  for (const input of ['{}', 'not JSON', '']) {
    const result = f.run(input);
    assert.equal(result.status, 0, result.stderr);
    const plain = stripAnsi(result.stdout);
    assert.equal(plain.split('\n')[0], 'HUD');
    assert.match(plain, /Codex·running  运行 npm test · 45秒/);
    assert.match(result.stdout, /\x1b\[33m⚠ 5分钟没动静\x1b\[0m · 1时05分/);
    assert.match(result.stdout, /\x1b\[32m✅ 本轮完成\x1b\[0m · 3分12秒/);
    assert.doesNotMatch(plain, /Codex·old/);
    assert.ok(plain.indexOf('quiet') < plain.indexOf('running'));
    assert.ok(plain.indexOf('running') < plain.indexOf('completed'));
    if (input === '{}') {
      const visible = spawnSync('cat', ['-v'], { input: result.stdout, encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } });
      assert.equal(visible.status, 0);
      t.diagnostic('状态条实际输出（cat -v）：');
      for (const line of visible.stdout.trimEnd().split('\n')) t.diagnostic(line);
    }
  }
});

test('statusline: dead supervisor, all terminal labels, line cap, and ordering', (t) => {
  const f = statusFixture(t);
  const now = Date.now();
  const iso = (offset) => new Date(now - offset).toISOString();
  f.state('legacy', { status: 'running', runStartedAt: iso(60_000) });
  f.state('failed', { status: 'failed', runStartedAt: iso(50_000), endedAt: iso(10_000) });
  f.state('timeout', { status: 'timeout', runStartedAt: iso(40_000), endedAt: iso(20_000) });
  f.state('stopped', { status: 'stopped', runStartedAt: iso(30_000), endedAt: iso(30_000) });
  f.state('waiting', { status: 'waiting-retry', supervisorPid: process.pid, runStartedAt: iso(20_000) });
  f.state('new', { status: 'new', supervisorPid: process.pid, runStartedAt: iso(10_000) });
  const names = (out) => stripAnsi(out).trimEnd().split('\n').map((line) => line.split('  ')[0]);
  const result = f.run();
  assert.equal(result.status, 0);
  // Unfinished tasks come first, then the most recently ended ones.
  assert.deepEqual(names(result.stdout), ['Codex·legacy', 'Codex·waiting', 'Codex·new', 'Codex·failed', '…另有 2 个 Codex 任务']);
  assert.match(result.stdout, /legacy  \x1b\[31m❌ 监督进程已退出/);
  assert.match(result.stdout, /waiting  \x1b\[33m等待重试/);
  assert.match(result.stdout, /new  启动中/);
  assert.match(result.stdout, /failed  \x1b\[31m❌ 失败/);
  fs.rmSync(path.join(f.runs, 'waiting'), { recursive: true });
  fs.rmSync(path.join(f.runs, 'new'), { recursive: true });
  const next = f.run();
  assert.deepEqual(names(next.stdout), ['Codex·legacy', 'Codex·failed', 'Codex·timeout', 'Codex·stopped']);
  assert.match(next.stdout, /timeout  \x1b\[31m⏱ 超时/);
  assert.match(next.stdout, /stopped  \x1b\[2m■ 已停止/);
});

test('statusline: HUD passthrough, recursion guard, failures, corrupt state, and fast empty scan', (t) => {
  const f = statusFixture(t);
  const source = fs.readFileSync(statusline, 'utf8');
  const { hud, taskLines } = vm.runInNewContext(source.slice(source.indexOf('const RUNS'), source.indexOf('// Status rendering')) + '\n({ hud, taskLines })', {
    fs, path, spawnSync, os: { ...os, homedir: () => f.home },
    process: { env: { FOREMAN_RUN_DIR: f.runs }, kill: process.kill.bind(process) },
  });
  f.settings('cat');
  assert.equal(f.run('raw input\n\n').stdout, 'raw input\n');
  f.settings('echo foreman-statusline');
  assert.equal(f.run().stdout, '');
  f.settings('echo SHOULD_NOT_APPEAR; exit 1');
  assert.equal(f.run().stdout, '');
  // exec avoids leaving a shell child behind when the HUD timeout fires.
  f.settings('exec sleep 5');
  const began = performance.now();
  assert.equal(hud(''), '');
  assert.ok(performance.now() - began < 2500);
  f.settings('');
  fs.mkdirSync(path.join(f.runs, 'bad'));
  fs.writeFileSync(path.join(f.runs, 'bad/state.json'), '{');
  const result = f.run('invalid');
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
  const start = performance.now();
  assert.equal(taskLines().length, 0);
  const elapsed = performance.now() - start;
  assert.ok(elapsed < 200, 'statusline without HUD took ' + elapsed + ' ms');
  t.diagnostic('无 HUD 的状态条扫描耗时：' + elapsed.toFixed(2) + 'ms（不含 Node 启动）');
  f.state('abcdefghijklmnop', { status: 'waiting-retry', supervisorPid: process.pid,
    runStartedAt: new Date().toISOString(), activity: '等待重试 1/3（2 分钟后）' });
  assert.match(f.run().stdout, /Codex·\x1b\[0mabcdefghijklmn  \x1b\[33m等待重试 1\/3（2 分钟后）/);
});

test('statusline: legacy live Codex uses latest turn time and running fallback', (t) => {
  const f = statusFixture(t);
  const now = f.now;
  const ago = (ms) => new Date(now - ms).toISOString();
  const legacy = {
    status: 'running', pid: process.pid, createdAt: ago(6 * 3600_000),
    turns: [{ startedAt: ago(5 * 3600_000) }, { startedAt: ago(120_000) }],
    lastActivityAt: ago(1000),
  };
  f.state('legacy-live', legacy);
  let result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(stripAnsi(result.stdout), /Codex·legacy-live  运行中 · 2分/);
  assert.doesNotMatch(result.stdout, /监督进程已退出/);

  // A supervisor that really died is flagged even while its Codex child keeps running.
  f.state('legacy-live', { ...legacy, supervisorPid: spawnSync(process.execPath, ['-e', '']).pid });
  result = f.run();
  assert.match(result.stdout, /监督进程已退出/);

  // An invalid supervisor PID falls back to the Codex PID; runStartedAt takes precedence.
  f.state('legacy-live', { ...legacy, supervisorPid: -1, runStartedAt: ago(45_000) });
  result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(stripAnsi(result.stdout), /运行中 · 45秒/);
  assert.doesNotMatch(result.stdout, /监督进程已退出/);

  // With no turns, fall back to createdAt and the startup label.
  f.state('legacy-live', { status: 'new', pid: process.pid, createdAt: ago(45_000) });
  result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(stripAnsi(result.stdout), /启动中 · 45秒/);
});

test('statusline --watch: standalone panel redraws tasks without the HUD', async (t) => {
  const f = statusFixture(t);
  f.settings('echo HUD');
  f.state('panel', { status: 'running', supervisorPid: process.pid, activity: '运行 npm test',
    runStartedAt: new Date(Date.now() - 45_000).toISOString(), lastActivityAt: new Date().toISOString() });
  const child = spawn(process.execPath, [statusline, '--watch'], {
    env: { ...process.env, HOME: f.home, FOREMAN_RUN_DIR: f.runs }, stdio: ['ignore', 'pipe', 'ignore'],
  });
  let stdout = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  const closed = new Promise((resolve, reject) => { child.once('close', resolve); child.once('error', reject); });
  try {
    await until(() => stdout.split('\x1b[H\x1b[2J').length >= 3);
    const frames = stripAnsi(stdout).split('\x1b[H\x1b[2J').filter(Boolean);
    assert.match(frames.at(-1), /^Codex 状态 · \d{1,2}:\d{2}:\d{2} 刷新\nCodex·panel · \d+(?:秒|分)\n  运行 npm test\n$/);
    assert.doesNotMatch(stdout, /HUD/);
  } finally {
    child.kill('SIGKILL');
    await closed;
  }
});
test('statusline: root-owned PID 1 is treated as alive', (t) => {
  const f = statusFixture(t);
  f.state('launchd', {
    status: 'running', supervisorPid: 1, activity: '运行中',
    runStartedAt: new Date().toISOString(),
  });
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(stripAnsi(result.stdout), /Codex·launchd  运行中/);
  assert.doesNotMatch(result.stdout, /监督进程已退出/);
});

test('pidAlive: both scripts return false only for ESRCH probe errors', () => {
  for (const file of [script, statusline]) {
    const source = fs.readFileSync(file, 'utf8');
    const start = source.indexOf('function pidAlive(');
    const fn = source.slice(start, source.indexOf('\n}', start) + 2);
    for (const code of ['ESRCH', 'EPERM', 'EACCES', undefined]) {
      const pidAlive = vm.runInNewContext(fn + '\npidAlive', {
        process: { kill: () => { throw Object.assign(new Error('probe failed'), { code }); } },
      });
      assert.equal(pidAlive(1), code !== 'ESRCH', file + ': ' + code);
    }
  }
});

function agentStatusFixture(t, scenario) {
  const f = fixture(t, scenario);
  const dir = path.join(f.root, 'agents');
  fs.mkdirSync(dir);
  f.env.MATOU_AGENT_STATUS_DIR = dir;
  return { ...f, dir, agent: (id = 'codex-task') => JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), 'utf8')) };
}

test('Matou: running metadata, quiet warning, completion and atomic cleanup', async (t) => {
  const f = agentStatusFixture(t, 'stall-then-ok');
  const run = f.launch(f.start(), 'status');
  await until(() => fs.existsSync(path.join(f.dir, 'codex-task.json')) && f.agent().detail === '运行 echo hello');
  const a = f.agent();
  assert.equal(a.version, 1);
  assert.equal(a.label, 'Codex：task（gpt-6.1-sol · 高档推理）');
  assert.equal(a.state, 'running');
  assert.equal(a.startedAt, f.state().runStartedAt);
  assert.equal(new Date(a.updatedAt).toISOString(), a.updatedAt);
  assert.ok(Date.parse(a.updatedAt) >= Date.parse(a.startedAt));
  await until(() => f.agent().state === 'warning');
  assert.match(f.agent().detail, /^\d+ 秒没有动静 · 运行 echo hello$/);
  assert.equal((await run.result).code, 0);
  assert.equal(f.agent().state, 'completed');
  assert.equal(f.agent().detail, '本轮完成');
  assert.deepEqual(fs.readdirSync(f.dir), ['codex-task.json']);
});

test('Matou: failure, timeout and internal stop publish terminal states', async (t) => {
  const f = agentStatusFixture(t, 'fatal');
  assert.equal((await f.run(f.start(), 'fatal')).code, 2);
  assert.equal(f.agent().state, 'error');
  assert.equal(f.agent().detail, f.state().error.split('\n')[0]);
  const slow = agentStatusFixture(t, 'slow');
  assert.equal((await slow.run(slow.start(['--max-min', '0.02']), 'timeout')).code, 4);
  assert.equal(slow.agent().state, 'error');
  assert.equal(slow.agent().detail, '本轮超时');
  await until(() => !alive(slow.state().supervisorPid));
  assert.equal((await slow.run(['send', 'task', '--no-watch', '--max-min', '1'], 'again')).code, 0);
  await until(() => slow.state().pid);
  assert.equal((await slow.run(['stop', 'task'])).code, 0);
  assert.equal(slow.agent().state, 'stopped');
  assert.equal(slow.agent().detail, '已手动停止');
  assert.deepEqual(fs.readdirSync(slow.dir), ['codex-task.json']);
});

test('Matou: retry backoff keeps publishing waiting heartbeats', async (t) => {
  const f = agentStatusFixture(t, 'retry-then-ok');
  const run = f.launch(f.start(['--backoff', '0.06']), 'retry');
  await until(() => fs.existsSync(path.join(f.dir, 'codex-task.json')) && f.agent().state === 'waiting');
  const first = f.agent();
  assert.equal(first.detail, '等待重试 1/1（0.06 分钟后）');
  await until(() => f.agent().updatedAt !== first.updatedAt);
  const second = f.agent();
  assert.equal(second.state, 'waiting');
  await until(() => f.agent().updatedAt !== second.updatedAt);
  assert.equal(f.agent().state, 'waiting');
  assert.equal((await run.result).code, 0);
  assert.equal(f.agent().state, 'completed');
});

test('Matou: hash Unicode task id; send updates directory and resume retains it', async (t) => {
  const f = agentStatusFixture(t, 'ok');
  const task = '商城-购物车-01';
  const args = f.start();
  args[1] = task;
  assert.equal((await f.run(args, 'start')).code, 0);
  const id = 'codex-' + createHash('sha1').update(task, 'utf8').digest('hex').slice(0, 12);
  assert.deepEqual(fs.readdirSync(f.dir), [id + '.json']);
  assert.equal(f.agent(id).label, `Codex：${task}（gpt-6.1-sol · 高档推理）`);
  await until(() => !alive(f.state(task).supervisorPid));
  const nextDir = path.join(f.root, 'next-agents');
  fs.mkdirSync(nextDir);
  f.env.MATOU_AGENT_STATUS_DIR = nextDir;
  assert.equal((await f.run(['send', task], 'send')).code, 0);
  assert.equal(f.state(task).options.agentStatusDir, nextDir);
  const read = () => JSON.parse(fs.readFileSync(path.join(nextDir, id + '.json'), 'utf8'));
  const previous = read().startedAt;
  await until(() => !alive(f.state(task).supervisorPid));
  delete f.env.MATOU_AGENT_STATUS_DIR;
  assert.equal((await f.run(['resume', task], 'resume')).code, 0);
  assert.equal(f.state(task).options.agentStatusDir, nextDir);
  assert.notEqual(read().startedAt, previous);
  assert.equal(read().state, 'completed');
});

test('Matou: missing directory is not created; absent or relative env stays disabled', async (t) => {
  for (const value of [undefined, '', 'relative-agents', 'missing']) {
    const f = fixture(t, 'ok');
    if (value !== undefined) f.env.MATOU_AGENT_STATUS_DIR = value === 'missing' ? path.join(f.root, 'missing') : value;
    assert.equal((await f.run(f.start(), 'ok')).code, 0);
    assert.equal(f.state().options.agentStatusDir, value === 'missing' ? path.join(f.root, 'missing') : undefined);
    assert.deepEqual(fs.readdirSync(f.root).sort(), ['fake', 'runs']);
  }
});

test('Matou: publisher throttles duplicates, bounds detail and ignores write/rename failures', () => {
  const source = fs.readFileSync(script, 'utf8');
  const publisher = source.slice(source.indexOf('let publishAgentStatus'), source.indexOf('function saveState'));
  let time = 1000;
  let writes = 0;
  let payload;
  let fail;
  let cleaned = 0;
  const write = vm.runInNewContext(publisher + '\nwriteAgentStatus', {
    path, process: { pid: 42 }, Date: class extends Date { static now() { return time; } },
    fs: {
      writeFileSync: (_, text) => { if (fail === 'write') throw new Error('denied'); writes++; payload = JSON.parse(text); },
      renameSync: () => { if (fail === 'rename') throw new Error('denied'); },
      unlinkSync: () => { cleaned++; },
    },
  });
  const state = { task: 'task', status: 'new', runStartedAt: new Date(0).toISOString(), options: { agentStatusDir: '/agents' } };
  write(state);
  write(state);
  assert.equal(writes, 1);
  time += 1000;
  write(state);
  assert.equal(writes, 2);
  state.status = 'failed';
  state.error = 'first line\nsecond line';
  write(state);
  assert.equal(writes, 3);
  assert.equal(payload.detail, 'first line');
  state.error = '字'.repeat(150);
  write(state);
  assert.equal([...payload.detail].length, 120);
  for (const failure of ['write', 'rename']) {
    fail = failure;
    state.error = failure;
    assert.doesNotThrow(() => write(state));
  }
  assert.equal(cleaned, 6);
});

test('default runs directory uses temporary HOME for runner and statusline', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, HOME: root, CODEX_BIN: fake, FAKE_CODEX_STATE_DIR: path.join(root, 'fake'), FAKE_CODEX_SCENARIO: 'ok' };
  delete env.FOREMAN_RUN_DIR;
  delete env.CODEX_HOME;
  delete env.MATOU_AGENT_STATUS_DIR;
  const result = spawnSync(process.execPath, [script, 'start', 'home-test', '--cd', root], { env, input: 'test', encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(fs.existsSync(path.join(root, '.claude/agent-foreman/runs/home-test/state.json')));
  const line = spawnSync(process.execPath, [statusline], { env, input: '', encoding: 'utf8' });
  assert.match(line.stdout, /home-test/);
});

test('gitRoot is based on task repository, or null outside git', async (t) => {
  const f = fixture(t, 'ok');
  assert.equal((await f.run(f.start(), 'outside')).code, 0);
  assert.equal(f.state().options.gitRoot, null);
  const g = fixture(t, 'ok');
  assert.equal(spawnSync('git', ['init', g.root]).status, 0);
  const sub = path.join(g.root, 'sub');
  fs.mkdirSync(sub);
  assert.equal((await g.run(g.start(['--cd', sub, '--full-access']), 'inside')).code, 0);
  assert.equal(fs.realpathSync(g.state().options.gitRoot), fs.realpathSync(g.root));
});

test('blocking ask survives idle limit, publishes waiting, watch reattaches and answer is exact', async (t) => {
  const f = agentStatusFixture(t, 'ask');
  f.env.FAKE_ANSWER_ACTIVITY = '1';
  const run = f.launch(f.start(['--ask-wait-min', '0.5']), 'ask');
  await until(() => fs.existsSync(path.join(f.runs, 'task/state.json')) && f.state().waitingQuestions?.[0] === 1);
  assert.equal(f.state().activity, '等待回答 #1');
  // state.json is published just before the separate Matou card.
  await until(() => f.agent().state === 'waiting');
  assert.equal(f.agent().state, 'waiting');
  assert.equal(f.agent().detail, '等待回答：问题：选哪一种？');
  const line = spawnSync(process.execPath, [statusline], { env: { ...f.env, HOME: f.root }, input: '', encoding: 'utf8' });
  assert.match(line.stdout, /\x1b\[33m❓ 等待回答 #1/);
  const watcher = f.launch(['watch', 'task']);
  assert.equal((await watcher.result).code, 7);
  assert.match(watcher.output().split('\n')[0], /❓ task 正在等你回答 #1：问题：选哪一种？/);
  assert.equal((await run.result).code, 7);
  await sleep(6000);
  assert.equal(f.state().status, 'running');
  assert.equal(f.state().turns.length, 1);
  const answer = '选 B。\n保留这一行。\n';
  assert.equal((await f.run(['answer', 'task'], answer)).stdout.trim(), '已回答 #1');
  assert.equal((await f.run(['watch', 'task'])).code, 0);
  assert.equal(fs.readFileSync(path.join(f.root, 'fake/answer.txt'), 'utf8'), answer);
  assert.match(f.feed(), /❓ task 提问 #1：[\s\S]*💬 task #1 已收到回答/);
  assert.doesNotMatch(f.feed(), /✖|回复缺少/);
  assert.equal((await f.run(['inbox', 'task'])).stdout.trim(), '没有新的回答或留言。');
  const prompt = f.calls()[0].prompt;
  for (const expected of [f.runs, script, 'ask task', 'inbox task', '最长 0.5 分钟', '330000 毫秒', 'decisions.md']) assert.ok(prompt.includes(expected), expected);
});

test('ask timeout prints exact instructions and publishes event on short turns', async (t) => {
  const f = fixture(t, 'ask-timeout');
  const result = await f.run(f.start(), 'timeout');
  assert.ok([0, 7].includes(result.code));
  if (result.code === 7) {
    await until(() => f.state().status === 'completed');
    assert.equal((await f.run(['watch', 'task'])).code, 0);
  }
  const expected = `等了 0.003 分钟没有收到回答。
- 如果这个问题涉及产品范围、用户能看到的取舍、删除数据或其他不可逆的操作：现在停下，不要自己决定。在最终回复里列出这个问题，然后结束本轮。
- 其他问题：按你提问时写的倾向做法继续，并把它写进「我自己做的决定」。之后每完成一个步骤运行 inbox，迟到的回答仍会送到。
`;
  assert.equal(fs.readFileSync(path.join(f.root, 'fake/answer.txt'), 'utf8'), expected);
  assert.match(f.feed(), /⏳ task #1 等了 0.003 分钟没有回答，Codex 按约定处理/);
});

test('nonblocking ask, answer validation, notes and inbox deliver once in time order', async (t) => {
  const f = fixture(t, 'slow');
  await f.run(f.start(['--no-watch']), 'work');
  await until(() => f.state().status === 'running');
  const before = Date.now();
  assert.equal((await f.run(['ask', 'task', '--no-wait'], '倾向 A\n理由')).stdout.trim(), '已记录，先按你写的倾向继续；回答会出现在 inbox 里。');
  assert.ok(Date.now() - before < 1500);
  assert.equal((await f.run(['answer', 'task', '99'], 'bad')).code, 1);
  assert.equal((await f.run(['note', 'task'], '先处理这一项')).stdout.trim(), '已留言');
  assert.equal((await f.run(['answer', 'task', '1'], '改选 B')).code, 0);
  const duplicate = await f.run(['answer', 'task', '1'], 'bad');
  assert.equal(duplicate.code, 1);
  assert.match(duplicate.stderr, /已回答/);
  const inbox = await f.run(['inbox', 'task']);
  assert.match(inbox.stdout, /【留言 .*】\n先处理这一项[\s\S]*【回答 #1】\n改选 B/);
  assert.equal((await f.run(['inbox', 'task'])).stdout.trim(), '没有新的回答或留言。');
  await until(() => /✉/.test(f.feed()));
  assert.match(f.feed(), /提问 #1（不阻塞，Codex 先按自己的倾向继续）：倾向 A\n理由/);
  assert.match(f.feed(), /💬 task #1 已收到回答/);
  await f.run(['stop', 'task']);
  for (const status of ['completed', 'failed', 'timeout', 'stopped']) {
    const state = f.state(); state.status = status;
    fs.writeFileSync(path.join(f.runs, 'task/state.json'), JSON.stringify(state));
    const before = fs.readdirSync(path.join(f.runs, 'task/notes'));
    for (const cmd of ['answer', 'note']) {
      const result = await f.run([cmd, 'task'], 'rejected');
      assert.equal(result.code, 1);
      assert.match(result.stderr, /任务已结束；请用 send/);
    }
    assert.deepEqual(fs.readdirSync(path.join(f.runs, 'task/notes')), before);
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.runs, 'task/answers/a-1.json'))).text, '改选 B');
  }
});

test('question numbers persist across send and send overrides ask wait', async (t) => {
  const f = fixture(t, 'ask-timeout');
  assert.equal((await f.run(f.start(), 'one')).code, 0);
  await until(() => !alive(f.state().supervisorPid));
  assert.equal((await f.run(['send', 'task', '--ask-wait-min', '2'], 'two')).code, 0);
  assert.equal(f.state().options.askWaitMin, 2);
  assert.ok(fs.existsSync(path.join(f.runs, 'task/questions/q-2.json')));
  assert.match(f.calls()[1].prompt, /最长 2 分钟/);
  for (const { prompt } of f.calls()) {
    assert.ok(prompt.includes(
      '- 不要使用 agent-foreman 技能，不要再启动 codex；只允许下述 terra 界面操作子代理，不要派生其他子 Agent。\n' +
      '- 需要的工具（如某个 MCP 服务）一开始没出现时，先等 30 秒再查一次，仍然没有才算没有；不要一看不到就下结论或改用别的办法。\n',
    ));
  }
});

for (const available of [false, true]) test(`Codex protocol includes DSH UI delegation only with an executable: ${available}`, async (t) => {
  for (const source of ['override', 'PATH']) {
    const f = fixture(t, 'ok');
    const bin = path.join(f.root, 'bin');
    fs.mkdirSync(bin);
    fs.symlinkSync(process.execPath, path.join(bin, 'node'));
    fs.symlinkSync('/bin/ps', path.join(bin, 'ps'));
    f.env.PATH = bin;
    if (source === 'override') f.env.DSH_BIN = available ? fakeDsh : path.join(f.root, 'missing-dsh');
    else {
      delete f.env.DSH_BIN;
      if (available) fs.symlinkSync(fakeDsh, path.join(bin, 'dsh'));
      // Also exercise the Codex executable's PATH default.
      delete f.env.CODEX_BIN;
      fs.symlinkSync(fake, path.join(bin, 'codex'));
    }
    assert.equal((await f.run(f.start(), 'protocol')).code, 0);
    const prompt = f.calls()[0].prompt;
    assert.ok(prompt.includes('- 不要使用 agent-foreman 技能，不要再启动 codex'));
    assert.ok(prompt.includes('- 派任何子代理（DSH 子任务、spawn_agent 子代理）时，防止意图在转述中丢失：'));
    assert.ok(prompt.endsWith(terraProtocol('gpt-5.6-terra', 'high')));
    if (available) {
      assert.ok(prompt.includes(`
前端 UI 设计的部分（页面和组件的视觉设计、布局、样式、交互外观，以及把它们实现成前端界面代码）交给 DSH 子代理：运行下面的命令派活（命令超时设为 10 分钟；它跟踪满 29 分钟会以退出码 8 交回，按最后一行的命令继续跟踪；退出码 7 表示它在提问，按提示回答后继续跟踪）：
  FOREMAN_RUN_DIR="${f.runs}" node "${script}" start task-界面-01 --agent dsh --cd <工作目录> <<'EOF'
  交代：用户要什么、已定的设计决定（配色、字号、间距、文案原文等）、要改哪些文件、不能碰什么、做完交回什么（截图或样稿路径）
  EOF
多次派活把序号 01 递增。它在改的文件，你等它交回后再动。交回后你检查结果、整合进其余代码；其余工作（逻辑、数据、后端、测试、构建）你自己做。`));
      if (source === 'PATH') {
        const args = f.start(['--agent', 'dsh']);
        args[1] = 'path-dsh';
        assert.equal((await f.run(args, 'DSH from PATH')).code, 0);
        assert.equal(f.state('path-dsh').agent, 'dsh');
        assert.match(f.calls()[1].prompt, /^DSH from PATH/);
      }
    } else assert.doesNotMatch(prompt, /前端 UI 设计的部分|--agent dsh|多次派活把序号/);
  }
});

test('final reply decision checklist warning is conditional', async (t) => {
  for (const scenario of ['ok', 'decisions']) {
    const f = fixture(t, scenario);
    assert.equal((await f.run(f.start(), 'test')).code, 0);
    assert.equal(f.feed().includes('⚠ task 的回复缺少「我自己做的决定」'), scenario === 'ok');
  }
});

test('concurrent asks allocate unique numbers; late answers remain available after timeout', async (t) => {
  const f = fixture(t, 'slow');
  await f.run(f.start(['--no-watch']), 'work');
  await until(() => f.state().status === 'running');
  const asks = await Promise.all(Array.from({ length: 4 }, (_, i) => f.run(['ask', 'task', '--no-wait'], `question ${i}`)));
  assert.ok(asks.every((r) => r.code === 0));
  assert.deepEqual(fs.readdirSync(path.join(f.runs, 'task/questions')).sort(), ['q-1.json', 'q-2.json', 'q-3.json', 'q-4.json']);
  const timeout = await f.run(['ask', 'task', '--wait-min', '0.002'], '迟到测试');
  assert.equal(timeout.code, 0);
  assert.match(timeout.stdout, /等了 0.002 分钟/);
  await f.run(['answer', 'task', '5'], '迟到的回答');
  const inboxes = await Promise.all([f.run(['inbox', 'task']), f.run(['inbox', 'task'])]);
  assert.equal(inboxes.filter((r) => r.stdout.includes('迟到的回答')).length, 1);
  await until(() => f.feed().includes('⏳ task #5'));
  assert.equal(f.state().waitingQuestions.length, 0);
});

function networkFixture(t, mode) {
  const f = agentStatusFixture(t, 'network');
  f.env.FOREMAN_NETTOP = path.join(repo, 'tests/fixtures/fake-nettop.mjs');
  f.env.FAKE_NETTOP_MODE = mode;
  f.env.PATH = `${path.join(repo, 'tests/fixtures')}:${process.env.PATH}`;
  return f;
}

for (const mode of ['grow', 'reset']) test(`network ${mode}: silent generation stays running past idle limit`, { skip: process.platform !== 'darwin' }, async (t) => {
  const f = networkFixture(t, mode);
  assert.equal((await f.run(f.start(['--no-watch', '--idle-min', '0.12', '--warn-min', '0.1', '--retries', '0']), 'generate')).code, 0);
  await until(() => f.state().activity?.startsWith('生成中'));
  assert.equal(f.state().intent, '编写长文件');
  assert.match(f.state().activity, /^生成中 0秒 · 编写长文件$/);
  const since = f.state().generatingSince;
  const generationFeedOffset = f.feed().length;
  await until(() => /^生成中 (?:[4-9]|1\d)秒/.test(f.state().activity));
  assert.equal(f.state().generatingSince, since);
  assert.equal(f.agent().state, 'running');
  assert.equal(f.agent().detail, f.state().activity);
  assert.doesNotMatch(f.feed().slice(generationFeedOffset), /⏸|✖/);
  const pid = Number(fs.readFileSync(path.join(f.root, 'fake', 'worker.pid'), 'utf8'));
  await f.run(['stop', 'task']);
  assert.equal(alive(pid), false);
});

for (const mode of ['flat', 'invalid', 'error', 'timeout']) test(`network ${mode}: no growth retains warning and watchdog`, { skip: process.platform !== 'darwin' }, async (t) => {
  const f = networkFixture(t, mode);
  const run = f.launch(f.start(['--retries', '0', '--idle-min', '0.08']), 'stall');
  await until(() => fs.existsSync(path.join(f.dir, 'codex-task.json')) && f.agent().state === 'warning');
  assert.match(f.agent().detail, /没有动静（网络也没有数据）/);
  const status = spawnSync(process.execPath, [path.join(repo, 'scripts/foreman-statusline.mjs')], { env: f.env, input: '', encoding: 'utf8' });
  assert.match(status.stdout, /没动静（网络也没有数据）/);
  assert.equal((await run.result).code, 3);
  assert.match(f.feed(), /⏸[^\n]*（网络也没有数据）/);
  assert.match(f.feed(), /✖[^\n]*（网络也没有数据），已结束本轮/);
  const calls = fs.readFileSync(path.join(f.root, 'fake', 'nettop-calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  for (const { pid } of calls) await until(() => !alive(pid));
});

test('network unavailable: unchanged warning text', async (t) => {
  const f = fixture(t, 'stall-then-ok');
  assert.equal((await f.run(f.start(['--retries', '0']), 'stall')).code, 3);
  assert.equal(f.state().networkSampling, false);
  assert.match(f.feed(), /⏸[\s\S]*✖/);
  assert.doesNotMatch(f.feed(), /网络也没有数据/);
});

for (const event of [false, true]) test(`generation ends on ${event ? 'Codex event' : 'one low sample'}`, { skip: process.platform !== 'darwin' }, async (t) => {
  const f = networkFixture(t, event ? 'grow' : 'stop');
  f.env.FAKE_INTENT = '\n';
  if (event) f.env.FAKE_EVENT_FILE = path.join(f.root, 'emit-event');
  await f.run(f.start(['--no-watch', '--idle-min', '0.3', '--warn-min', '0.3']), 'generate');
  await until(() => /^生成中 \d+秒$/.test(f.state().activity));
  if (event) {
    fs.writeFileSync(f.env.FAKE_EVENT_FILE, 'emit');
    await until(() => f.state().activity === '运行 echo event');
  }
  await until(() => !f.state().generatingSince);
  assert.equal(f.state().activity, event ? '运行 echo event' : '说明：');
});

test('command descriptions: wrappers, repeated cd, heredocs and Unicode bounds', () => {
  const source = fs.readFileSync(script, 'utf8');
  const shortSource = source.slice(source.indexOf('const short ='), source.indexOf('const clock ='));
  const describe = vm.runInNewContext(`${shortSource}\n${source.slice(source.indexOf('function commandDescription'), source.indexOf('function eventActivity'))}\ncommandDescription`);
  assert.equal(describe("cd /a/b && python3 - <<'PY'\nimport os\nprint(1)\nPY"), 'Python 脚本：print(1)');
  assert.equal(describe('cd "/a b"; cd /c && node - <<"JS"\n// comment\nrequire("fs")\nconsole.log(1)\nJS'), 'Node 脚本：console.log(1)');
  assert.equal(describe("/bin/zsh -lc 'cd /a; bash <<END\n# comment\necho hi\nEND'"), 'Bash 脚本：echo hi');
  assert.equal(describe("node - <<'JS'"), 'Node 脚本');
  assert.equal(describe('python <<PY\n' + 'x'.repeat(41) + '\nPY'), 'Python 脚本');
  assert.equal(describe('字'.repeat(70) + '\nignored'), '字'.repeat(60));
});

test('stop cancels an in-flight network sampler without leaving a process', { skip: process.platform !== 'darwin' }, async (t) => {
  const f = networkFixture(t, 'timeout');
  await f.run(f.start(['--no-watch']), 'stop sampling');
  const file = path.join(f.root, 'fake', 'nettop-calls.jsonl');
  await until(() => fs.existsSync(file));
  const { pid } = JSON.parse(fs.readFileSync(file, 'utf8').trim().split('\n')[0]);
  assert.equal(alive(pid), true);
  assert.equal((await f.run(['stop', 'task'])).code, 0);
  await until(() => !alive(pid));
});


test('command descriptions: heredoc file writes and all three append forms', () => {
  const source = fs.readFileSync(script, 'utf8');
  const shortSource = source.slice(source.indexOf('const short ='), source.indexOf('const clock ='));
  const describe = vm.runInNewContext(`${shortSource}\n${source.slice(source.indexOf('function commandDescription'), source.indexOf('function eventActivity'))}\ncommandDescription`, { path });
  const cases = [
    ["cat > /tmp/long.md <<'EOF'", '写入 long.md'],
    ['cat <<EOF > /tmp/long.md', '写入 long.md'],
    ['tee /tmp/long.md <<"EOF"', '写入 long.md'],
    ["cd /a/b && cat > '/tmp/long file.md' <<'EOF'", '写入 long file.md'],
    ['cd "/a b"; cd /c && cat <<EOF > "/tmp/long file.md"', '写入 long file.md'],
    ["tee '/tmp/long file.md' <<EOF", '写入 long file.md'],
    ["cd /a && cat >> '/tmp/long file.md' <<'EOF'", '追加 long file.md'],
    ['cat <<"EOF" >> "/tmp/long file.md"', '追加 long file.md'],
    ["tee -a '/tmp/long file.md' <<EOF", '追加 long file.md'],
    ["/bin/zsh -lc 'cd /a && cat > /tmp/long.md <<EOF\nbody\nEOF'", '写入 long.md'],
  ];
  for (const [command, expected] of cases) {
    assert.equal(describe(command), expected, command);
    if (!command.includes('\n')) assert.equal(describe(command + '\nbody\nEOF'), expected, command);
  }
  for (const command of ['cat /tmp/long.md', 'cat > /tmp/long.md', 'tee -a /tmp/long.md', 'echo "cat > file <<EOF"']) {
    assert.equal(describe(command), command);
  }
});

function expectedQuestionNotice(f, n, text, defaultRuns = false) {
  const prefix = defaultRuns ? '' : `FOREMAN_RUN_DIR="${f.runs}" `;
  return [
    `❓ task 正在等你回答 #${n}：${Array.from(text.split('\n')[0]).slice(0, 300).join('')}`,
    `完整问题：${path.join(f.runs, 'task', 'questions', `q-${n}.json`)}`,
    `回答：${prefix}node "${script}" answer task ${n} <<'EOF' … EOF；回答后用 Monitor 运行 ${prefix}node "${script}" watch task 继续跟踪`,
  ];
}

for (const defaultRuns of [false, true]) test(`blocking questions wake start, send and watch; default directory=${defaultRuns}`, async (t) => {
  const f = fixture(t, 'ask', defaultRuns);
  const question = '问'.repeat(310) + '\n完整第二行';
  f.env.FAKE_QUESTION = question;
  f.env.FAKE_AFTER_ANSWER_MS = '1000';
  const first = await f.run(f.start(['--idle-min', '0.5']), 'ask');
  assert.equal(first.code, 7);
  assert.match(first.stdout, /❓ task 提问 #1：/);
  assert.deepEqual(first.stdout.trimEnd().split('\n').slice(-3), expectedQuestionNotice(f, 1, question, defaultRuns));
  assert.equal(f.state().status, 'running');
  const attach = await f.run(['watch', 'task']);
  assert.equal(attach.code, 7);
  assert.deepEqual(attach.stdout.trimEnd().split('\n'), expectedQuestionNotice(f, 1, question, defaultRuns));
  const answered = await f.run(['answer', 'task', '1'], '第一轮回答');
  assert.equal(answered.code, 0, answered.stderr);
  const finished = await f.run(['watch', 'task']);
  assert.equal(finished.code, 0, finished.stdout + finished.stderr);
  assert.equal(fs.readFileSync(path.join(f.root, 'fake/answer.txt'), 'utf8'), '第一轮回答');
  await until(() => !alive(f.state().supervisorPid));
  const sent = await f.run(['send', 'task'], 'ask again');
  assert.equal(sent.code, 7);
  assert.deepEqual(sent.stdout.trimEnd().split('\n').slice(-3), expectedQuestionNotice(f, 2, question, defaultRuns));
  await f.run(['answer', 'task', '2'], '第二轮回答');
  assert.equal((await f.run(['watch', 'task'])).code, 0);
});

test('shell tail -3 receives the complete blocking question notice before Codex finishes', async (t) => {
  const f = fixture(t, 'ask');
  const run = f.launchPipeline(f.start(['--idle-min', '0.5']), 'pipeline');
  await until(() => run.child.exitCode != null);
  const result = await run.result;
  assert.equal(result.code, 7);
  assert.deepEqual(result.stdout.trimEnd().split('\n'), expectedQuestionNotice(f, 1, '问题：选哪一种？'));
  assert.equal(f.state().status, 'running');
  assert.equal(alive(f.state().pid), true);
  await f.run(['answer', 'task'], '继续');
  assert.equal((await f.run(['watch', 'task'])).code, 0);
  await until(() => !alive(f.state().supervisorPid));
  const sent = f.launchPipeline(['send', 'task'], 'pipeline send');
  await until(() => sent.child.exitCode != null);
  assert.equal((await sent.result).code, 7);
  assert.deepEqual(sent.output().trimEnd().split('\n'), expectedQuestionNotice(f, 2, '问题：选哪一种？'));
  const attached = await f.launchPipeline(['watch', 'task']).result;
  assert.equal(attached.code, 7);
  assert.deepEqual(attached.stdout.trimEnd().split('\n'), expectedQuestionNotice(f, 2, '问题：选哪一种？'));
  await f.run(['answer', 'task', '2'], '继续第二轮');
  assert.equal((await f.run(['watch', 'task'])).code, 0);
});

test('nonblocking Codex question keeps start and attached watch running to completion', async (t) => {
  const f = fixture(t, 'ask-no-wait');
  const run = f.launch(f.start(), 'nonblocking');
  await until(() => fs.existsSync(path.join(f.runs, 'task/questions/q-1.json')));
  const watch = f.launch(['watch', 'task']);
  assert.equal((await run.result).code, 0);
  assert.equal((await watch.result).code, 0);
  assert.match(f.feed(), /❓ task 提问 #1（不阻塞/);
  assert.doesNotMatch(run.output(), /正在等你回答/);
});

test('command activity strips environment assignments and names mailbox commands', () => {
  const source = fs.readFileSync(script, 'utf8');
  const shortSource = source.slice(source.indexOf('const short ='), source.indexOf('const clock ='));
  const activity = vm.runInNewContext(`${shortSource}\n${source.slice(source.indexOf('function commandDescription'), source.indexOf('function finalText'))}\neventActivity`, { path });
  const cases = [
    ['A=one B="two words" C=\'three words\' echo hello', 'echo hello'],
    ['EMPTY= cd /a && A="two words" python3 - <<\'PY\'\nprint(1)\nPY', 'Python 脚本：print(1)'],
    [`FOREMAN_RUN_DIR="/some dir" node "${script}" ask task <<'EOF'\nquestion\nEOF`, '提问'],
    [`cd /a && FOREMAN_RUN_DIR=/runs node '${script}' ask task --no-wait`, '提问（不阻塞）'],
    [`A=1 /bin/zsh -lc 'B=2 node ${script} inbox task'`, '查看信箱'],
  ];
  for (const [command, expected] of cases) for (const type of ['item.started', 'item.completed']) {
    const prefix = ['提问', '提问（不阻塞）', '查看信箱'].includes(expected) ? '' : type === 'item.started' ? '运行 ' : '跑完 ';
    assert.equal(activity({ type, item: { type: 'command_execution', command } }), prefix + expected);
  }
});

test('watch attachment uses the answer file when waiting state has not refreshed', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-watch-answer-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const mailPath = (task, kind, name) => path.join(root, task, kind, `${name}.json`);
  fs.mkdirSync(path.join(root, 'task', 'answers'), { recursive: true });
  fs.writeFileSync(mailPath('task', 'answers', 'a-1'), JSON.stringify({ n: 1, text: '已回答' }));
  const source = fs.readFileSync(script, 'utf8');
  const watchSource = source.slice(source.indexOf('async function watch('), source.indexOf('// Appended to every prompt'));
  for (const [waiting, expected] of [
    [1, '进行中：已回答 #1，等待 Codex 继续（已运行 45秒）'],
    [2, '等待回答 #2：尚未刷新'],
    [undefined, '进行中：运行 npm test（已运行 45秒）'],
  ]) {
    let reads = 0;
    const lines = [];
    const watch = vm.runInNewContext(watchSource + '\nwatch', {
      fs, path, mailPath, Date,
      loadState: () => ++reads === 1 ? {
        status: 'running', waitingQuestions: waiting == null ? [] : [waiting],
        waitingQuestionText: '尚未刷新', activity: '运行 npm test', runStartedAt: new Date().toISOString(),
      } : { status: 'completed', exitCode: 0 },
      terminal: (state) => state.status === 'completed',
      blockingQuestion: () => undefined,
      feedSize: () => 0,
      clock: () => '12:00:00',
      duration: () => '45秒',
      exitStatus: (state) => state.exitCode,
      console: { log: (line) => lines.push(line) },
    });
    assert.equal(await watch('task'), 0);
    assert.deepEqual(lines, [`12:00:00 … task ${expected}`]);
  }
});


test('Unicode task completes the protocol ask/answer/inbox flow with original names', async (t) => {
  const f = agentStatusFixture(t, 'ask-protocol');
  const task = '商城-购物车-01';
  const args = f.start(['--idle-min', '0.5']);
  args[1] = task;
  const result = await f.run(args, '中文任务');
  assert.equal(result.code, 7, result.stderr);
  const notice = result.stdout.trimEnd().split('\n').slice(-3);
  assert.ok(notice[0].startsWith(`❓ ${task} 正在等你回答 #1：`));
  assert.equal(notice[1], `完整问题：${path.join(f.runs, task, 'questions/q-1.json')}`);
  assert.ok(notice[2].includes(`answer ${task} 1`));
  assert.ok(notice[2].includes(`watch ${task}`));
  assert.equal((await f.run(['watch', task])).code, 7);
  const prompt = f.calls()[0].prompt;
  assert.ok(prompt.includes(`ask ${task} <<'EOF'`));
  assert.ok(prompt.includes(`inbox ${task}，`));
  assert.equal((await f.run(['note', task], '请保留中文')).code, 0);
  assert.equal((await f.run(['answer', task, '1'], '按中文方案继续')).code, 0);
  assert.equal((await f.run(['watch', task])).code, 0);
  assert.equal(fs.readFileSync(path.join(f.root, 'fake/answer.txt'), 'utf8'), '按中文方案继续');
  assert.ok(fs.readFileSync(path.join(f.root, 'fake/inbox.txt'), 'utf8').includes('请保留中文'));
  assert.ok(f.feed(task).includes(`▶ ${task}`));
  const status = await f.run(['status', task]);
  assert.equal(status.code, 0);
  const data = JSON.parse(status.stdout.split('\n--- last message ---')[0]);
  assert.equal(data.task, task);
  assert.equal(data.status, 'completed');
  const id = 'codex-' + createHash('sha1').update(task).digest('hex').slice(0, 12);
  assert.equal(f.agent(id).label, `Codex：${task}（gpt-6.1-sol · 高档推理）`);
  assert.equal(f.agent(id).state, 'completed');
});

test('Matou preserves ASCII IDs and gives different Unicode tasks distinct SHA1 IDs', async (t) => {
  const f = agentStatusFixture(t, 'ok');
  const tasks = ['短剧-第一层生图-02', '短剧-第二层生图-02', 'legacy_Task.01'];
  for (const task of tasks) {
    const args = f.start();
    args[1] = task;
    assert.equal((await f.run(args, 'test')).code, 0);
    const id = 'codex-' + (task === tasks[2] ? task : createHash('sha1').update(task).digest('hex').slice(0, 12));
    assert.equal(f.agent(id).label, `Codex：${task}（gpt-6.1-sol · 高档推理）`);
  }
  assert.equal(fs.readdirSync(f.dir).length, 3);
});

test('invalid task names are rejected by all task commands', async (t) => {
  const f = fixture(t, 'ok');
  const invalid = ['', '含 空格', '含\t制表', '含\n换行', '含\u3000空白', '含\u0085空白', "含'引号", '含"引号', '含`引号', '含/斜杠', '含\\斜杠', '.隐藏', '.', '..', '字'.repeat(41), '😀'.repeat(41)];
  for (const command of ['start', 'send', 'resume', 'watch', 'status', 'stop', 'ask', 'answer', 'note', 'inbox']) {
    for (const task of invalid) {
      const result = await f.run([command, task], 'test');
      assert.equal(result.code, 1, `${command}: ${task}`);
      assert.equal(result.stderr.split('\n')[0], '任务名不能包含空格、引号或斜杠，最长 40 个字');
    }
  }
  assert.equal(fs.existsSync(f.runs), false);
  // OS argv cannot contain NUL; exercise the same main validation in a VM.
  const source = fs.readFileSync(script, 'utf8');
  const check = source.slice(source.indexOf('  if (!task || task.startsWith'), source.indexOf("  if (['ask', 'answer'", source.indexOf('async function main')));
  assert.throws(() => vm.runInNewContext(check, { task: '含\0字符' }), /任务名不能包含空格/);
});

test('40 Unicode code points are accepted regardless of UTF8 or UTF16 length', async (t) => {
  const f = fixture(t, 'ok');
  for (const task of ['字'.repeat(40), '😀'.repeat(40)]) {
    const args = f.start();
    args[1] = task;
    assert.equal((await f.run(args, 'test')).code, 0);
    assert.equal(f.state(task).task, task);
  }
});

test('statusline truncates names and narrow panels by display width without splitting graphemes', (t) => {
  const f = statusFixture(t);
  const task = '商城-加载配置-01';
  f.state(task, { status: 'running', pid: process.pid, createdAt: new Date().toISOString() });
  assert.ok(stripAnsi(f.run().stdout).includes('Codex·商城-加载配置-  '));
  const source = fs.readFileSync(statusline, 'utf8');
  const helpers = source.slice(source.indexOf('const graphemes ='), source.indexOf('function taskLines'));
  const fitSource = source.slice(source.indexOf('function fit('), source.indexOf("if (process.argv.includes('--watch'))"));
  const { truncateName, fit } = vm.runInNewContext(`${helpers}\n${fitSource}\n({ truncateName, fit })`);
  assert.equal(truncateName('中文任务', 3), '中');
  assert.equal(truncateName('𠮷中文', 3), '𠮷');
  assert.equal(truncateName('e\u0301中文', 3), 'e\u0301中');
  assert.equal(truncateName('👨‍👩‍👧‍👦中文', 3), '👨‍👩‍👧‍👦');
  assert.equal(stripAnsi(fit('\x1b[32m中文任务\x1b[0m', 4)), '中…');
  assert.equal(stripAnsi(fit('𠮷中文', 4)), '𠮷…');
});

test('allowed shell punctuation stays literal in protocol task commands', async (t) => {
  const f = fixture(t, 'ask-protocol');
  const task = '中文;$变量&任务';
  const args = f.start(['--idle-min', '0.5']);
  args[1] = task;
  const result = await f.run(args, 'test');
  assert.equal(result.code, 7, result.stderr);
  assert.ok(f.calls()[0].prompt.includes(`ask '${task}'`));
  assert.ok(result.stdout.includes(`answer '${task}'`));
  assert.equal((await f.run(['note', task], '原样任务')).code, 0);
  assert.equal((await f.run(['answer', task], '继续')).code, 0);
  assert.equal((await f.run(['watch', task])).code, 0);
  assert.ok(fs.readFileSync(path.join(f.root, 'fake/inbox.txt'), 'utf8').includes('原样任务'));
});

function processRows() {
  const result = spawnSync('/bin/ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim().split('\n').map((line) => line.trim().split(/\s+/).map(Number));
}

for (const command of ['start', 'send', 'resume']) test(`${command}: supervisor is reparented; killing launcher tree leaves Codex to complete`, async (t) => {
  const f = fixture(t, 'delayed-ok');
  if (command !== 'start') {
    assert.equal((await f.run(f.start(), 'initial')).code, 0);
    await until(() => !alive(f.state().supervisorPid));
  }
  const run = f.launch(command === 'start' ? f.start() : [command, 'task'], 'survive');
  await until(() => fs.existsSync(path.join(f.runs, 'task/state.json')) && f.state().status === 'running' && f.state().pid);
  const { supervisorPid, pid } = f.state();
  await until(() => processRows().find(([p]) => p === supervisorPid)?.[1] === 1);
  const rows = processRows();
  const descendants = [run.child.pid];
  for (let i = 0; i < descendants.length; i++) descendants.push(...rows.filter(([, parent]) => parent === descendants[i]).map(([p]) => p));
  assert.ok(!descendants.includes(supervisorPid));
  assert.ok(!descendants.includes(pid));
  for (const p of descendants.reverse()) process.kill(p, 'SIGKILL');
  await run.result;
  assert.equal(alive(supervisorPid), true);
  assert.equal(alive(pid), true);
  await until(() => f.state().status === 'completed');
  assert.match(fs.readFileSync(f.state().turns.at(-1).files.events, 'utf8'), /turn.completed/);
  assert.match(f.feed(), /✅ task 本轮完成/);
});

for (const command of ['start', 'send', 'resume', 'watch']) test(`${command}: watch-min expires with code 8 and exact final line`, async (t) => {
  const f = fixture(t, 'delayed-ok');
  if (command === 'watch') await f.run(f.start(['--no-watch']), 'initial');
  else if (command !== 'start') {
    await f.run(f.start(), 'initial');
    await until(() => !alive(f.state().supervisorPid));
  }
  const args = command === 'start' ? f.start(['--watch-min', '0.002']) : [command, 'task', '--watch-min', '0.002'];
  const result = await f.run(args, 'work');
  assert.equal(result.code, 8, result.stderr);
  assert.equal(result.stdout.trimEnd().split('\n').at(-1), `⏳ task 仍在运行（跟踪满 0.002 分钟自动交回，任务不受影响）；继续跟踪：FOREMAN_RUN_DIR="${f.runs}" node "${script}" watch task`);
  assert.equal(alive(f.state().supervisorPid), true);
  assert.equal((await f.run(['watch', 'task'])).code, 0);
});

test('watch deadline: unseen blocking question takes precedence over code 8; default is 29 minutes', async () => {
  const source = fs.readFileSync(script, 'utf8');
  const watchSource = source.slice(source.indexOf('async function watch('), source.indexOf('// Appended to every prompt'));
  for (const question of [undefined, { n: 1 }]) {
    let time = 0;
    const lines = [];
    const watch = vm.runInNewContext(watchSource + '\nwatch', {
      Date: { now: () => time }, loadState: () => ({ status: 'running', supervisorPid: 123 }),
      terminal: () => false, blockingQuestion: () => question, feedSize: () => 0,
      pidAlive: () => true, questionNotice: () => 'question', shellTask: (task) => task, watchCommand: (task) => `watch-command ${task}`,
      sleep: async () => { time = 29 * 60_000; }, console: { log: (line) => lines.push(line) },
    });
    assert.equal(await watch('task', 0), question ? 7 : 8);
    assert.equal(lines.at(-1), question ? 'question' : '⏳ task 仍在运行（跟踪满 29 分钟自动交回，任务不受影响）；继续跟踪：watch-command task');
  }
});

test('no-watch ignores watch deadline; stop cleans reparented supervisor, Codex and worker', async (t) => {
  const f = fixture(t, 'network');
  assert.equal((await f.run(f.start(['--no-watch', '--watch-min', '0.00001']), 'work')).code, 0);
  await until(() => fs.existsSync(path.join(f.root, 'fake/worker.pid')));
  const { supervisorPid, pid } = f.state();
  const worker = Number(fs.readFileSync(path.join(f.root, 'fake/worker.pid'), 'utf8'));
  assert.equal(processRows().find(([p]) => p === supervisorPid)[1], 1);
  assert.equal((await f.run(['stop', 'task'])).code, 0);
  for (const p of [supervisorPid, pid, worker]) assert.equal(alive(p), false);
  assert.equal(f.state().status, 'stopped');
});

for (const stage of ['spawn', 'publish']) test(`detached launcher ${stage} failure marks state failed and leaves no orphan`, async (t) => {
  const f = fixture(t, 'delayed-ok');
  const copy = path.join(f.root, 'runner.mjs');
  const source = fs.readFileSync(script, 'utf8');
  const begin = source.indexOf('async function detachSupervisor(');
  const end = source.indexOf('async function launchSupervisor(', begin);
  let helper = source.slice(begin, end);
  if (stage === 'spawn') helper = helper.replace('spawn(process.execPath,', "spawn('/nonexistent-codex-test-node',");
  else helper = helper.replace('    const state = loadState(task);', "    fs.writeFileSync(path.join(RUNS, 'spawned.pid'), String(child.pid));\n    throw new Error('injected PID publication failure');\n    const state = loadState(task);");
  fs.writeFileSync(copy, source.slice(0, begin) + helper + source.slice(end));
  const child = spawn(process.execPath, [copy, ...f.start(['--no-watch', '--model', 'test-model'])], { env: f.env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stdout.resume();
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdin.end('failure');
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  assert.equal(code, 1, stderr);
  assert.equal(f.state().status, 'failed');
  assert.equal(f.state().supervisorPid, null);
  assert.equal(f.state().pid, null);
  assert.match(f.state().error, /Supervisor launch failed/);
  if (stage === 'publish') assert.equal(alive(Number(fs.readFileSync(path.join(f.runs, 'spawned.pid'), 'utf8'))), false);
  assert.equal(fs.existsSync(path.join(f.root, 'fake/calls.jsonl')), false);
});

for (const value of ['0', '-1', 'NaN', 'Infinity']) test(`watch-min rejects invalid duration ${value}`, async (t) => {
  const f = fixture(t, 'ok');
  assert.equal((await f.run(f.start(['--watch-min', value]), 'invalid')).code, 1);
  assert.equal(fs.existsSync(f.runs), false);
});


test('Matou: label translates efforts, omits unresolved model and immediately publishes model changes', () => {
  const source = fs.readFileSync(script, 'utf8');
  const publisher = source.slice(source.indexOf('let publishAgentStatus'), source.indexOf('function saveState'));
  let payload;
  let writes = 0;
  const write = vm.runInNewContext(publisher + '\nwriteAgentStatus', {
    path, process: { pid: 42 }, Date: class extends Date { static now() { return 1000; } },
    fs: {
      writeFileSync: (_, text) => { writes++; payload = JSON.parse(text); },
      renameSync() {}, unlinkSync() {},
    },
  });
  const state = { task: 'task', status: 'new', options: { agentStatusDir: '/agents', model: 'best', effort: 'medium' } };
  write(state);
  assert.equal(payload.label, 'Codex：task（中档推理）');
  state.options.model = 'gpt-6-astra';
  write(state);
  assert.equal(writes, 2);
  assert.equal(payload.label, 'Codex：task（gpt-6-astra · 中档推理）');
  for (const [effort, expected] of [['minimal', '最低档'], ['low', '低档'], ['medium', '中档'], ['high', '高档'], ['xhigh', '超高档'], ['ultra', 'ultra']]) {
    state.options = { ...state.options, model: '', effort };
    write(state);
    assert.equal(payload.label, `Codex：task（${expected}推理）`);
  }
});

test('default sol high selects latest version and publishes resolved Matou title', async (t) => {
  const f = fixture(t, 'ok');
  f.env.MATOU_AGENT_STATUS_DIR = path.join(f.root, 'agents');
  fs.mkdirSync(f.env.MATOU_AGENT_STATUS_DIR);
  const result = await f.run(f.start(), 'select');
  assert.equal(result.code, 0, result.stderr);
  assert.equal(f.state().options.model, 'gpt-6.1-sol');
  assert.equal(f.state().options.modelRequest, 'sol');
  assert.equal(f.state().options.effort, 'high');
  assert.match(result.stdout, /sol → gpt-6.1-sol（推理档位 high）/);
  const cards = fs.readdirSync(f.env.MATOU_AGENT_STATUS_DIR).filter(x => x.endsWith('.json'));
  assert.ok(cards.length);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.env.MATOU_AGENT_STATUS_DIR, cards[0]))).label, 'Codex：task（gpt-6.1-sol · 高档推理）');
});

for (const [request, expected] of [['astra', 'gpt-6-astra'], ['luna', 'gpt-6-luna'], ['SoL', 'gpt-6.1-sol'], ['ASTRA', 'gpt-6-astra'], ['terra', 'gpt-5.6-terra']]) {
  test(`series keyword ${request} resolves case-insensitively`, async (t) => {
    const f = fixture(t, 'ok');
    const result = await f.run(f.start(['--model', request]), 'select');
    assert.equal(result.code, 0, result.stderr);
    assert.equal(f.state().options.model, expected);
    assert.equal(f.state().options.modelRequest, request.toLowerCase());
  });
}

test('series filters visibility API and effort before numeric version selection; upgrade stays in series', async (t) => {
  const f = fixture(t, 'ok');
  setModels(f, [model('gpt-7-sol'), model('gpt-8-sol', { visibility: 'hide', supported_reasoning_levels: ['high'] }),
    model('gpt-9-sol', { supported_in_api: false, supported_reasoning_levels: ['high'] }),
    ...['gpt-6-sol', 'gpt-6.2-sol', 'gpt-6.10-sol', 'gpt-5.99-sol'].map(slug => model(slug, { supported_reasoning_levels: ['high'], upgrade: 'gpt-99-astra' })),
    model('gpt-99-astra', { supported_reasoning_levels: ['high'] })]);
  assert.equal((await f.run(f.start(), 'select')).code, 0);
  assert.equal(f.state().options.model, 'gpt-6.10-sol');
});

test('series follows only one eligible upgrade hop', async (t) => {
  const f = fixture(t, 'ok');
  setModels(f, [model('gpt-6.2-sol', { upgrade: 'gpt-6.1-sol' }), model('gpt-6.1-sol', { upgrade: 'gpt-6-sol' }), model('gpt-6-sol')]);
  assert.equal((await f.run(f.start(['--effort', 'medium']), 'select')).code, 0);
  assert.equal(f.state().options.model, 'gpt-6.1-sol');
});

for (const command of ['start', 'send']) test(`${command} fails when requested series has no eligible model without switching series`, async (t) => {
  const f = fixture(t, 'ok');
  if (command === 'send') {
    assert.equal((await f.run(f.start(), 'first')).code, 0);
    await until(() => !alive(f.state().supervisorPid));
  }
  setModels(f, [model('gpt-9-astra', { supported_reasoning_levels: ['high'] }), model('gpt-8-sol')]);
  const result = await f.run(command === 'start' ? f.start() : ['send', 'task'], 'select');
  assert.equal(result.code, 1);
  assert.match(result.stderr, /没有可用的 sol 系列模型（推理档位 high）/);
  if (command === 'send') assert.equal(f.calls().length, 1);
});

test('cache separates keyword and effort, migrates legacy best and refreshes only requested key', async (t) => {
  const f = fixture(t, 'ok');
  writeModelCache(f);
  for (const [request, effort] of [['best', 'medium'], ['sol', 'high'], ['sol', 'medium'], ['astra', 'high']]) {
    const result = await f.run(['models', '--model', request, '--effort', effort]);
    assert.equal(result.code, 0, result.stderr);
  }
  assert.equal(modelCalls(f).length, 3);
  const read = () => JSON.parse(fs.readFileSync(path.join(f.runs, '.model-resolution.json'))).entries;
  const before = read();
  assert.deepEqual(Object.keys(before).sort(), ['astra:high', 'best:medium', 'sol:high', 'sol:medium']);
  assert.equal(before['best:medium'].model, 'gpt-5.6-astra');
  for (const [request, effort] of [['SOL', 'high'], ['sol', 'medium'], ['astra', 'high']]) {
    assert.equal((await f.run(['models', '--model', request, '--effort', effort])).code, 0);
  }
  assert.equal(modelCalls(f).length, 3);
  assert.equal((await f.run(['models', '--model', 'sol', '--refresh-models'])).code, 0);
  assert.equal(modelCalls(f).length, 4);
  assert.deepEqual(read()['best:medium'], before['best:medium']);
  assert.deepEqual(read()['sol:medium'], before['sol:medium']);
  f.env.FAKE_MODELS_MODE = 'fail';
  assert.equal((await f.run(['models', '--model', 'luna'])).code, 1);
  assert.equal((await f.run(['models', '--model', 'sol', '--effort', 'ultra'])).code, 1);
});

for (const bad of ['null', '{bad', '{"version":2,"entries":[]}']) test(`malformed cache ignored: ${bad}`, async (t) => {
  const f = fixture(t, 'ok');
  fs.mkdirSync(f.runs);
  fs.writeFileSync(path.join(f.runs, '.model-resolution.json'), bad);
  assert.equal((await f.run(['models', '--model', 'sol'])).code, 0);
  assert.equal(modelCalls(f).length, 1);
});

test('legacy task modelRequest best send resolves best instead of new default sol', async (t) => {
  const f = fixture(t, 'ok');
  assert.equal((await f.run(f.start(['--model', 'gpt-5.6-astra', '--effort', 'medium']), 'first')).code, 0);
  await until(() => !alive(f.state().supervisorPid));
  const state = f.state();
  state.options.modelRequest = 'best';
  fs.writeFileSync(path.join(f.runs, 'task/state.json'), JSON.stringify(state));
  assert.equal((await f.run(['send', 'task'], 'next')).code, 0);
  assert.equal(f.state().options.model, 'gpt-6-astra');
  assert.equal(f.state().options.modelRequest, 'best');
  assert.equal(f.state().options.effort, 'medium');
});

test('models prints best and default sol resolutions; explicit model prints only its resolution', async (t) => {
  const f = fixture(t, 'ok');
  const result = await f.run(['models']);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split('\n').slice(-2), [
    'best → gpt-6-astra（推理档位 high）（刚刚解析）',
    'sol → gpt-6.1-sol（推理档位 high）（刚刚解析）',
  ]);
  assert.equal(modelCalls(f).length, 1);
  const explicit = await f.run(['models', '--model', 'custom-model']);
  assert.equal(explicit.code, 0, explicit.stderr);
  assert.deepEqual(explicit.stdout.split('\n').filter(x => x.includes(' → ')), ['custom-model → custom-model（推理档位 high）（显式型号）']);
});

const terraProtocol = (slug, effort) => `操作电脑界面的部分（computer use：点按软件界面、操作桌面应用，包括 Blender 建模）不要自己做，交给 terra 子代理：用 spawn_agent 派子代理完成，参数 model="${slug}"、reasoning_effort="${effort}"、fork_turns="none"（必须是 none，否则模型设置不生效）。在任务说明里写清它需要的全部上下文、要操作什么、做完交回什么；它做完后由你检查结果再继续。其余工作（写代码、跑命令、读写文件、生成）你自己做。`;
const resolutionCacheFile = (f) => path.join(f.runs, '.model-resolution.json');
const resolutionCache = (f) => JSON.parse(fs.readFileSync(resolutionCacheFile(f), 'utf8'));
const staleCatalogWarning = (slug) => `⚠ 模型目录可能是旧的（缺 ${slug}），沿用最近见过的 ${slug}`;

for (const request of ['sol', 'best']) test(`recent models: ${request} keeps newer missing same-series model and warns in feed`, async (t) => {
  const f = fixture(t, 'ok');
  const newer = model('gpt-6.10-sol', { supported_reasoning_levels: ['high', { effort: 'ultra' }] });
  const older = model('gpt-6.2-sol', { supported_reasoning_levels: ['high'] });
  setModels(f, [older, newer]);
  assert.equal((await f.run(['models', '--model', request])).code, 0);
  const seen = resolutionCache(f).recentModels.find(m => m.slug === newer.slug);
  assert.equal(seen.series, 'sol');
  assert.equal(seen.version, '6.10');
  assert.equal(seen.visibility, 'list');
  assert.equal(seen.supported_in_api, true);
  assert.deepEqual(seen.supported_reasoning_levels, newer.supported_reasoning_levels);
  assert.ok(Number.isFinite(Date.parse(seen.lastSeenAt)));
  setModels(f, [older, model('gpt-99-terra', { supported_reasoning_levels: ['high'] })]);
  const result = await f.run(f.start(['--model', request, '--refresh-models']), 'stale catalog');
  assert.equal(result.code, 0, result.stderr);
  assert.equal(f.state().options.model, newer.slug);
  assert.ok(f.feed().includes(staleCatalogWarning(newer.slug)));
  assert.ok(result.stdout.includes(staleCatalogWarning(newer.slug)));
  const cache = resolutionCache(f);
  assert.equal(cache.entries[`${request}:high`].model, newer.slug);
  assert.equal(cache.recentModels.find(m => m.slug === newer.slug).lastSeenAt, seen.lastSeenAt);
  assert.ok(!cache.entries[`${request}:high`].catalog.some(m => m.slug === newer.slug));
});

test('recent models: terra delegate retains a newer model observed while resolving only sol', async (t) => {
  const f = fixture(t, 'ok');
  setModels(f, [...sampleModels, model('gpt-6.1-terra', { supported_reasoning_levels: ['high'] })]);
  assert.equal((await f.run(['models', '--model', 'sol'])).code, 0);
  assert.equal(resolutionCache(f).entries['terra:high'], undefined);
  setModels(f, sampleModels);
  const result = await f.run(f.start(), 'UI delegation');
  assert.equal(result.code, 0, result.stderr);
  assert.equal(f.state().options.terraModel, 'gpt-6.1-terra');
  assert.ok(f.calls()[0].prompt.endsWith(terraProtocol('gpt-6.1-terra', 'high')));
  assert.ok(f.feed().includes(staleCatalogWarning('gpt-6.1-terra')));
  assert.equal(resolutionCache(f).entries['terra:high'].model, 'gpt-6.1-terra');
});

test('recent models: records expire after seven days without renewing missing models', async (t) => {
  const f = fixture(t, 'ok');
  setModels(f, [model('gpt-6.1-sol'), model('gpt-6-sol')]);
  const args = ['models', '--model', 'sol', '--effort', 'medium', '--refresh-models'];
  assert.equal((await f.run(args)).code, 0);
  setModels(f, [model('gpt-6-sol')]);
  const before = resolutionCache(f).recentModels.find(m => m.slug === 'gpt-6.1-sol').lastSeenAt;
  assert.ok((await f.run(args)).stdout.includes(staleCatalogWarning('gpt-6.1-sol')));
  let cache = resolutionCache(f);
  assert.equal(cache.recentModels.find(m => m.slug === 'gpt-6.1-sol').lastSeenAt, before);
  cache.recentModels.find(m => m.slug === 'gpt-6.1-sol').lastSeenAt = new Date(Date.now() - 8 * 24 * 60 * 60_000).toISOString();
  fs.writeFileSync(resolutionCacheFile(f), JSON.stringify(cache));
  const expired = await f.run(args);
  assert.equal(expired.code, 0, expired.stderr);
  assert.ok(expired.stdout.includes('sol → gpt-6-sol'));
  assert.ok(!expired.stdout.includes('模型目录可能是旧的'));
  cache = resolutionCache(f);
  assert.ok(!cache.recentModels.some(m => m.slug === 'gpt-6.1-sol'));
  assert.equal(cache.entries['sol:medium'].model, 'gpt-6-sol');
});

for (const format of ['legacy', 'v2']) test(`recent models: ${format} cache without history resolves normally and starts recording`, async (t) => {
  const f = fixture(t, 'ok');
  const entry = { model: `gpt-99-${format === 'legacy' ? 'astra' : 'sol'}`, effort: 'medium', at: new Date().toISOString() };
  fs.mkdirSync(f.runs);
  fs.writeFileSync(resolutionCacheFile(f), JSON.stringify(format === 'legacy' ? entry : { version: 2, entries: { 'sol:medium': entry } }));
  setModels(f, [model('gpt-6-sol')]);
  const request = format === 'legacy' ? 'best' : 'sol';
  const result = await f.run(['models', '--model', request, '--effort', 'medium', '--refresh-models']);
  assert.equal(result.code, 0, result.stderr);
  assert.ok(result.stdout.includes(`${request} → gpt-6-sol`));
  assert.ok(!result.stdout.includes('模型目录可能是旧的'));
  const cache = resolutionCache(f);
  assert.equal(cache.version, 2);
  assert.deepEqual(cache.recentModels.map(m => m.slug), ['gpt-6-sol']);
});

test('recent models: future and invalid timestamps or malformed records are ignored and pruned', async (t) => {
  const f = fixture(t, 'ok');
  fs.mkdirSync(f.runs);
  const recentModels = [null, {}, { slug: 12 },
    ...['invalid', new Date(Date.now() + 24 * 60 * 60_000).toISOString(), null].map((lastSeenAt, i) => ({ ...model(`gpt-${90 + i}-sol`), lastSeenAt }))];
  fs.writeFileSync(resolutionCacheFile(f), JSON.stringify({ version: 2, entries: {}, recentModels }));
  setModels(f, [model('gpt-6-sol')]);
  const result = await f.run(['models', '--model', 'sol', '--effort', 'medium']);
  assert.equal(result.code, 0, result.stderr);
  assert.ok(result.stdout.includes('sol → gpt-6-sol'));
  assert.ok(!result.stdout.includes('模型目录可能是旧的'));
  assert.deepEqual(resolutionCache(f).recentModels.map(m => m.slug), ['gpt-6-sol']);
});

test('recent models: missing history filters visibility API effort and series before numeric version selection', async (t) => {
  const f = fixture(t, 'ok');
  setModels(f, [model('gpt-6-sol'), model('gpt-6.2-sol'), model('gpt-6.10-sol'),
    model('gpt-90-sol', { visibility: 'hide' }), model('gpt-91-sol', { supported_in_api: false }),
    model('gpt-92-sol', { supported_reasoning_levels: ['high'] }), model('gpt-99-astra'), model('gpt-100-terra')]);
  const args = ['models', '--model', 'sol', '--effort', 'medium', '--refresh-models'];
  assert.equal((await f.run(args)).code, 0);
  setModels(f, [model('gpt-6-sol')]);
  const result = await f.run(args);
  assert.equal(result.code, 0, result.stderr);
  assert.ok(result.stdout.includes(staleCatalogWarning('gpt-6.10-sol')));
  assert.equal(resolutionCache(f).entries['sol:medium'].model, 'gpt-6.10-sol');
});

for (const kind of ['visibility', 'API', 'effort']) test(`recent models: current ${kind} exclusion replaces remembered eligibility`, async (t) => {
  const f = fixture(t, 'ok');
  const newer = model('gpt-6.1-sol');
  setModels(f, [model('gpt-6-sol'), newer]);
  const args = ['models', '--model', 'sol', '--effort', 'medium', '--refresh-models'];
  assert.equal((await f.run(args)).code, 0);
  setModels(f, [model('gpt-6-sol'), { ...newer, ...(kind === 'visibility' ? { visibility: 'hide' }
    : kind === 'API' ? { supported_in_api: false } : { supported_reasoning_levels: ['high'] }) }]);
  const excluded = await f.run(args);
  assert.equal(excluded.code, 0, excluded.stderr);
  assert.ok(excluded.stdout.includes('sol → gpt-6-sol'));
  setModels(f, [model('gpt-6-sol')]);
  const missing = await f.run(args);
  assert.equal(missing.code, 0, missing.stderr);
  assert.ok(missing.stdout.includes('sol → gpt-6-sol'));
  assert.ok(!missing.stdout.includes('模型目录可能是旧的'));
});

test('recent models: repeated catalogs preserve one-hop upgrade and do not warn on equal versions', async (t) => {
  const f = fixture(t, 'ok');
  const args = ['models', '--model', 'sol', '--effort', 'medium', '--refresh-models'];
  setModels(f, [model('gpt-6.2-sol', { upgrade: 'gpt-6.1-sol' }), model('gpt-6.1-sol')]);
  for (let i = 0; i < 2; i++) {
    const result = await f.run(args);
    assert.equal(result.code, 0, result.stderr);
    assert.ok(result.stdout.includes('sol → gpt-6.1-sol'));
    assert.ok(!result.stdout.includes('模型目录可能是旧的'));
  }
  setModels(f, [model('gpt-7.0-sol')]);
  assert.equal((await f.run(args)).code, 0);
  setModels(f, [model('gpt-7-sol')]);
  const equal = await f.run(args);
  assert.equal(equal.code, 0, equal.stderr);
  assert.ok(equal.stdout.includes('sol → gpt-7-sol'));
  assert.ok(!equal.stdout.includes('模型目录可能是旧的'));
});

test('recent models: successful explicit and ineligible catalogs are recorded but failed refreshes do not renew history', async (t) => {
  const f = fixture(t, 'ok');
  setModels(f, [model('gpt-6.1-sol')]);
  assert.equal((await f.run(['models', '--model', 'custom'])).code, 0);
  assert.deepEqual(Object.keys(resolutionCache(f).entries), []);
  assert.equal((await f.run(['models', '--model', 'terra'])).code, 1);
  assert.equal(resolutionCache(f).recentModels[0].slug, 'gpt-6.1-sol');
  const before = fs.readFileSync(resolutionCacheFile(f), 'utf8');
  f.env.FAKE_MODELS_MODE = 'fail';
  assert.equal((await f.run(['models', '--model', 'sol'])).code, 1);
  assert.equal(fs.readFileSync(resolutionCacheFile(f), 'utf8'), before);
});

test('recent models: reappearance renews history once and remembers effort levels not previously selected', async (t) => {
  const f = fixture(t, 'ok');
  const older = model('gpt-6-sol', { supported_reasoning_levels: ['medium', 'ultra'] });
  const newer = model('gpt-6.1-sol', { supported_reasoning_levels: ['medium', { effort: 'ultra' }] });
  setModels(f, [older, newer]);
  const args = ['models', '--model', 'sol', '--effort', 'medium', '--refresh-models'];
  assert.equal((await f.run(args)).code, 0);
  const cache = resolutionCache(f);
  const before = new Date(Date.now() - 6 * 24 * 60 * 60_000).toISOString();
  cache.recentModels.find(m => m.slug === newer.slug).lastSeenAt = before;
  fs.writeFileSync(resolutionCacheFile(f), JSON.stringify(cache));
  assert.equal((await f.run(args)).code, 0);
  const seen = resolutionCache(f).recentModels.filter(m => m.slug === newer.slug);
  assert.equal(seen.length, 1);
  assert.ok(Date.parse(seen[0].lastSeenAt) > Date.parse(before));
  setModels(f, [older]);
  const result = await f.run(['models', '--model', 'sol', '--effort', 'ultra']);
  assert.equal(result.code, 0, result.stderr);
  assert.ok(result.stdout.includes(staleCatalogWarning(newer.slug)));
  assert.equal(resolutionCache(f).entries['sol:ultra'].model, newer.slug);
});

function assertNoTerraDelegate(f, index = 0) {
  const { prompt } = f.calls()[index];
  assert.ok(!prompt.includes('操作电脑界面的部分（computer use：'));
  assert.ok(prompt.includes('不要再启动 codex，也不要派生子 Agent。'));
  assert.equal(f.state().options.terraModel, undefined);
}

test('terra delegate: default sol appends exact protocol with latest eligible terra and ordered feed', async (t) => {
  const f = fixture(t, 'ok');
  setModels(f, [...sampleModels,
    model('gpt-6.1-terra', { supported_reasoning_levels: ['high'] }),
    model('gpt-9-terra', { visibility: 'hide', supported_reasoning_levels: ['high'] }),
    model('gpt-8-terra', { supported_in_api: false, supported_reasoning_levels: ['high'] }),
    model('gpt-7-terra'),
  ]);
  const result = await f.run(f.start(), '界面与代码混合任务');
  assert.equal(result.code, 0, result.stderr);
  assert.equal(f.state().options.model, 'gpt-6.1-sol');
  assert.equal(f.state().options.effort, 'high');
  assert.ok(f.calls()[0].prompt.endsWith(terraProtocol('gpt-6.1-terra', 'high')));
  assert.ok(f.calls()[0].prompt.includes('只允许下述 terra 界面操作子代理，不要派生其他子 Agent。'));
  assert.match(f.feed(), /sol → gpt-6.1-sol（推理档位 high）\n[^\n]*界面操作子代理 → gpt-6.1-terra（推理档位 high）/);
  assert.ok(result.stdout.includes('界面操作子代理 → gpt-6.1-terra（推理档位 high）'));
  assert.equal(modelCalls(f).length, 1);
  const entries = JSON.parse(fs.readFileSync(path.join(f.runs, '.model-resolution.json'))).entries;
  assert.equal(entries['terra:high'].model, 'gpt-6.1-terra');
  assert.equal(entries['sol:high'].model, 'gpt-6.1-sol');
});

for (const request of ['terra', 'gpt-6.1-terra', 'best']) test(`terra delegate: terra main via ${request} omits delegation`, async (t) => {
  const f = fixture(t, 'ok');
  setModels(f, [model('gpt-6.1-terra', { supported_reasoning_levels: ['high'] })]);
  const result = await f.run(f.start(['--model', request]), 'terra handles UI itself');
  assert.equal(result.code, 0, result.stderr);
  assert.equal(f.state().options.model, 'gpt-6.1-terra');
  assertNoTerraDelegate(f);
  assert.ok(!f.feed().includes('界面操作子代理 →'));
  assert.ok(!f.feed().includes('本任务不派 terra 子代理'));
  assert.equal(modelCalls(f).length, request === 'gpt-6.1-terra' ? 0 : 1);
});

for (const mode of ['ineligible', 'fail', 'invalid']) test(`terra delegate: ${mode} warns and starts normally without delegation`, async (t) => {
  const f = fixture(t, 'ok');
  if (mode === 'ineligible') setModels(f, [model('gpt-6.1-terra')]);
  else f.env.FAKE_MODELS_MODE = mode;
  const result = await f.run(f.start(['--model', 'gpt-6.1-sol']), 'keep running');
  assert.equal(result.code, 0, result.stderr);
  assert.equal(f.state().status, 'completed');
  assertNoTerraDelegate(f);
  assert.ok(f.feed().includes('⚠ 没有可用的 terra 系列模型，本任务不派 terra 子代理'));
  assert.ok(!f.feed().includes('界面操作子代理 →'));
  assert.equal(modelCalls(f).length, 1);
});

for (const kind of ['fresh', 'expired', 'refresh', 'effort', 'stale fallback']) test(`terra delegate cache: ${kind}`, async (t) => {
  const f = fixture(t, 'ok');
  fs.mkdirSync(f.runs);
  const cached = { model: 'gpt-6-terra', effort: 'high', at: new Date(Date.now() - (['expired', 'stale fallback'].includes(kind) ? 25 * 60 * 60_000 : 0)).toISOString() };
  fs.writeFileSync(path.join(f.runs, '.model-resolution.json'), JSON.stringify({ version: 2, entries: { 'terra:high': cached } }));
  setModels(f, [model('gpt-6.1-terra', { supported_reasoning_levels: ['high', 'medium'] })]);
  if (['fresh', 'stale fallback'].includes(kind)) f.env.FAKE_MODELS_MODE = 'fail';
  const effort = kind === 'effort' ? 'medium' : 'high';
  const result = await f.run(f.start(['--model', 'gpt-6.1-sol', '--effort', effort, ...(kind === 'refresh' ? ['--refresh-models'] : [])]), 'cache');
  assert.equal(result.code, 0, result.stderr);
  const expected = ['fresh', 'stale fallback'].includes(kind) ? 'gpt-6-terra' : 'gpt-6.1-terra';
  assert.ok(f.calls()[0].prompt.endsWith(terraProtocol(expected, effort)));
  assert.ok(f.feed().includes(`界面操作子代理 → ${expected}（推理档位 ${effort}）`));
  assert.equal(modelCalls(f).length, kind === 'fresh' ? 0 : 1);
  assert.ok(!f.feed().includes('本任务不派 terra 子代理'));
  if (kind === 'stale fallback') assert.ok(f.feed().includes('⚠ 获取模型目录失败，沿用上次解析的 gpt-6-terra'));
  const entries = JSON.parse(fs.readFileSync(path.join(f.runs, '.model-resolution.json'))).entries;
  assert.equal(entries[`terra:${effort}`].model, expected);
  if (kind === 'effort') assert.deepEqual(entries['terra:high'], cached);
});

for (const command of ['send', 'resume']) test(`terra delegate: ${command} refreshes model and effort and clears stale delegation`, async (t) => {
  const f = fixture(t, 'ok');
  assert.equal((await f.run(f.start(), 'initial')).code, 0);
  assert.ok(f.calls()[0].prompt.endsWith(terraProtocol('gpt-5.6-terra', 'high')));
  await until(() => !alive(f.state().supervisorPid));
  setModels(f, [...sampleModels, model('gpt-6.1-terra', { supported_reasoning_levels: ['medium', 'high'] })]);
  assert.equal((await f.run([command, 'task'], 'refresh same effort')).code, 0);
  assert.ok(f.calls()[1].prompt.endsWith(terraProtocol('gpt-6.1-terra', 'high')));
  assert.equal(modelCalls(f).length, 2);
  await until(() => !alive(f.state().supervisorPid));
  assert.equal((await f.run([command, 'task', '--effort', 'medium'], 'next')).code, 0);
  assert.ok(f.calls()[2].prompt.endsWith(terraProtocol('gpt-6.1-terra', 'medium')));
  assert.equal(modelCalls(f).length, 3);
  await until(() => !alive(f.state().supervisorPid));
  const feedOffset = f.feed().length;
  f.env.FAKE_MODELS_MODE = 'fail';
  assert.equal((await f.run([command, 'task', '--model', 'gpt-6.1-sol', '--effort', 'low'], 'unavailable')).code, 0);
  assertNoTerraDelegate(f, 3);
  const failedFeed = f.feed().slice(feedOffset);
  assert.ok(failedFeed.includes('⚠ 没有可用的 terra 系列模型，本任务不派 terra 子代理'));
  assert.ok(!failedFeed.includes('界面操作子代理 →'));
  assert.equal(modelCalls(f).length, 4);
  await until(() => !alive(f.state().supervisorPid));
  delete f.env.FAKE_MODELS_MODE;
  assert.equal((await f.run([command, 'task', '--effort', 'high'], 'delegate again')).code, 0);
  assert.ok(f.calls()[4].prompt.endsWith(terraProtocol('gpt-6.1-terra', 'high')));
  assert.equal(modelCalls(f).length, 5);
  await until(() => !alive(f.state().supervisorPid));
  const terraFeedOffset = f.feed().length;
  assert.equal((await f.run([command, 'task', '--model', 'gpt-6.1-terra'], 'main terra')).code, 0);
  assertNoTerraDelegate(f, 5);
  assert.ok(!f.feed().slice(terraFeedOffset).includes('界面操作子代理 →'));
  assert.equal(modelCalls(f).length, 5);
});

function dshFixture(t, scenario = 'ok') {
  const f = agentStatusFixture(t, scenario);
  return { ...f, start: (extra = []) => f.start(['--agent', 'dsh', ...extra]) };
}

test('DSH: default launch, task patch, stdin protocol and no Codex catalog or terra', async (t) => {
  const f = dshFixture(t);
  writeConfig(f, 'model_instructions_file = "/must-not-affect-dsh"\n');
  const result = await f.run(f.start(['--add-dir', os.tmpdir()]), 'DSH brief\n全文保留');
  assert.equal(result.code, 0, result.stderr);
  const s = f.state();
  assert.equal(s.agent, 'dsh');
  assert.equal(s.options.model, 'deepseek-flash');
  assert.equal(s.options.effort, 'high');
  assert.equal(s.options.terraModel, undefined);
  assert.equal(s.threadId, 'session-fake-dsh-001');
  assert.equal(modelCalls(f).length, 0);
  const call = f.calls()[0];
  const patch = path.join(f.runs, 'task/dsh.patch.yml');
  assert.deepEqual(call.argv, ['--profile', 'headless', '--patch', patch, '--json', '--approval-policy', 'never',
    '--permission-mode', 'danger-full-access', '--add-dir', path.join(f.runs, 'task'), '--add-dir', path.resolve(os.tmpdir()), '-']);
  assert.equal(fs.realpathSync(call.cwd), fs.realpathSync(f.root));
  assert.equal(call.patch, '- id: agent-default-model\n  config:\n    provider: deepseek-official\n    model: "deepseek-flash"\n    reasoningEffort: "high"\n- id: bash-sandbox\n  config:\n    timeoutMs: 1800000\n');
  assert.equal(fs.readFileSync(patch, 'utf8'), call.patch);
  assert.ok(call.prompt.startsWith('DSH brief\n全文保留\n\n---'));
  for (const text of [' ask task', ' inbox task', 'progress.log', 'decisions.md', '我自己做的决定']) assert.ok(call.prompt.includes(text));
  assert.doesNotMatch(call.prompt, /terra|spawn_agent|computer use/);
  assert.match(f.feed(), /DSH · deepseek-flash · high/);
  assert.equal(f.agent().label, 'DSH：task（deepseek-flash · 高档推理）');
  assert.equal(f.agent().state, 'completed');
  assert.match(result.stdout, /✅ task 本轮完成/);
  assert.match(result.stdout, /--- DSH 回复 ---\n假 DSH 回复：任务完成。\n第二行完整保留。/);
  assert.equal(fs.readFileSync(s.turns[0].files.last, 'utf8'), '假 DSH 回复：任务完成。\n第二行完整保留。\n我自己做的决定：无');
  const status = await f.run(['status', 'task']);
  assert.match(status.stdout, /"agent": "dsh"/);
  assert.match((await f.run(['watch', 'task'])).stdout, /--- DSH 回复 ---/);
});

for (const [requested, expected, effort, chinese] of [
  ['flash', 'deepseek-flash', 'off', '关闭'],
  ['pro', 'deepseek-v4-pro', 'max', '最高档'],
  ['custom-model: v2', 'custom-model: v2', 'low', '低档'],
  ['sol', 'sol', 'high', '高档'],
  ['constructor', 'constructor', 'high', '高档'],
]) test(`DSH: model ${requested} and effort ${effort} stay outside Codex resolution`, async (t) => {
  const f = dshFixture(t);
  assert.equal((await f.run(f.start(['--model', requested, '--effort', effort]), 'model')).code, 0);
  assert.equal(f.state().options.model, expected);
  assert.ok(f.calls()[0].patch.includes(`model: ${JSON.stringify(expected)}`));
  assert.ok(f.calls()[0].patch.includes(`reasoningEffort: "${effort}"`));
  assert.equal(f.agent().label, `DSH：task（${expected} · ${chinese}推理）`);
  assert.equal(modelCalls(f).length, 0);
});

for (const command of ['send', 'resume']) test(`DSH: ${command} uses stored agent and session, preserves sandbox and updates patch`, async (t) => {
  const f = dshFixture(t);
  assert.equal((await f.run(f.start(['--sandbox']), 'initial')).code, 0);
  assert.equal(f.calls()[0].argv[f.calls()[0].argv.indexOf('--permission-mode') + 1], 'workspace-write');
  await until(() => !alive(f.state().supervisorPid));
  // DSH must discard stale Codex delegation/model metadata even on an existing state.
  const state = f.state();
  state.options.terraModel = 'gpt-6.1-terra';
  state.options.modelRequest = 'sol';
  fs.writeFileSync(path.join(f.runs, 'task/state.json'), JSON.stringify(state));
  const result = await f.run([command, 'task', '--model', 'pro', '--effort', 'max'], 'follow up');
  assert.equal(result.code, 0, result.stderr);
  const call = f.calls().at(-1);
  assert.equal(call.argv[call.argv.indexOf('--session-id') + 1], state.threadId);
  assert.equal(call.argv[call.argv.indexOf('--permission-mode') + 1], 'workspace-write');
  assert.equal(call.argv[call.argv.indexOf('--approval-policy') + 1], 'never');
  assert.match(call.patch, /model: "deepseek-v4-pro"/);
  assert.match(call.patch, /reasoningEffort: "max"/);
  assert.doesNotMatch(call.prompt, /terra|spawn_agent/);
  assert.equal(f.agent().label, 'DSH：task（deepseek-v4-pro · 最高档推理）');
  await until(() => !alive(f.state().supervisorPid));
  assert.equal((await f.run([command, 'task', '--full-access'], 'switch access')).code, 0);
  assert.equal(f.calls().at(-1).argv[f.calls().at(-1).argv.indexOf('--permission-mode') + 1], 'danger-full-access');
  assert.equal(modelCalls(f).length, 0);
});

test('DSH: tool_call and text map to visible activity and explanation', async (t) => {
  const f = dshFixture(t, 'activity');
  f.env.FAKE_DSH_GATE = path.join(f.root, 'gate');
  const running = f.launch(f.start(), 'activity');
  await until(() => fs.existsSync(path.join(f.runs, 'task/state.json')) && f.state().activity === '运行 echo hello');
  assert.equal(f.agent().detail, '运行 echo hello');
  fs.writeFileSync(`${f.env.FAKE_DSH_GATE}.text`, '');
  await until(() => f.state().activity === '说明：正在整理数据');
  assert.equal(f.agent().detail, '说明：正在整理数据');
  fs.writeFileSync(`${f.env.FAKE_DSH_GATE}.tool`, '');
  await until(() => f.state().activity === '调用工具 read');
  assert.equal(f.agent().detail, '调用工具 read');
  fs.writeFileSync(`${f.env.FAKE_DSH_GATE}.done`, '');
  assert.equal((await running.result).code, 0);
});

for (const error of [
  { code: 'MISSING_CREDENTIAL', message: 'No credential; network unavailable' },
  { code: 'HTTP_ERROR', status: 401, message: 'rate limit' },
  { message: '403 Forbidden' },
]) test(`DSH: fatal final error does not retry ${JSON.stringify(error)}`, async (t) => {
  const f = dshFixture(t, 'fatal');
  f.env.FAKE_DSH_ERROR = JSON.stringify(error);
  const result = await f.run(f.start(), 'fatal');
  assert.equal(result.code, 2);
  assert.equal(f.state().status, 'failed');
  assert.equal(f.calls().length, 1);
  assert.equal(f.state().turns[0].result, 'fatal');
  assert.match(result.stdout, /❌ task 失败/);
  assert.equal(f.agent().state, 'error');
});

for (const error of [
  { code: 'HTTP_ERROR', message: '429 rate limit' },
  { code: 'ECONNRESET', message: 'stream disconnected' },
  { code: 'HTTP_ERROR', status: 503, message: 'service busy' },
]) test(`DSH: retryable final error resumes session ${JSON.stringify(error)}`, async (t) => {
  const f = dshFixture(t, 'retry-then-ok');
  f.env.FAKE_DSH_ERROR = JSON.stringify(error);
  const result = await f.run(f.start(), 'retry');
  assert.equal(result.code, 0, result.stderr);
  assert.equal(f.calls().length, 2);
  assert.deepEqual(f.state().turns.map((turn) => turn.result), ['retryable', 'completed']);
  assert.equal(f.calls()[1].argv[f.calls()[1].argv.indexOf('--session-id') + 1], f.state().threadId);
  assert.match(f.calls()[1].prompt, /不要重做已经完成的部分/);
  assert.match(f.feed(), /第 1\/1 次重试/);
});

for (const scenario of ['empty', 'no-newline']) test(`DSH: completed ${scenario} writes reply and succeeds`, async (t) => {
  const f = dshFixture(t, scenario);
  const result = await f.run(f.start(), 'reply');
  assert.equal(result.code, 0, result.stderr);
  const text = fs.readFileSync(f.state().turns[0].files.last, 'utf8');
  assert.equal(text, scenario === 'empty' ? '（DSH 没有给出文字回复）' : '假 DSH 回复：任务完成。\n第二行完整保留。\n我自己做的决定：无');
  assert.ok(result.stdout.includes(text));
});

test('DSH: missing final retries abnormal exit and exhaustion returns 3', async (t) => {
  const f = dshFixture(t, 'missing-final-then-ok');
  assert.equal((await f.run(f.start(), 'retry missing final')).code, 0);
  assert.deepEqual(f.state().turns.map((turn) => turn.result), ['retryable', 'completed']);
  assert.match(f.state().turns[0].error, /未收到 final/);
  const failed = dshFixture(t, 'abnormal');
  assert.equal((await failed.run(failed.start(), 'abnormal')).code, 3);
  assert.equal(failed.calls().length, 2);
  assert.equal(failed.state().status, 'failed');
});

for (const mode of ['missing', 'not-executable']) test(`DSH: ${mode} binary fails state without retry`, async (t) => {
  const f = dshFixture(t);
  f.env.DSH_BIN = path.join(f.root, 'dsh');
  if (mode === 'not-executable') fs.writeFileSync(f.env.DSH_BIN, '#!/bin/sh\nexit 0\n', { mode: 0o600 });
  const result = await f.run(f.start(), 'missing executable');
  assert.equal(result.code, 2);
  assert.equal(f.state().status, 'failed');
  assert.equal(f.state().turns.length, 1);
  assert.match(f.state().error, /spawn failed/);
  assert.equal(f.state().pid, null);
});

test('DSH: every status and tool_result event keeps watchdog alive', async (t) => {
  const f = dshFixture(t, 'heartbeat');
  const result = await f.run(f.start(['--idle-min', '0.01', '--warn-min', '0.008']), 'heartbeat');
  assert.equal(result.code, 0, result.stderr);
  assert.equal(f.calls().length, 1);
  assert.doesNotMatch(f.feed(), /没有动静/);
});

test('DSH: detached watch deadline, reattach, stop and max duration share supervisor behavior', async (t) => {
  const f = dshFixture(t, 'hang');
  const result = await f.run(f.start(['--watch-min', '0.008']), 'detach');
  assert.equal(result.code, 8);
  assert.equal(f.state().agent, 'dsh');
  assert.ok(alive(f.state().pid));
  assert.ok(alive(f.state().supervisorPid));
  const watching = await f.run(['watch', 'task', '--watch-min', '0.008']);
  assert.equal(watching.code, 8);
  assert.equal((await f.run(['stop', 'task'])).code, 0);
  assert.equal((await f.run(['watch', 'task'])).code, 5);
  assert.equal(f.agent().state, 'stopped');
  const timeout = dshFixture(t, 'hang');
  assert.equal((await timeout.run(timeout.start(['--max-min', '0.01']), 'timeout')).code, 4);
  assert.equal(timeout.state().status, 'timeout');
});

test('DSH: protocol ask, answer, note and inbox keep the same commands', async (t) => {
  const f = dshFixture(t, 'ask-protocol');
  const running = f.launch(f.start(), 'ask');
  assert.equal((await running.result).code, 7);
  await until(() => f.state().waitingQuestions?.length === 1);
  await until(() => f.agent().state === 'waiting');
  await sleep(3500);
  assert.equal(f.state().turns.length, 1);
  assert.equal((await f.run(['note', 'task'], '整理结果保留原顺序')).code, 0);
  assert.equal((await f.run(['answer', 'task', '1'], '选择 A')).code, 0);
  const watching = await f.run(['watch', 'task']);
  assert.equal(watching.code, 0, watching.stderr);
  assert.match(watching.stdout, /--- DSH 回复 ---/);
  assert.equal(fs.readFileSync(path.join(f.root, 'fake/answer.txt'), 'utf8'), '选择 A');
  assert.match(fs.readFileSync(path.join(f.root, 'fake/inbox.txt'), 'utf8'), /整理结果保留原顺序/);
  assert.match((await f.run(['inbox', 'task'])).stdout, /没有新的回答或留言/);
});

test('DSH: out-of-scope git report uses the common turn check', async (t) => {
  const f = dshFixture(t, 'scope-change');
  assert.equal(spawnSync('git', ['init', f.root]).status, 0);
  const sub = path.join(fs.realpathSync(f.root), 'sub');
  fs.mkdirSync(sub);
  fs.mkdirSync(path.join(f.root, 'outside'));
  fs.writeFileSync(path.join(f.root, '.gitignore'), '/fake/\n/runs/\n/agents/\n');
  f.env.FAKE_SCOPE_ROOT = f.root;
  assert.equal((await f.run(f.start(['--cd', sub]), 'scope')).code, 0);
  assert.match(f.feed(), /outside\/turn-1\.txt/);
  assert.doesNotMatch(f.feed(), /inside-1\.txt/);
});

test('DSH: validation rejects unknown agent, unsupported effort and changing stored agent', async (t) => {
  const f = dshFixture(t);
  assert.equal((await f.run(f.start(['--agent', 'other']), 'invalid agent')).code, 1);
  assert.equal((await f.run(f.start(['--effort', 'medium']), 'invalid effort')).code, 1);
  assert.equal(fs.existsSync(path.join(f.runs, 'task/state.json')), false);
  assert.equal((await f.run(f.start(), 'valid')).code, 0);
  await until(() => !alive(f.state().supervisorPid));
  assert.equal((await f.run(['send', 'task', '--agent', 'codex'], 'switch')).code, 1);
  assert.equal(f.calls().length, 1);
  assert.equal((await f.run(['models', '--agent', 'dsh'])).code, 1);
  assert.equal(modelCalls(f).length, 0);
});

test('DSH: nettop samples the executor process tree and stop cleans its worker', { skip: process.platform !== 'darwin' }, async (t) => {
  const f = dshFixture(t, 'network');
  f.env.FOREMAN_NETTOP = path.join(repo, 'tests/fixtures/fake-nettop.mjs');
  f.env.FAKE_NETTOP_MODE = 'grow';
  f.env.PATH = `${path.join(repo, 'tests/fixtures')}:${process.env.PATH}`;
  assert.equal((await f.run(f.start(['--no-watch', '--idle-min', '0.12', '--warn-min', '0.1', '--retries', '0']), 'network')).code, 0);
  await until(() => f.state().activity?.startsWith('生成中'));
  const worker = Number(fs.readFileSync(path.join(f.root, 'fake/worker.pid'), 'utf8'));
  const samples = fs.readFileSync(path.join(f.root, 'fake/nettop-calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(samples.some(({ args }) => args.includes(String(worker))));
  await until(() => /^生成中 (?:[4-9]|1\d)秒/.test(f.state().activity));
  assert.equal(f.state().status, 'running');
  assert.equal(f.state().turns.length, 1);
  assert.equal((await f.run(['stop', 'task'])).code, 0);
  assert.equal(alive(worker), false);
});

test('Codex: explicit agent and legacy state without agent retain Codex behavior', async (t) => {
  const f = fixture(t, 'ok');
  assert.equal((await f.run(f.start(['--agent', 'codex']), 'initial')).code, 0);
  assert.equal(f.state().agent, 'codex');
  await until(() => !alive(f.state().supervisorPid));
  const state = f.state();
  delete state.agent;
  fs.writeFileSync(path.join(f.runs, 'task/state.json'), JSON.stringify(state));
  assert.equal((await f.run(['send', 'task'], 'legacy')).code, 0);
  assert.equal(f.calls().at(-1).argv[0], 'exec');
  assert.equal(f.state().agent, 'codex');
});
