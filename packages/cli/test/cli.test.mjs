import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink, writeFile, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runCli } from '../dist/cli.js';
import { Placement } from '../dist/placement.js';
import { StateStore } from '../dist/state.js';
import { fixtureServer } from './support/server.mjs';

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'inboxally-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const server = await fixtureServer(); t.after(server.close);
  const placement = new Placement(new StateStore(join(root, 'runs'), 'mock'), server.api);
  const invoke = async (args, env = {}) => {
    let stdout = '', stderr = '';
    const code = await runCli(args, { placement, env, stdout: s => { stdout += s; }, stderr: s => { stderr += s; } });
    return { code, stdout, stderr };
  };
  return { root, placement, invoke, server };
}

test('help, version, doctor and runs do not allocate or create state', async t => {
  const { root, invoke, server } = await setup(t);
  assert.equal((await invoke(['--help'])).code, 0);
  assert.equal((await invoke(['--version'])).code, 0);
  const doctor = await invoke(['doctor', '--json']);
  assert.equal(doctor.code, 6);
  assert.equal(JSON.parse(doctor.stdout).error.code, 'INTEGRATION_NOT_CONFIGURED');
  assert.equal((await invoke(['placement', 'runs', '--json'])).code, 0);
  assert.equal(server.metrics.requests, 0);
  assert.deepEqual(await readdir(root), []);
});

test('env key does not silently fall back; explicit anonymous is intentional', async t => {
  const { invoke } = await setup(t);
  const args = ['placement', 'prepare', '--from', 'newsletter@example.com', '--platform', 'mailchimp', '--campaign', 'Campaign', '--json'];
  const env = { INBOXALLY_API_KEY: 'DO_NOT_LEAK_SENTINEL' };
  const failure = await invoke(args, env);
  assert.equal(failure.code, 3);
  assert.ok(!(failure.stdout + failure.stderr).includes(env.INBOXALLY_API_KEY));
  assert.equal((await invoke([...args, '--anonymous'], env)).code, 0);
});

test('JSON output is a single object; mismatch retains data; exports refuse overwrite', async t => {
  const { invoke, placement, root } = await setup(t);
  const run = await placement.prepare('newsletter@example.com', 'mailchimp', 'Campaign');
  const created = await invoke(['placement', 'create', '--request', run.local_request_id, '--json']);
  assert.equal(created.code, 0);
  assert.equal(created.stdout.trim().split('\n').length, 1);
  const test = JSON.parse(created.stdout).data.test;
  assert.deepEqual(test.access, { mode: 'anonymous' });
  const file = join(root, 'recipients.csv');
  const args = ['placement', 'recipients', test.test_id, '--format', 'csv', '--output', file];
  assert.equal((await invoke(args)).stdout, '');
  const original = await readFile(file, 'utf8');
  assert.equal((await invoke(args)).code, 2);
  assert.equal(await readFile(file, 'utf8'), original);
  await writeFile(file, 'email\nwrong@example.com\n');
  const mismatch = await invoke(['placement', 'verify', test.test_id, '--recipients-file', file, '--json']);
  assert.equal(mismatch.code, 5);
  assert.equal(JSON.parse(mismatch.stdout).data.matches, false);
  assert.equal((await invoke([...args, '--overwrite'])).code, 0);
});

// Found by recorded agent runs: agents verified the CLI's own export against the test, which
// always matches, and one then sent to a list missing an address.
test('verify refuses the CLI\'s own unchanged export, but not the platform\'s members', async t => {
  const { invoke, placement, root } = await setup(t);
  const run = await placement.prepare('newsletter@example.com', 'mailchimp', 'Campaign');
  const test = JSON.parse((await invoke(['placement', 'create', '--request', run.local_request_id, '--json'])).stdout).data.test;
  const exported = join(root, 'recipients.txt');
  await invoke(['placement', 'recipients', test.test_id, '--format', 'text', '--output', exported]);
  const self = await invoke(['placement', 'verify', test.test_id, '--recipients-file', exported, '--json']);
  assert.equal(self.code, 5);
  assert.equal(JSON.parse(self.stdout).error.code, 'VERIFY_SELF_COMPARISON');
  // The same addresses taken from the platform, written elsewhere, are evidence and pass.
  const members = join(root, 'members.txt');
  await writeFile(members, await readFile(exported, 'utf8'));
  assert.equal((await invoke(['placement', 'verify', test.test_id, '--recipients-file', members, '--json'])).code, 0);
  // So does the export path once the platform's members have been written over it.
  await writeFile(exported, (await readFile(exported, 'utf8')).split('\n').reverse().join('\n'));
  assert.equal((await invoke(['placement', 'verify', test.test_id, '--recipients-file', exported, '--json'])).code, 0);

  // While another process holds the run, an export writes nothing, so it can never sit on disk
  // unrecorded, and a plain retry succeeds once the run is free.
  const later = join(root, 'later.txt');
  const lock = join(placement.store.root, `${run.local_request_id}.json.lock`);
  await writeFile(lock, '');
  const busy = await invoke(['placement', 'recipients', test.test_id, '--format', 'text', '--output', later]);
  assert.equal(busy.code, 2);
  await assert.rejects(readFile(later), { code: 'ENOENT' });
  await rm(lock);
  assert.equal((await invoke(['placement', 'recipients', test.test_id, '--format', 'text', '--output', later])).code, 0);
  assert.equal(JSON.parse((await invoke(['placement', 'verify', test.test_id, '--recipients-file', later, '--json'])).stdout).error.code, 'VERIFY_SELF_COMPARISON');

  // A failed export to the same path, in another format, does not erase the earlier record, and
  // costs none: the refusal comes before anything is recorded.
  const before = (await placement.store.load(run.local_request_id)).exports.length;
  const refused = await invoke(['placement', 'recipients', test.test_id, '--format', 'csv', '--output', later]);
  assert.equal(refused.code, 2);
  assert.equal(JSON.parse(refused.stderr).error.code, 'OUTPUT_EXISTS');
  assert.equal((await placement.store.load(run.local_request_id)).exports.length, before);
  assert.equal(JSON.parse((await invoke(['placement', 'verify', test.test_id, '--recipients-file', later, '--json'])).stdout).error.code, 'VERIFY_SELF_COMPARISON');

  // Overwritten under another letter case, the file keeps its stored name on a case-insensitive
  // filesystem, and the record must use that name, since verify resolves to it. On a
  // case-sensitive filesystem the two names are two files, and the first is still recognised.
  const lower = join(root, 'cased.txt');
  await invoke(['placement', 'recipients', test.test_id, '--format', 'text', '--output', lower]);
  assert.equal((await invoke(['placement', 'recipients', test.test_id, '--format', 'csv', '--output', join(root, 'CASED.txt'), '--overwrite'])).code, 0);
  assert.equal(JSON.parse((await invoke(['placement', 'verify', test.test_id, '--recipients-file', lower, '--json'])).stdout).error.code, 'VERIFY_SELF_COMPARISON');

  // An export through a symbolic link is refused, since its record could not name the real file.
  const target = join(root, 'real.txt');
  const link = join(root, 'link.txt');
  await writeFile(target, '');
  // Creating a symlink needs a privilege Windows runners may lack; the check then cannot run.
  const linked = await symlink(target, link).then(() => true, e => { if (e.code === 'EPERM') return false; throw e; });
  if (linked) {
    assert.equal((await invoke(['placement', 'recipients', test.test_id, '--format', 'text', '--output', link, '--overwrite'])).code, 2);
    assert.equal(await readFile(target, 'utf8'), '');
  }
});

test('a run refuses a new export rather than forget an old one', async t => {
  const { invoke, placement, root } = await setup(t);
  const run = await placement.prepare('newsletter@example.com', 'mailchimp', 'Campaign');
  const test = JSON.parse((await invoke(['placement', 'create', '--request', run.local_request_id, '--json'])).stdout).data.test;
  const first = join(root, 'export-0.txt');
  for (let i = 0; i < 64; i++) {
    assert.equal((await invoke(['placement', 'recipients', test.test_id, '--format', 'text', '--output', join(root, `export-${i}.txt`)])).code, 0);
  }
  const full = await invoke(['placement', 'recipients', test.test_id, '--format', 'text', '--output', join(root, 'export-64.txt')]);
  assert.equal(full.code, 2);
  await assert.rejects(readFile(join(root, 'export-64.txt')), { code: 'ENOENT' });
  // The first export is still recognised.
  assert.equal(JSON.parse((await invoke(['placement', 'verify', test.test_id, '--recipients-file', first, '--json'])).stdout).error.code, 'VERIFY_SELF_COMPARISON');
});

test('unknown flags and commands cannot enable API overrides or sending', async t => {
  const { invoke } = await setup(t);
  for (const args of [['doctor', '--api-url', 'https://bad.example'], ['placement', 'send', '--yes'], ['doctor', '--yes']]) {
    assert.equal((await invoke([...args, '--json'])).code, 2);
  }
});

test('INBOXALLY_LIVE decides live or offline only for recognised values, and refuses anything else', async () => {
  const { defaultContext } = await import('../dist/cli.js');
  const { HttpPlacementApi } = await import('../dist/http.js');
  const { unavailableApi } = await import('../dist/placement.js');
  const saved = process.env.INBOXALLY_LIVE;
  try {
    for (const [value, expect] of [[undefined, 'live'], ['1', 'live'], ['true', 'live'], ['0', 'off'], ['false', 'off'], ['off', 'off'], ['', 'refuse'], ['maybe', 'refuse']]) {
      if (value === undefined) delete process.env.INBOXALLY_LIVE; else process.env.INBOXALLY_LIVE = value;
      const api = defaultContext().placement.api;
      if (expect === 'live') assert.ok(api instanceof HttpPlacementApi, String(value));
      else if (expect === 'off') assert.equal(api, unavailableApi, String(value));
      else assert.throws(() => api.assertAvailable(), { code: 'INVALID_ENVIRONMENT' }, String(value));
    }
  } finally {
    if (saved === undefined) delete process.env.INBOXALLY_LIVE; else process.env.INBOXALLY_LIVE = saved;
  }
});

test('login says sign-in is not available yet, and touches nothing', async t => {
  const { root, invoke, server } = await setup(t);
  const result = await invoke(['login', '--json']);
  assert.equal(result.code, 6);
  const error = JSON.parse(result.stdout).error;
  assert.equal(error.code, 'LOGIN_UNAVAILABLE');
  assert.match(error.message, /free tier works without signing in/);
  assert.equal(server.metrics.requests, 0);
  assert.deepEqual(await readdir(root), []);
});
