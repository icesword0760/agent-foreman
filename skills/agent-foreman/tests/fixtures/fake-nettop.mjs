#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
const dir = process.env.FAKE_CODEX_STATE_DIR;
const file = path.join(dir, 'nettop-count');
fs.mkdirSync(dir, { recursive: true });
const count = Number(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : 0);
fs.writeFileSync(file, String(count + 1));
fs.appendFileSync(path.join(dir, 'nettop-calls.jsonl'), JSON.stringify({ pid: process.pid, args: process.argv.slice(2) }) + '\n');
const mode = process.env.FAKE_NETTOP_MODE;
if (mode === 'timeout') await new Promise((resolve) => setTimeout(resolve, 60_000));
if (mode === 'error') process.exit(1);
if (mode === 'invalid') { console.log('invalid'); process.exit(0); }
let bytes = mode === 'flat' ? 10000 : mode === 'reset' ? (count ? count * 4096 : 100000) : count * 4096;
if (mode === 'stop' && count >= 2) bytes = 4096;
// Only the native child has traffic: the supervisor must request the entire tree.
let worker;
try { worker = fs.readFileSync(path.join(dir, 'worker.pid'), 'utf8'); } catch {}
console.log(',bytes_in,');
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) if (args[i] === '-p') {
  const pid = args[++i];
  console.log(`codex.${pid},${mode === 'reset' && count === 0 && i === args.indexOf('-p') + 1 ? 100000 : pid === worker ? bytes : 0},`);
}
