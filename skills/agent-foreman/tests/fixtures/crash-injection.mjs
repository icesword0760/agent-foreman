// Test-only preload: exercise real event-loop failures without a production hook.
import fs from 'node:fs';

if (process.argv[2] === '_supervise' && !process.argv.includes('--_stop')) {
  const mode = process.env.FAKE_CRASH_MODE;
  const error = () => new Error('注'.repeat(210) + '\nsecond line must not persist');
  if (mode === 'main-rejection') {
    const read = fs.readFileSync;
    fs.readFileSync = function (file, ...args) {
      if (String(file).endsWith('.prompt.md')) throw error();
      return read.call(this, file, ...args);
    };
  } else {
    const create = fs.createWriteStream;
    fs.createWriteStream = function (file, ...args) {
      const stream = create.call(this, file, ...args);
      if (String(file).endsWith('.events.jsonl')) {
        setTimeout(() => {
          if (mode === 'unhandledRejection') void Promise.reject(error());
          else stream.emit('error', error());
        }, 100);
      }
      return stream;
    };
  }
}
