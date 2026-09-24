import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../dist/cli.js';
import { Placement } from '../dist/placement.js';
import { StateStore } from '../dist/state.js';
import { JOURNAL_LIMIT } from '../dist/journal.js';
import { fixtureServer } from './support/server.mjs';
import { manifest } from './support/fixtures.mjs';

async function setup(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'inboxally-journal-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const server = await fixtureServer(options);
  t.after(server.close);
  const store = new StateStore(join(root, 'runs'), 'mock');
  const placement = new Placement(store, server.api);
  const intent = await placement.prepare('newsletter@example.com', 'mailchimp', 'Campaign');
  const run = await placement.create({ request: intent.local_request_id });
  const reopen = () => new Placement(new StateStore(join(root, 'runs'), 'mock'), server.api);
  const invoke = async (args, target = placement) => {
    let stdout = '', stderr = '';
    const code = await runCli(args, { placement: target, env: {}, stdout: s => { stdout += s; }, stderr: s => { stderr += s; } });
    return { code, stdout, stderr, json: stdout ? JSON.parse(stdout) : null };
  };
  let files = 0;
  const detailsFile = async details => {
    const path = join(root, `details-${files++}.json`);
    await writeFile(path, typeof details === 'string' ? details : JSON.stringify(details));
    return path;
  };
  const note = async (event, details = {}, evidence = 'tool_observed', target = placement) =>
    invoke(['placement', 'note', run.test.test_id, '--event', event, '--evidence', evidence, '--details-file', await detailsFile(details), '--json'], target);
  const state = async (target = placement) => (await invoke(['placement', 'runs', '--json'], target)).json.data.runs[0].state;
  return { root, server, store, placement, run, id: run.test.test_id, reopen, invoke, note, detailsFile, state };
}

test('notes record CLI-timestamped entries, drive recovery states, and survive restarts without touching the API', async t => {
  const { server, run, note, state, reopen } = await setup(t);
  const before = Date.now();
  assert.equal(await state(), 'allocated');
  const first = await note('awaiting_import_approval', { platform: 'mailchimp', workspace_label: 'SYNTHETIC workspace' });
  assert.equal(first.code, 0);
  assert.equal(first.stdout.trim().split('\n').length, 1);
  const entry = first.json.data.entry;
  assert.deepEqual(Object.keys(entry).sort(), ['details', 'event', 'evidence', 'recorded_at', 'sequence', 'state']);
  assert.equal(entry.sequence, 1);
  assert.ok(Date.parse(entry.recorded_at) >= before - 1000 && Date.parse(entry.recorded_at) <= Date.now() + 1000);
  assert.equal(entry.state, 'awaiting_import_approval');
  assert.equal(await state(), 'awaiting_import_approval');

  // An approval is an observation that the platform action may now happen; recovery must inspect first.
  const approved = await note('import_approved', { list_name: run.test.list_name, recipient_count: 16 }, 'user_reported');
  assert.equal(approved.json.data.entry.state, 'import_outcome_unknown');
  assert.equal(approved.json.data.entry.evidence, 'user_reported');
  const restarted = reopen();
  assert.equal(await state(restarted), 'import_outcome_unknown');

  assert.equal((await note('import_verified', { esp_object_id: 'list_123', recipient_count: 16 }, 'tool_observed', restarted)).json.data.entry.sequence, 3);
  assert.equal((await note('awaiting_send_approval', {}, 'tool_observed', restarted)).json.data.entry.state, 'awaiting_send_approval');
  const send = await note('send_approved', { from: 'newsletter@example.com', subject: 'SYNTHETIC subject', list_name: run.test.list_name, recipient_count: 16 }, 'user_reported', restarted);
  assert.equal(send.json.data.entry.state, 'send_outcome_unknown');
  assert.equal(await state(reopen()), 'send_outcome_unknown');
  assert.equal((await note('send_confirmed', { esp_object_id: 'campaign_9', observed_at: new Date().toISOString() }, 'tool_observed', reopen())).json.data.entry.state, 'send_confirmed');
  assert.equal((await note('done', { note: 'Explained results; list left in place.' }, 'tool_observed', reopen())).json.data.entry.sequence, 7);
  assert.equal(await state(reopen()), 'done');
  assert.deepEqual(server.metrics, { requests: 1, allocations: 1, charges: 1, reads: 0 });
});

test('runs shows how the audience check was evidenced, so a restart cannot call a skipped check verified', async t => {
  const { run, note, invoke } = await setup(t);
  const evidence = async () => (await invoke(['placement', 'runs', '--json'])).json.data.runs[0].import_evidence;
  assert.equal(await evidence(), null);
  await note('awaiting_import_approval', { platform: 'google-workspace' });
  await note('import_approved', { list_name: run.test.list_name, recipient_count: 16 }, 'user_reported');
  await note('import_verified', { recipient_count: 16, note: 'User skipped pasting the recipient field; not compared.' }, 'user_reported');
  assert.equal(await evidence(), 'user_reported');
  // A later comparison supersedes the skip.
  await note('import_verified', { recipient_count: 16 }, 'tool_observed');
  assert.equal(await evidence(), 'tool_observed');
});

test('a send recorded with no send approval before it is flagged, in the note and in runs', async t => {
  const { run, note, invoke } = await setup(t);
  await note('awaiting_import_approval', { platform: 'google-workspace' });
  const sent = await note('send_confirmed', { observed_at: new Date().toISOString(), note: 'User sent before approving.' }, 'user_reported');
  assert.equal(sent.code, 0);
  assert.equal(sent.json.data.sent_without_approval, true);
  assert.equal((await invoke(['placement', 'runs', '--json'])).json.data.runs[0].sent_without_approval, true);
  void run;
});

test('an approved send is not flagged', async t => {
  const { run, note, invoke } = await setup(t);
  await note('awaiting_send_approval', {});
  await note('send_approved', { from: 'newsletter@example.com', subject: 'SYNTHETIC subject', list_name: run.test.list_name, recipient_count: 16 }, 'user_reported');
  const sent = await note('send_confirmed', { observed_at: new Date().toISOString() }, 'user_reported');
  assert.equal(sent.json.data.sent_without_approval, undefined);
  assert.equal((await invoke(['placement', 'runs', '--json'])).json.data.runs[0].sent_without_approval, false);
  // A second send needs its own approval; the first one's does not cover it.
  const again = await note('send_confirmed', { observed_at: new Date().toISOString(), note: 'Sent again.' }, 'user_reported');
  assert.equal(again.json.data.sent_without_approval, true);
  assert.equal((await invoke(['placement', 'runs', '--json'])).json.data.runs[0].sent_without_approval, true);
});

test('journal rejects unknown events, evidence, keys, types, control characters, oversized and malformed input', async t => {
  const { note, invoke, id, detailsFile, store, run, state } = await setup(t);
  const cases = [
    { args: ['--event', 'allocated'], code: 2, error: 'INVALID_ARGUMENTS' },
    { args: ['--event', 'send_email'], code: 2, error: 'INVALID_ARGUMENTS' },
    { args: ['--event', 'stopped', '--evidence', 'assumed'], code: 2, error: 'INVALID_ARGUMENTS' },
    { details: { api_key: 'SECRET_SENTINEL' }, code: 2, error: 'INVALID_NOTE_DETAILS' },
    { details: { note: 'x', password: 'SECRET_SENTINEL' }, code: 2, error: 'INVALID_NOTE_DETAILS' },
    { details: { body: 'Dear customer, campaign body' }, code: 2, error: 'INVALID_NOTE_DETAILS' },
    { details: { recipient_count: '16' }, code: 2, error: 'INVALID_NOTE_DETAILS' },
    { details: { from: 'not-a-mailbox' }, code: 2, error: 'INVALID_NOTE_DETAILS' },
    { details: { platform: 'unknown-esp' }, code: 2, error: 'INVALID_NOTE_DETAILS' },
    { details: { observed_at: 'yesterday' }, code: 2, error: 'INVALID_NOTE_DETAILS' },
    { details: { note: 'unsafe' + String.fromCharCode(0x1b) + '[31m' }, code: 2, error: 'INVALID_NOTE_DETAILS' },
    { details: { note: 'x'.repeat(1001) }, code: 2, error: 'INVALID_NOTE_DETAILS' },
    { details: JSON.stringify({ note: 'x'.repeat(20000) }), code: 2, error: 'INVALID_NOTE_DETAILS' },
    { details: '{broken', code: 2, error: 'INVALID_NOTE_DETAILS' },
    { details: '[]', code: 2, error: 'INVALID_NOTE_DETAILS' },
    { details: 'null', code: 2, error: 'INVALID_NOTE_DETAILS' },
  ];
  for (const c of cases) {
    const args = ['placement', 'note', id, '--event', 'stopped', '--evidence', 'tool_observed', ...(c.args ?? [])];
    const path = await detailsFile(c.details ?? {});
    const result = await invoke([...args, '--details-file', path, '--json']);
    assert.equal(result.code, c.code, JSON.stringify(c));
    assert.equal(result.json.error.code, c.error, JSON.stringify(c));
    assert.ok(!(result.stdout + result.stderr).includes('SECRET_SENTINEL'));
  }
  const missingFile = await invoke(['placement', 'note', id, '--event', 'stopped', '--evidence', 'tool_observed', '--details-file', join(store.root, 'absent.json'), '--json']);
  assert.equal(missingFile.code, 2);
  assert.equal(missingFile.json.error.code, 'INVALID_NOTE_DETAILS');
  assert.equal((await invoke(['placement', 'note', 'pt_unknown', '--event', 'stopped', '--evidence', 'tool_observed', '--details-file', await detailsFile({}), '--json'])).json.error.code, 'STATE_UNAVAILABLE');
  assert.equal((await invoke(['placement', 'note', id, '--event', 'stopped', '--evidence', 'tool_observed', '--json'])).json.error.code, 'INVALID_ARGUMENTS');
  const saved = await store.load(run.local_request_id);
  assert.deepEqual(saved.journal, []);
  assert.equal(await state(), 'allocated');
  assert.ok(!(await readFile(join(store.root, `${run.local_request_id}.json`), 'utf8')).includes('SECRET_SENTINEL'));
  assert.equal((await note('stopped', { note: 'Recorded after invalid attempts.' })).json.data.entry.sequence, 1);
});

test('approvals must name what was approved and must match the immutable test; other events may record a mismatch', async t => {
  const { note, run, state, store } = await setup(t);
  const incomplete = await note('send_approved', { from: 'newsletter@example.com' });
  assert.equal(incomplete.code, 2);
  assert.equal(incomplete.json.error.code, 'INVALID_NOTE_DETAILS');
  assert.match(incomplete.json.error.message, /subject, list_name, recipient_count/);
  const full = { from: 'newsletter@example.com', subject: 'Subject', list_name: run.test.list_name, recipient_count: 16 };
  for (const wrong of [
    { from: 'other-sender@example.com' },
    { list_name: run.test.list_name + ' (copy)' },
    { recipient_count: 17 },
    { platform: 'klaviyo' },
  ]) {
    const result = await note('send_approved', { ...full, ...wrong }, 'user_reported');
    assert.equal(result.code, 5, JSON.stringify(wrong));
    assert.equal(result.json.error.code, 'APPROVAL_MISMATCH');
  }
  assert.equal((await note('import_approved', { list_name: 'Production Newsletter', recipient_count: 16 })).json.error.code, 'APPROVAL_MISMATCH');
  assert.equal((await note('import_approved', { recipient_count: 16 })).json.error.code, 'INVALID_NOTE_DETAILS');
  assert.equal((await store.load(run.local_request_id)).journal.length, 0);
  assert.equal(await state(), 'allocated');
  // The observed sender at the send screen differs: record it and stop, rather than hide it.
  const observed = await note('stopped', { from: 'other-sender@example.com', note: 'Final send screen showed a different From address.' });
  assert.equal(observed.code, 0);
  assert.equal(await state(), 'stopped');
  // Domain comparison is case-insensitive; the local part must be preserved exactly.
  assert.equal((await note('send_approved', { ...full, from: 'Newsletter@EXAMPLE.com' }, 'user_reported')).json.error.code, 'APPROVAL_MISMATCH');
  assert.equal((await note('send_approved', { ...full, from: 'newsletter@EXAMPLE.com' }, 'user_reported')).code, 0);
});

test('send-oriented events respect the send window; outcome events remain recordable after it closes', async t => {
  const { note, run, id, store } = await setup(t);
  const closing = await manifest(Date.now() - 3600000 + 90000); // the send cutoff is 90 seconds away
  Object.assign(closing, { test_id: id, list_name: run.test.list_name });
  const saved = await store.load(run.local_request_id);
  saved.test = closing;
  await store.save(saved);
  const full = { from: 'newsletter@example.com', subject: 'Subject', list_name: run.test.list_name, recipient_count: 16 };
  const short = await note('send_approved', full, 'user_reported');
  assert.equal(short.code, 8);
  assert.equal(short.json.error.code, 'SEND_WINDOW_INSUFFICIENT');
  assert.equal((await note('awaiting_send_approval')).code, 0);
  const expired = await manifest(Date.now() - 10800000);
  Object.assign(expired, { test_id: id, list_name: run.test.list_name });
  const reloaded = await store.load(run.local_request_id);
  reloaded.test = expired;
  await store.save(reloaded);
  for (const event of ['awaiting_import_approval', 'awaiting_send_approval']) {
    const result = await note(event);
    assert.equal(result.code, 8, event);
    assert.equal(result.json.error.code, 'SEND_WINDOW_EXPIRED');
  }
  assert.equal((await note('import_approved', { list_name: run.test.list_name, recipient_count: 16 })).json.error.code, 'SEND_WINDOW_EXPIRED');
  assert.equal((await note('send_approved', full, 'user_reported')).json.error.code, 'SEND_WINDOW_EXPIRED');
  for (const event of ['send_outcome_unknown', 'send_confirmed', 'stopped']) assert.equal((await note(event)).code, 0, event);
  assert.equal((await store.load(run.local_request_id)).journal.length, 4);
});

test('older run files upgrade in memory to the current version; inconsistent files are rejected', async t => {
  const { store, run, note, state, reopen, placement } = await setup(t);
  const path = join(store.root, `${run.local_request_id}.json`);
  const current = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(current.local_schema_version, 7);
  // Version 6 predates a refused result's retry time; it upgrades unchanged.
  await writeFile(path, JSON.stringify({ ...current, local_schema_version: 6 }) + '\n');
  assert.deepEqual(await store.load(run.local_request_id), current);
  // Version 5 predates missing and unreachable seeds; with no snapshot it upgrades unchanged.
  await writeFile(path, JSON.stringify({ ...current, local_schema_version: 5 }) + '\n');
  assert.deepEqual(await store.load(run.local_request_id), current);
  // Version 3 predates recorded exports; version 2 predates service-minted identity and labels;
  // version 1 predates the journal.
  // Version 4 predates the runs seen: an upgrade seeds them from the saved identity.
  const { runs_seen: seenNow, ...v4 } = current;
  await writeFile(path, JSON.stringify({ ...v4, local_schema_version: 4 }) + '\n');
  const fromV4 = await store.load(run.local_request_id);
  assert.equal(fromV4.local_schema_version, 7);
  assert.deepEqual(fromV4.runs_seen, seenNow);
  const { exports: _exports, ...v3 } = v4;
  await writeFile(path, JSON.stringify({ ...v3, local_schema_version: 3 }) + '\n');
  const fromV3 = await store.load(run.local_request_id);
  assert.equal(fromV3.local_schema_version, 7);
  assert.deepEqual(fromV3.exports, []);
  assert.deepEqual(fromV3.remote, current.remote);
  const { journal: journalNow, remote, label: _label, superseded_by: _superseded, ...legacy } = v3;
  await writeFile(path, JSON.stringify({ ...legacy, journal: journalNow, local_schema_version: 2 }) + '\n');
  const upgraded = await store.load(run.local_request_id);
  assert.equal(upgraded.local_schema_version, 7);
  assert.equal(upgraded.remote, undefined);
  // With no remote identity, the saved test's own run still counts as seen.
  assert.deepEqual(upgraded.runs_seen, [upgraded.test.run_uuid]);
  await writeFile(path, JSON.stringify({ ...legacy, local_schema_version: 1 }) + '\n');
  const loaded = await store.load(run.local_request_id);
  assert.equal(loaded.local_schema_version, 7);
  assert.deepEqual(loaded.journal, []);
  assert.ok(remote.uuid && remote.test_code);
  assert.equal(await state(reopen()), 'allocated');
  assert.equal((await note('watching', {}, 'tool_observed', reopen())).code, 0);
  const rewritten = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(rewritten.local_schema_version, 7);
  assert.equal(rewritten.journal.length, 1);
  assert.equal(rewritten.state, 'watching');
  const entry = rewritten.journal[0];
  for (const corrupt of [
    r => { r.state = 'allocated'; },                                   // journal disagrees with state
    r => { r.journal = []; },                                          // workflow state without evidence
    r => { r.journal = [{ ...entry, sequence: 2 }]; },                 // sequence gap
    r => { r.journal = [{ ...entry, state: 'send_confirmed' }]; },     // entry state disagrees with run state
    r => { r.journal = [{ ...entry, details: { api_key: 'x' } }]; },   // unexpected persisted detail
    r => { r.state = 'send_confirmed'; delete r.test; },               // workflow state without allocation
    r => { r.local_schema_version = 8; },                              // unknown future version
    r => { r.runs_seen = ['not-a-uuid']; },                            // malformed run record
    r => { r.exports = [{ path: '/x', sha256: 'not-a-digest' }]; },    // malformed export record
  ]) {
    const broken = structuredClone(rewritten); corrupt(broken);
    await writeFile(path, JSON.stringify(broken) + '\n');
    await assert.rejects(store.load(run.local_request_id), { code: 'STATE_INVALID' });
    await assert.rejects(placement.create({ request: run.local_request_id }), { code: 'STATE_INVALID' });
  }
});

test('a full journal refuses further entries and preserves the run', async t => {
  const { store, run, note, state } = await setup(t);
  const saved = await store.load(run.local_request_id);
  const recorded_at = new Date().toISOString();
  saved.journal = Array.from({ length: JOURNAL_LIMIT }, (_, i) => ({ sequence: i + 1, recorded_at, event: 'watching', evidence: 'tool_observed', details: {}, state: 'watching' }));
  saved.state = 'watching';
  await store.save(saved);
  const result = await note('done');
  assert.equal(result.code, 2);
  assert.equal(result.json.error.code, 'JOURNAL_FULL');
  assert.equal((await store.load(run.local_request_id)).journal.length, JOURNAL_LIMIT);
  assert.equal(await state(), 'watching');
});
