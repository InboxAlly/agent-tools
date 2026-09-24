// One recorded agent run. Every tool the agent is given reads and writes this directory, so a
// run spread across many processes — and across a deliberate restart — keeps one sending
// platform, one synthetic placement service, one CLI store, and one ordered event log.
//
// A session directory is the harness's own, and the agent never works in it:
//   session.json   scenario, synthetic service records, mock platform lists
//   events.jsonl   the trace body, appended as things happen
//   runs/          the CLI's local store (environment "mock")
// The agent gets a separate, randomly named workspace holding only bin/, skill/ and work/, and
// nothing in it names the scenario or its faults. This is isolation by instruction, not a
// sandbox: the wrappers in bin/ must name this directory to find it, so an agent that reads
// them can follow the path here. The operator checks each agent's transcript for reads outside
// its workspace before a run counts. In the first recorded round, one agent read session.json
// before acting, and its result was invalidated.

import { appendFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { join, resolve } from 'node:path';

export function sessionDir() {
  const dir = process.env.EVAL_SESSION;
  if (!dir) throw new Error('EVAL_SESSION is not set; run the tools through the session wrappers.');
  return resolve(dir);
}

// One tool invocation at a time. Agents issue parallel shell calls, and each tool reads the
// whole session and writes it back, so without this a concurrent pair loses one's update. A
// lock is never taken over automatically: two waiters can both judge it stale, and one would
// then delete the other's fresh lock. A tool that throws still releases it; only a killed
// process leaves one behind, and then the operator removes it.
export async function exclusive(dir, action) {
  const lock = join(dir, 'session.lock');
  for (let waited = 0; ; waited += 25) {
    try { await mkdir(lock); break; }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (waited > 60000) throw new Error(`the session is locked; if no tool is running, remove ${lock}`);
      await sleep(25);
    }
  }
  try { return await action(); }
  finally { await rm(lock, { recursive: true, force: true }); }
}

export async function load(dir) {
  return JSON.parse(await readFile(join(dir, 'session.json'), 'utf8'));
}

// Written through a rename so an interrupted tool never leaves a half-written session.
export async function save(dir, session) {
  const temporary = join(dir, `session.json.${process.pid}`);
  await writeFile(temporary, JSON.stringify(session, null, 2) + '\n');
  await rename(temporary, join(dir, 'session.json'));
}

export async function record(dir, event) {
  await appendFile(join(dir, 'events.jsonl'), JSON.stringify(event) + '\n');
}

export async function events(dir) {
  let text;
  try { text = await readFile(join(dir, 'events.jsonl'), 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  return text.split('\n').filter(Boolean).map(line => JSON.parse(line));
}

export async function create(dir, scenario, workspace) {
  await mkdir(join(dir, 'runs'), { recursive: true });
  await save(dir, { scenario, workspace, service: { tests: [] }, platform: { lists: [], seeded: false } });
  await writeFile(join(dir, 'events.jsonl'), '');
}
