import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Placement, unavailableApi } from '../dist/placement.js';
import { StateStore } from '../dist/state.js';
import { fixtureServer } from './support/server.mjs';
import { manifest, resultSnapshot } from './support/fixtures.mjs';

async function setup(t, options) {
  const root = await mkdtemp(join(tmpdir(), 'inboxally-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const server = await fixtureServer(options);
  t.after(server.close);
  const store = new StateStore(root, 'mock');
  return { root, server, store, placement: new Placement(store, server.api) };
}

test('a lost allocation response leaves one named test, and the unnamed one is never adopted', async t => {
  const { root, placement, server } = await setup(t, { loseFirstResponse: true, allowance: 2 });
  const run = await placement.prepare('newsletter@example.com', 'mailchimp', 'Real campaign reference stays local');
  await assert.rejects(placement.create({ request: run.local_request_id }), { code: 'ALLOCATION_UNKNOWN' });
  const restarted = new Placement(new StateStore(root, 'mock'), server.api);
  assert.equal((await restarted.store.load(run.local_request_id)).state, 'allocation_unknown');
  // Creation reserves nothing, so the safe recovery is to create again. The unnamed test is
  // never adopted on a guess, and it costs the user nothing.
  const created = await restarted.create({ request: run.local_request_id });
  assert.equal(created.state, 'allocated');
  assert.equal(created.remote.uuid, created.test.run_uuid);
  assert.equal(created.remote.test_code, created.test.test_id);
  // Identity is persisted, so a second call returns the same run rather than allocating again.
  assert.equal((await restarted.create({ request: run.local_request_id })).remote.uuid, created.remote.uuid);
  assert.equal((await restarted.store.runs()).length, 1);
  assert.equal(server.metrics.requests, 2);
  const saved = await readFile(join(root, `${run.local_request_id}.json`), 'utf8');
  assert.ok(!saved.includes('FIXTURE_ONLY_NOT_A_CREDENTIAL'));
});

test('two local callers cannot allocate twice; loser can resume', async t => {
  const { placement, server, root } = await setup(t);
  const run = await placement.prepare('newsletter@example.com', 'mailchimp', 'Campaign');
  const second = new Placement(new StateStore(root, 'mock'), server.api);
  const outcomes = await Promise.allSettled([placement.create({ request: run.local_request_id }), second.create({ request: run.local_request_id })]);
  assert.ok(outcomes.some(o => o.status === 'fulfilled'));
  for (const o of outcomes) if (o.status === 'rejected') assert.equal(o.reason.code, 'REQUEST_BUSY');
  assert.equal((await second.create({ request: run.local_request_id })).state, 'allocated');
  assert.equal(server.metrics.allocations, 1);
});

test('malformed allocation preserves identity and never prepares replacement', async t => {
  const { store } = await setup(t);
  let calls = 0;
  const api = { environment: 'mock', reportOrigins: ['https://reports.example.com'], assertAvailable() {},
    async create() { calls++; const m = await manifest(); m.recipients.pop(); return m; } };
  const placement = new Placement(store, api);
  const run = await placement.prepare('newsletter@example.com', 'mailchimp', 'Campaign');
  await assert.rejects(placement.create({ request: run.local_request_id }), { code: 'INVALID_MANIFEST' });
  assert.equal((await store.load(run.local_request_id)).state, 'allocation_unknown');
  assert.equal(calls, 1);
  assert.equal((await store.runs()).length, 1);
});

test('corrupt state stops before the network; unavailable live adapter leaves intent prepared', async t => {
  const { placement, root, server } = await setup(t);
  const run = await placement.prepare('newsletter@example.com', 'mailchimp', 'Campaign');
  await writeFile(join(root, `${run.local_request_id}.json`), '{broken');
  await assert.rejects(placement.create({ request: run.local_request_id }), { code: 'STATE_INVALID' });
  assert.equal(server.metrics.requests, 0);
  const live = new Placement(new StateStore(join(root, 'production'), 'production'), unavailableApi);
  const intent = await live.prepare('newsletter@example.com', 'mailchimp', 'Campaign');
  await assert.rejects(live.create({ request: intent.local_request_id }), { code: 'INTEGRATION_NOT_CONFIGURED' });
  assert.equal((await live.store.load(intent.local_request_id)).state, 'prepared');
});

test('a domain keeps one live address list unless a second is asked for explicitly', async t => {
  const { placement, server, store } = await setup(t, { allowance: 3 });
  const first = await placement.prepare('newsletter@example.com', 'mailchimp', 'Campaign', 'acme-newsletter');
  await placement.create({ request: first.local_request_id });
  // A second intent for the same sending domain stops: two live lists means a campaign can
  // reach a test nobody is watching.
  const second = await placement.prepare('offers@example.com', 'mailchimp', 'Another campaign');
  await assert.rejects(placement.create({ request: second.local_request_id }), { code: 'DOMAIN_RUN_ACTIVE', exitCode: 5 });
  assert.equal(server.metrics.allocations, 1);
  assert.equal((await store.load(second.local_request_id)).state, 'prepared');
  // Explicit consent allocates, and the domain then selects ambiguously rather than guessing.
  const allowed = await placement.create({ request: second.local_request_id }, true);
  assert.equal(allowed.state, 'allocated');
  await assert.rejects(placement.select({ domain: 'example.com' }), { code: 'AMBIGUOUS_SELECTION' });
  // A label and a test code stay unambiguous handles.
  assert.equal((await placement.select({ label: 'acme-newsletter' })).local_request_id, first.local_request_id);
  assert.equal((await placement.select({ test: allowed.remote.test_code })).local_request_id, second.local_request_id);
});

test('selection refuses to guess and requires exactly one handle', async t => {
  const { placement } = await setup(t);
  const run = await placement.prepare('newsletter@example.com', 'mailchimp', 'Campaign', 'acme');
  await assert.rejects(placement.select({}), { code: 'INVALID_ARGUMENTS' });
  await assert.rejects(placement.select({ domain: 'example.com', label: 'acme' }), { code: 'INVALID_ARGUMENTS' });
  await assert.rejects(placement.select({ test: 'pt_absent' }), { code: 'STATE_UNAVAILABLE' });
  assert.equal((await placement.select({ domain: 'EXAMPLE.com' })).local_request_id, run.local_request_id);
});


test('a run created without this client is imported by its test code, or not saved at all', async t => {
  const { placement, server, store } = await setup(t, { allowance: 2 });
  // A skill-only session creates the test directly against the service.
  const created = await server.api.create({ expected_from: 'newsletter@example.com', sending_platform: 'mailchimp' });
  const body = { from: 'newsletter@example.com', platform: 'mailchimp', campaign: 'Campaign', label: 'imported' };
  // A wrong run UUID is refused, and nothing is written: the local store stays empty.
  await assert.rejects(placement.adopt(created.test_id, { ...body, uuid: '0199a1d2-7c30-7a1e-8f6b-000000000000' }),
    { code: 'RUN_IDENTITY_MISMATCH', exitCode: 5 });
  assert.equal((await store.runs()).length, 0);
  const imported = await placement.adopt(created.test_id, { ...body, uuid: created.run_uuid });
  assert.equal(imported.state, 'allocated');
  assert.equal(imported.remote.uuid, created.run_uuid);
  assert.equal(imported.remote.test_code, created.test_id);
  assert.equal(imported.label, 'imported');
  // Importing it twice would give one run two local records, each with its own journal.
  await assert.rejects(placement.adopt(created.test_id, body), { code: 'RUN_ALREADY_SAVED' });
  assert.equal((await store.runs()).length, 1);
});

test('a read that resolves to a later run is recorded rather than presented as the approved send', async t => {
  const { store } = await setup(t);
  const allocated = await manifest();
  allocated.run_uuid = '0199a1d2-7c30-7a1e-8f6b-5f0c1d2e3a40';
  // The service resolves a test code to its most recent run; a second delivery starts one.
  const later = resultSnapshot({ ...allocated, run_uuid: '0199a1d2-7c30-7a1e-8f6b-aaaaaaaaaaaa' }, 'complete');
  const api = { environment: 'mock', reportOrigins: ['https://reports.example.com'], assertAvailable() {},
    async create() { return allocated; }, async get() { return later; } };
  const placement = new Placement(store, api);
  const intent = await placement.prepare('newsletter@example.com', 'mailchimp', 'Campaign');
  const run = await placement.create({ request: intent.local_request_id });
  assert.equal(run.remote.uuid, allocated.run_uuid);
  const snapshot = await placement.status({ request: intent.local_request_id });
  assert.equal(snapshot.status, 'complete');
  const saved = await store.load(intent.local_request_id);
  // The numbers are kept, because they are the user's latest measurement; the record says they
  // belong to a different send, so the skill reports them as one.
  assert.equal(saved.superseded_by.uuid, '0199a1d2-7c30-7a1e-8f6b-aaaaaaaaaaaa');
  assert.equal(saved.remote.uuid, allocated.run_uuid);
  assert.equal(saved.snapshot.status, 'complete');
});

// Decision 0004: creation spends nothing, and the free limit is applied when the campaign
// arrives. The synthetic service used to report the day's test as spent at creation, and every
// agent in the first recorded runs repeated that to the user.
test('creating a test leaves the day\'s free test unspent until the campaign arrives', async t => {
  const { placement } = await setup(t, { stages: ['awaiting', 'partial'], allowance: 2 });
  const intent = await placement.prepare('newsletter@example.com', 'mailchimp', 'Campaign');
  const run = await placement.create({ request: intent.local_request_id });
  assert.deepEqual([run.test.quota.limit, run.test.quota.remaining], [1, 1]);
  assert.equal((await placement.status({ request: intent.local_request_id })).quota.remaining, 1);
  const arrived = await placement.status({ request: intent.local_request_id });
  assert.ok(arrived.received_count > 0);
  assert.equal(arrived.quota.remaining, 0);
  // The service remembers the spend: a second test for the domain the same day says so.
  const second = await placement.prepare('offers@example.com', 'mailchimp', 'Another campaign');
  const again = await placement.create({ request: second.local_request_id }, true, undefined, true);
  assert.equal(again.test.quota.remaining, 0);
});

// Each minted test gets its own report link. The fixture service once handed every test the
// example manifest's link, and agents in the first recorded runs quoted it for a different test.
test('each allocated test links to its own report', async t => {
  const { placement } = await setup(t, { allowance: 2 });
  const tests = [];
  for (const from of ['newsletter@example.com', 'offers@example.net']) {
    const intent = await placement.prepare(from, 'mailchimp', 'Campaign');
    tests.push((await placement.create({ request: intent.local_request_id })).test);
  }
  for (const test of tests) assert.equal(new URL(test.report_url).pathname, `/placement/${test.test_id}`);
  assert.notEqual(tests[0].report_url, tests[1].report_url);
});

// A refusal is when a user sends again, and the next read resolves to the new run. It must not be
// judged against the refusal it follows.
test('a later run after a saved refusal is read, and recorded as a different send', async t => {
  const { store } = await setup(t);
  const allocated = await manifest();
  allocated.run_uuid = '0199a1d2-7c30-7a1e-8f6b-5f0c1d2e3a40';
  const refused = resultSnapshot(allocated, 'rate_limited');
  const later = resultSnapshot({ ...allocated, run_uuid: '0199a1d2-7c30-7a1e-8f6b-bbbbbbbbbbbb' }, 'complete');
  let reads = 0;
  const api = { environment: 'mock', reportOrigins: ['https://reports.example.com'], assertAvailable() {},
    async create() { return allocated; }, async get() { return reads++ === 0 ? refused : later; } };
  const placement = new Placement(store, api);
  const intent = await placement.prepare('newsletter@example.com', 'mailchimp', 'Campaign');
  await placement.create({ request: intent.local_request_id });
  assert.equal((await placement.status({ request: intent.local_request_id })).status, 'rate_limited');
  const next = await placement.status({ request: intent.local_request_id });
  assert.equal(next.status, 'complete');
  const saved = await store.load(intent.local_request_id);
  assert.equal(saved.superseded_by.uuid, '0199a1d2-7c30-7a1e-8f6b-bbbbbbbbbbbb');
});

test('a read that goes back to an earlier run after a later one is refused', async t => {
  const { store } = await setup(t);
  const allocated = await manifest();
  allocated.run_uuid = '0199a1d2-7c30-7a1e-8f6b-5f0c1d2e3a40';
  const later = resultSnapshot({ ...allocated, run_uuid: '0199a1d2-7c30-7a1e-8f6b-cccccccccccc' }, 'complete');
  const back = resultSnapshot(allocated, 'complete');
  let reads = 0;
  const api = { environment: 'mock', reportOrigins: ['https://reports.example.com'], assertAvailable() {},
    async create() { return allocated; }, async get() { return reads++ === 0 ? later : back; } };
  const placement = new Placement(store, api);
  const intent = await placement.prepare('newsletter@example.com', 'mailchimp', 'Campaign');
  await placement.create({ request: intent.local_request_id });
  await placement.status({ request: intent.local_request_id });
  await assert.rejects(placement.status({ request: intent.local_request_id }), { code: 'INVALID_RESULTS' });
  const saved = await store.load(intent.local_request_id);
  assert.equal(saved.snapshot.run_uuid, '0199a1d2-7c30-7a1e-8f6b-cccccccccccc');
});

test('a read that returns to an intermediate run is refused as well', async t => {
  const { store } = await setup(t);
  const allocated = await manifest();
  allocated.run_uuid = '0199a1d2-7c30-7a1e-8f6b-5f0c1d2e3a40';
  const b = resultSnapshot({ ...allocated, run_uuid: '0199a1d2-7c30-7a1e-8f6b-bbbbbbbbbbbb' }, 'complete');
  const c = resultSnapshot({ ...allocated, run_uuid: '0199a1d2-7c30-7a1e-8f6b-cccccccccccc' }, 'complete');
  // B read again later, with a newer timestamp: timestamps cannot order runs.
  const bAgain = { ...b, updated_at: new Date(Date.parse(c.updated_at) + 60000).toISOString() };
  const reads = [b, c, bAgain];
  const api = { environment: 'mock', reportOrigins: ['https://reports.example.com'], assertAvailable() {},
    async create() { return allocated; }, async get() { return reads.shift(); } };
  const placement = new Placement(store, api);
  const intent = await placement.prepare('newsletter@example.com', 'mailchimp', 'Campaign');
  await placement.create({ request: intent.local_request_id });
  await placement.status({ request: intent.local_request_id });
  await placement.status({ request: intent.local_request_id });
  await assert.rejects(placement.status({ request: intent.local_request_id }), { code: 'INVALID_RESULTS' });
  const saved = await store.load(intent.local_request_id);
  assert.equal(saved.snapshot.run_uuid, '0199a1d2-7c30-7a1e-8f6b-cccccccccccc');
  assert.deepEqual(saved.runs_seen, ['0199a1d2-7c30-7a1e-8f6b-5f0c1d2e3a40', '0199a1d2-7c30-7a1e-8f6b-bbbbbbbbbbbb', '0199a1d2-7c30-7a1e-8f6b-cccccccccccc']);
});
