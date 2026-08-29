/** Minimal paid-agent replacement for Playwright: a real tmux process that
 * publishes Claude-shaped identity/status files and accepts terminal input. */

import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const VERSION = '2.1.220';
const GREETING = 'stub agent ready';
const sessionId = randomUUID();
const project = join(
  homedir(),
  '.claude',
  'projects',
  realpathSync(process.cwd()).replace(/[^a-zA-Z0-9]/g, '-'),
);
mkdirSync(project, { recursive: true });
const transcript = join(project, `${sessionId}.jsonl`);

function record(type: 'user' | 'assistant', text: string): void {
  appendFileSync(
    transcript,
    `${JSON.stringify({
      type,
      uuid: randomUUID(),
      timestamp: new Date().toISOString(),
      version: VERSION,
      message: { role: type, content: [{ type: 'text', text }] },
    })}\n`,
  );
}

const registry = join(homedir(), '.claude', 'sessions');
mkdirSync(registry, { recursive: true });

function processStart(pid: number): string {
  if (process.platform === 'linux') {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(') ') + 2).split(' ')[19]!;
  }
  if (process.platform === 'darwin') {
    const result = spawnSync('ps', ['-p', String(pid), '-o', 'lstart='], {
      encoding: 'utf8',
      env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
    });
    const started = result.stdout.trim();
    if (started !== '') return started;
  }
  throw new Error(`the e2e stub does not know ${process.platform}'s process identity`);
}

const procStart = processStart(process.pid);
function publish(status: 'busy' | 'idle'): void {
  writeFileSync(
    join(registry, `${process.pid}.json`),
    JSON.stringify({ pid: process.pid, procStart, sessionId, status }),
  );
}

record('assistant', GREETING);
publish('idle');
process.stdout.write(`${GREETING}\n`);

const lines = createInterface({ input: process.stdin, output: process.stdout });
lines.on('line', (line) => {
  const text = line.trim();
  if (text === '') return;
  publish('busy');
  record('user', text);

  if (text === 'print terminal history') {
    for (let at = 1; at <= 120; at += 1) process.stdout.write(`HISTORY-${at}\n`);
    record('assistant', 'printed terminal history');
  } else {
    const reply = `echo ${text}`;
    record('assistant', reply);
    process.stdout.write(`${reply}\n`);
  }
  publish('idle');
});
