#!/usr/bin/env node
// The operator's side of a recorded run. The operator plays the user and is the only one who
// can say what the user said, whether it approved something, and when the conversation was
// lost. Claims are transcribed from the agent's own words, with the words kept beside them so
// anyone can check the transcription.
//
//   operator.mjs init <dir> <scenario>              prints the agent's workspace path
//   operator.mjs user <dir> <text> [--approves import|send] [--skips verify] [--pastes recipients] [--identifies maintainer|development]
//   operator.mjs claim <dir> <about> <json-data> --quote <agent's words>
//   operator.mjs restart <dir> <reason>
//   operator.mjs deliver <dir>                  the user sent the campaign from their own mail client
//   operator.mjs trace <dir> [--meta <json>]    assemble the gradeable trace on stdout

import { chmod, cp, mkdir, mkdtemp, readdir, realpath, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { scenarios } from './scenarios.mjs';
import { create, events, exclusive, load, record, save } from './session.mjs';
import { mailboxKey } from '../src/platform.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');
const { positionals, values } = parseArgs({ allowPositionals: true,
  options: { approves: { type: 'string' }, skips: { type: 'string' }, pastes: { type: 'string' }, identifies: { type: 'string' }, quote: { type: 'string' }, meta: { type: 'string' } } });
const [command, target, ...rest] = positionals;
if (!command || !target) { process.stderr.write('usage: operator.mjs init|user|claim|restart|trace <dir> …\n'); process.exit(2); }
const dir = resolve(target);

switch (command) {
  case 'init': {
    const scenario = scenarios[rest[0]];
    if (!scenario) throw new Error(`unknown scenario; choose one of ${Object.keys(scenarios).join(', ')}`);
    // A fresh directory only: re-recording over an old session would leave its CLI store and
    // working files behind, and mix them into the new trace.
    if ((await readdir(dir).catch(() => [])).length) throw new Error(`${dir} is not empty; record each run in a new directory`);
    // The session directory is named in the agent's tool wrappers, so it must not give the
    // scenario away.
    // Any word of the scenario's name gives it away: timeout-run, restart-1.
    const words = rest[0].toLowerCase().split('-').filter(w => w.length > 2);
    if (words.some(w => dir.toLowerCase().includes(w))) throw new Error('name the session directory neutrally; it must not contain any word of the scenario name');
    const workspace = await mkdtemp(join(await realpath(tmpdir()), 'placement-'));
    await create(dir, { name: rest[0], ...scenario }, workspace);
    await mkdir(join(workspace, 'bin'));
    await mkdir(join(workspace, 'work'));
    const tools = [['inboxally', 'inboxally.mjs'], ['esp', 'esp.mjs']].filter(([name]) => name !== 'inboxally' || scenario.cli !== false);
    for (const [name, script] of tools) {
      const path = join(workspace, 'bin', name);
      const quoted = value => `'${value.replaceAll("'", "'\\''")}'`;
      await writeFile(path, `#!/bin/sh\nEVAL_SESSION=${quoted(dir)} exec node ${quoted(join(here, script))} "$@"\n`);
      await chmod(path, 0o755);
      await writeFile(`${path}.cmd`, `@set "EVAL_SESSION=${dir}"\r\n@node "${join(here, script)}" %*\r\n`);
    }
    // The agent reads its own copy of the skill, so nothing points it at the grader.
    await cp(join(repo, 'skills/inboxally-placement-test'), join(workspace, 'skill'), { recursive: true });
    // The agent is given this path, never the session directory.
    process.stdout.write(`${workspace}\n`);
    break;
  }
  case 'user': {
    if (values.approves !== undefined && !['import', 'send'].includes(values.approves)) throw new Error('--approves must be import or send');
    if (values.skips !== undefined && values.skips !== 'verify') throw new Error('--skips must be verify');
    if (values.pastes !== undefined && values.pastes !== 'recipients') throw new Error('--pastes must be recipients');
    if (values.identifies !== undefined && !['maintainer', 'development'].includes(values.identifies)) throw new Error('--identifies must be maintainer or development');
    await record(dir, { kind: 'user', text: rest.join(' '), ...(values.approves ? { approves: values.approves } : {}), ...(values.skips ? { skips: values.skips } : {}), ...(values.pastes ? { pastes: values.pastes } : {}), ...(values.identifies ? { identifies: values.identifies } : {}) });
    break;
  }
  case 'claim': {
    if (!values.quote) throw new Error('a claim needs --quote with the agent\'s own words');
    await record(dir, { kind: 'claim', about: rest[0], data: JSON.parse(rest[1]), quote: values.quote });
    break;
  }
  case 'restart': await record(dir, { kind: 'restart', reason: rest.join(' ') || 'context_loss' }); break;
  case 'deliver': {
    // The user pressed Send in their own client with the latest test's 16 addresses in BCC: the
    // service sees every one of them. The send goes in the trace as the user's, so the approval
    // rules judge it like any other send: an agent that told the user to send early is caught.
    const sent = await exclusive(dir, async () => {
      const session = await load(dir);
      const test = session.service.tests.at(-1);
      if (!test) throw new Error('no test has been created');
      test.sent = true;
      test.sent_at ??= new Date().toISOString();
      test.delivered = test.test.recipients.map(r => mailboxKey(r.email));
      await save(dir, session);
      return { list: test.test.list_name, from: session.scenario.sender };
    });
    await record(dir, { kind: 'platform', op: 'send_campaign', by: 'user', args: { name: sent.list, from: sent.from }, outcome: 'ok' });
    break;
  }
  case 'trace': {
    const session = await load(dir);
    const test = session.service.tests[0]?.test;
    const context = {
      kind: 'context', mode: session.scenario.cli === false ? 'api' : 'cli', domain: session.scenario.sender.split('@')[1], sender: session.scenario.sender,
      list_name: test?.list_name ?? 'none allocated', test_code: test?.test_id ?? 'none allocated',
      scenario: session.scenario.name, ...(values.meta ? { meta: JSON.parse(values.meta) } : {}),
    };
    // Traces are committed, so machine paths are replaced. Known roots go first, matched exactly
    // as they appear inside JSON (Windows backslashes doubled), so a name with spaces is still
    // caught; any other absolute path then keeps only its file name.
    const roots = [[dir, '<session>'], ...(session.workspace ? [[session.workspace, '<workspace>']] : []), [repo, '<repo>'], [await realpath(tmpdir()), '<tmp>'], [tmpdir(), '<tmp>'], [homedir(), '<home>']]
      .map(([path, label]) => [JSON.stringify(path).slice(1, -1), label])
      .sort((a, b) => b[0].length - a[0].length);
    const scrub = line => roots.reduce((text, [path, label]) => text.split(path).join(label), line)
      .replace(/\/(?:Users|home|private|tmp|var|Volumes|opt|root)\/[^"\s]*\/([^"\s/]+)/g, '<elsewhere>/$1')
      .replace(/[A-Za-z]:(?:\\\\[^"\\\s]+)*\\\\([^"\\\s]+)/g, '<elsewhere>/$1')
      .replace(/\/(?:Users|home)\/[^"\s/]+/g, '<home>');
    process.stdout.write([context, ...await events(dir)].map(e => scrub(JSON.stringify(e))).join('\n') + '\n');
    break;
  }
  default: throw new Error(`unknown command ${command}`);
}
