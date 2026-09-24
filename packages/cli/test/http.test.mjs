import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HttpPlacementApi, REPORT_ORIGIN, SEND_DEADLINE_MINUTES, listName, toManifest } from '../dist/http.js';
import { validateResult } from '../dist/results.js';
import { Placement, unavailableApi } from '../dist/placement.js';
import { StateStore } from '../dist/state.js';
import { runCli } from '../dist/cli.js';
import { fakeService } from './support/service.mjs';

const ORIGIN = 'https://placement.example.test';
const FROM = 'news@harbor-goods.example.com';

async function setup(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'inboxally-http-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = fakeService(options);
  const sleeps = [];
  const api = new HttpPlacementApi(ORIGIN, service.fetch, options.sleep ?? (async ms => { sleeps.push(ms); }), options.localNow);
  const placement = new Placement(new StateStore(root, 'production'), api);
  const intent = await placement.prepare(FROM, 'mailchimp', 'Campaign');
  return { root, service, sleeps, api, placement, intent, select: { request: intent.local_request_id } };
}

// Placements for the fifteen seeds, in order: gmail 1-6, outlook 7-11, yahoo 12-15.
const allInbox = Array(15).fill('inbox');

test('create sends only the saved request id, and builds the test from the first read', async t => {
  const { service, placement, intent, select } = await setup(t);
  const run = await placement.create(select);
  const post = service.calls.find(c => c.method === 'POST');
  assert.deepEqual(JSON.parse(post.body), { uuid: intent.local_request_id });
  assert.equal(post.redirect, 'error');
  assert.equal(run.remote.uuid, intent.local_request_id);
  assert.equal(run.test.list_name, listName(run.test.test_id));
  assert.equal(run.test.recipients.length, 16);
  assert.deepEqual([...new Set(run.test.recipients.filter(r => r.role === 'placement').map(r => r.provider))], ['gmail', 'outlook', 'yahoo']);
  assert.equal(run.test.recipients.find(r => r.role === 'correlation').email, run.remote.email_address);
  // The app's guest report page, keyed by the test's own code and UUID.
  assert.equal(run.test.report_url, `https://app.inboxally.com/placement-report/${run.test.test_id}/${run.remote.uuid}`);
  assert.equal(run.test.quota, null);
  const window = Date.parse(run.test.send_before) - Date.parse(run.test.created_at);
  assert.ok(Math.abs(window - SEND_DEADLINE_MINUTES * 60000) < 5000, `send window ${window}ms`);
});

test('the send deadline is the service\'s own when it states one, and results are awaited past its measurement cap', async t => {
  const { service, placement, select } = await setup(t, { localNow: () => Date.now() + 300000 });
  service.controls.deadlines = true;
  const run = await placement.create(select);
  const created = Date.parse(run.test.created_at);
  assert.ok(Math.abs(Date.parse(run.test.send_before) - (created + 240 * 60000)) < 1000, run.test.send_before);
  assert.ok(Date.parse(run.test.results_deadline) >= Date.parse(run.test.send_before) + 60 * 60000);
  // A service that does not state them keeps the CLI's ten-minute rule.
  const old = await setup(t);
  const r2 = await old.placement.create(old.select);
  assert.equal(Date.parse(r2.test.send_before) - Date.parse(r2.test.created_at), SEND_DEADLINE_MINUTES * 60000);
  // After the campaign arrived, expiresAt is null and the stated wait gives the deadline, as on a replay.
  const probe = await setup(t);
  const made0 = await probe.placement.create(probe.select);
  const read = await (await probe.service.fetch(`${ORIGIN}/api/results/${made0.test.test_id}`)).json();
  const m = toManifest({ testCode: read.testCode, emailAddress: read.emailAddress, uuid: read.uuid, seedAddresses: read.seedAddresses, status: 'processing', expiresAt: null, sentinelWaitMinutes: 240, maxMeasurementMinutes: 60 },
    read, { expected_from: FROM, sending_platform: 'mailchimp' }, Date.now());
  assert.ok(Math.abs(Date.parse(m.send_before) - (Date.parse(m.created_at) + 240 * 60000)) < 1000);
  // A cap shorter than the stated window never shortens the wait for results.
  const short = toManifest({ testCode: read.testCode, emailAddress: read.emailAddress, uuid: read.uuid, seedAddresses: read.seedAddresses, status: 'pending', maxMeasurementMinutes: 1 },
    read, { expected_from: FROM, sending_platform: 'mailchimp' }, Date.now());
  assert.ok(Date.parse(short.results_deadline) >= Date.parse(short.send_before) + read.testWindowMinutes * 60000);
  // A run adopted from a read that states the deadlines gets the same ones.
  const adopted = await setup(t);
  adopted.service.controls.deadlines = true;
  const made = await adopted.placement.create(adopted.select);
  const other = new Placement(new StateStore(await mkdtemp(join(tmpdir(), 'inboxally-http-adopt-')), 'production'), adopted.api);
  const imported = await other.adopt(made.test.test_id, { from: FROM, platform: 'mailchimp', campaign: 'Campaign' });
  assert.ok(Math.abs(Date.parse(imported.test.send_before) - Date.parse(made.test.send_before)) < 5000);
});

test('the send deadline follows the service clock, not a skewed local one', async t => {
  // The local clock runs five minutes ahead of the service's.
  const { placement, select } = await setup(t, { localNow: () => Date.now() + 300000 });
  const run = await placement.create(select);
  const deadline = Date.parse(run.test.send_before);
  assert.ok(Math.abs(deadline - (Date.now() + 300000 + SEND_DEADLINE_MINUTES * 60000)) < 5000);
});

test('a slow first read makes the send deadline earlier than the service\'s, never later', async t => {
  let clock = Date.now();
  const service = fakeService({ now: () => clock });
  // The response is stamped, then takes 15 seconds to arrive.
  const slow = async (url, init) => { const response = await service.fetch(url, init); if (url.includes('/api/results/')) clock += 15000; return response; };
  const root = await mkdtemp(join(tmpdir(), 'inboxally-http-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const placement = new Placement(new StateStore(root, 'production'), new HttpPlacementApi(ORIGIN, slow, async () => {}, () => clock));
  const intent = await placement.prepare(FROM, 'mailchimp', 'Campaign');
  const run = await placement.create({ request: intent.local_request_id });
  const serviceDeadline = Date.parse(service.tests.get(run.remote.uuid).createdAt) + SEND_DEADLINE_MINUTES * 60000;
  assert.ok(Date.parse(run.test.send_before) <= serviceDeadline, `${run.test.send_before} is after the service's deadline`);
});

test('a run saved with live transport still works offline when live is off', async t => {
  const { root, placement, select } = await setup(t);
  await placement.create(select);
  const offline = new Placement(new StateStore(root, 'production'), unavailableApi);
  let out = '';
  const code = await runCli(['placement', 'recipients', '--request', select.request, '--format', 'json'], { placement: offline, env: {}, stdout: s => { out += s; }, stderr: () => {} });
  assert.equal(code, 0, out);
  assert.equal(JSON.parse(out).length, 16);
});

test('a lost create response is replayed once, after a pause, and yields the same test', async t => {
  const { service, sleeps, placement, select } = await setup(t);
  service.controls.loseCreates = 1;
  const run = await placement.create(select);
  assert.equal(service.tests.size, 1);
  assert.ok(sleeps[0] >= 25000);
  assert.equal(run.state, 'allocated');
});

test('a create lost twice is unknown, and creating again reaches the same test', async t => {
  const { service, placement, select } = await setup(t);
  service.controls.loseCreates = 2;
  await assert.rejects(placement.create(select), { code: 'ALLOCATION_UNKNOWN', exitCode: 6 });
  assert.equal((await placement.store.load(select.request)).state, 'allocation_unknown');
  const run = await placement.create(select);
  assert.equal(service.tests.size, 1);
  assert.equal(run.remote.uuid, select.request);
});

test('results translate onto the saved test, and validity is the client\'s call', async t => {
  const { service, placement, select } = await setup(t);
  const run = await placement.create(select);
  assert.equal((await placement.status(select)).status, 'awaiting_message');

  service.arrive(run.remote.uuid, { from: FROM, placements: ['inbox', 'inbox', 'spam', 'junk'] });
  const partial = await placement.status(select);
  assert.equal(partial.status, 'receiving');
  assert.equal(partial.report_url, run.test.report_url);
  assert.equal(partial.received_count, 5); // four seeds and the test's own address
  assert.equal(partial.classified_count, 4);
  assert.equal(partial.provider_results.find(p => p.provider === 'gmail').spam, 2); // junk counts as spam
  assert.equal(partial.validation.status, 'pending');

  service.arrive(run.remote.uuid, { from: FROM, placements: allInbox, status: 'completed' });
  const done = await placement.status(select);
  assert.equal(done.status, 'complete');
  assert.deepEqual(done.validation, { status: 'valid', reasons: [] });
});

test('a completed test with unseen seeds is incomplete, and a wrong sender is invalid', async t => {
  const missing = await setup(t);
  const run = await missing.placement.create(missing.select);
  missing.service.arrive(run.remote.uuid, { from: FROM, placements: [...allInbox.slice(0, 14), 'missing'], status: 'completed' });
  const incomplete = await missing.placement.status(missing.select);
  assert.equal(incomplete.status, 'incomplete');
  assert.equal(incomplete.validation.status, 'unknown');

  const wrong = await setup(t);
  const other = await wrong.placement.create(wrong.select);
  wrong.service.arrive(other.remote.uuid, { from: 'someone@else.example.org', placements: allInbox, status: 'completed' });
  const invalid = await wrong.placement.status(wrong.select);
  assert.deepEqual(invalid.validation, { status: 'invalid', reasons: ['SENDER_MISMATCH'] });
});

test('refusals on arrival and expiry map to their own terminal statuses', async t => {
  for (const [status, expected, reason] of [['rate_limited', 'rate_limited', 'RATE_LIMITED'], ['free_mail', 'free_mail', 'FREE_MAIL']]) {
    const s = await setup(t);
    const run = await s.placement.create(s.select);
    s.service.arrive(run.remote.uuid, { from: FROM, status });
    const r = await s.placement.status(s.select);
    assert.equal(r.status, expected);
    assert.deepEqual(r.validation, { status: 'invalid', reasons: [reason] });
  }
  const s = await setup(t);
  const run = await s.placement.create(s.select);
  s.service.tests.get(run.remote.uuid).status = 'expired';
  assert.equal((await s.placement.status(s.select)).status, 'expired');
});

test('a later run for the same test code is recorded as a different send', async t => {
  const { service, placement, select } = await setup(t);
  const run = await placement.create(select);
  const test = service.tests.get(run.remote.uuid);
  test.latest = { ...test, uuid: '0199a1d2-7c30-7a1e-8f6b-dddddddddddd', status: 'completed', fromEmail: FROM,
    emailReceivedAt: new Date().toISOString(), placements: Object.fromEntries(service.SEEDS.map(s => [s.email, 'inbox'])) };
  const r = await placement.status(select);
  assert.equal(r.status, 'complete');
  assert.equal((await placement.store.load(select.request)).superseded_by.uuid, '0199a1d2-7c30-7a1e-8f6b-dddddddddddd');
});

test('a later run with its own creation time keeps its times on the local clock', async t => {
  let clock = Date.now();
  const { service, placement, select } = await setup(t, { now: () => clock, localNow: () => clock });
  const run = await placement.create(select);
  clock += 40 * 60000;
  const arrival = new Date(clock - 60000).toISOString();
  const test = service.tests.get(run.remote.uuid);
  test.latest = { ...test, uuid: '0199a1d2-7c30-7a1e-8f6b-eeeeeeeeeeee', createdAt: new Date(clock - 5 * 60000).toISOString(),
    status: 'completed', fromEmail: FROM, emailReceivedAt: arrival, placements: Object.fromEntries(service.SEEDS.map(s => [s.email, 'inbox'])) };
  const r = await placement.status(select);
  assert.equal(r.first_detected_at, arrival);
  assert.equal(r.updated_at, new Date(clock).toISOString());
});

test('a finished later run reads back identically, though its clock offset moves between reads', async t => {
  let clock = Date.now();
  let jitter = 0;
  const { service, placement, select } = await setup(t, { now: () => clock, localNow: () => clock + jitter });
  const run = await placement.create(select);
  clock += 40 * 60000;
  const test = service.tests.get(run.remote.uuid);
  test.latest = { ...test, uuid: '0199a1d2-7c30-7a1e-8f6b-ffffffffffff', createdAt: new Date(clock - 5 * 60000).toISOString(),
    status: 'completed', fromEmail: FROM, emailReceivedAt: new Date(clock - 60000).toISOString(),
    placements: Object.fromEntries(service.SEEDS.map(s => [s.email, 'inbox'])) };
  const first = await placement.status(select);
  // Network latency and sampling move the local-minus-service offset by a fraction of a second.
  clock += 15000;
  jitter = 150;
  const second = await placement.status(select);
  assert.deepEqual(second.recipient_results, first.recipient_results);
  assert.equal(second.first_detected_at, first.first_detected_at);
});

test('a read that answers for a different test is refused, not taken as a later run', async t => {
  const { service, placement, select } = await setup(t);
  const run = await placement.create(select);
  // Another test, on the same shared seed pool, answers for this test code.
  const other = { ...service.tests.get(run.remote.uuid), uuid: '0199a1d2-7c30-7a1e-8f6b-aaaaaaaaaaaa', testCode: 'someoneelse', emailAddress: 'someoneelse@example.com' };
  service.tests.get(run.remote.uuid).latest = other;
  await assert.rejects(placement.status(select), { code: 'INVALID_RESULTS', exitCode: 5 });
  const saved = await placement.store.load(select.request);
  assert.equal(saved.superseded_by, undefined);
  assert.ok(!saved.runs_seen.includes(other.uuid));
});

test('an interrupt during the replay wait stops create, releases the lock, and creating again recovers', async t => {
  const controller = new AbortController();
  const { service, placement, select } = await setup(t, { sleep: async () => { controller.abort(); } });
  service.controls.loseCreates = 1;
  await assert.rejects(placement.create(select, false, controller.signal), { code: 'INTERRUPTED', exitCode: 130 });
  assert.equal((await placement.store.load(select.request)).state, 'allocation_unknown');
  assert.equal(service.calls.filter(c => c.method === 'POST').length, 1);
  const run = await placement.create(select);
  assert.equal(run.state, 'allocated');
  assert.equal(service.tests.size, 1);
});

test('a failed first read after a successful create is an unknown allocation, and creating again recovers it', async t => {
  const { service, placement, select } = await setup(t);
  // The results route has not caught up with the new test yet.
  service.controls.status = 404;
  await assert.rejects(placement.create(select), { code: 'ALLOCATION_UNKNOWN', exitCode: 6, retryable: true });
  assert.equal((await placement.store.load(select.request)).state, 'allocation_unknown');
  service.controls.status = null;
  const run = await placement.create(select);
  assert.equal(service.tests.size, 1);
  assert.equal(run.state, 'allocated');
});

test('a response outside the derived contract stops the run rather than being guessed at', async t => {
  const { service, placement, select } = await setup(t);
  const run = await placement.create(select);
  service.tests.get(run.remote.uuid).status = 'teleported';
  await assert.rejects(placement.status(select), { code: 'INVALID_RESULTS', exitCode: 5 });
  assert.equal((await placement.store.load(select.request)).state, 'allocated');
});

test('HTTP failures map onto the CLI\'s retry rules', async t => {
  const { service, placement, select } = await setup(t);
  await placement.create(select);
  for (const [status, code, retryable] of [[404, 'TEST_NOT_FOUND', false], [429, 'RATE_LIMITED', true], [503, 'SERVICE_UNAVAILABLE', true], ['network', 'NETWORK_ERROR', true], [400, 'REQUEST_REFUSED', false]]) {
    service.controls.status = status;
    const error = await placement.status(select).then(() => null, e => e);
    assert.equal(error.code, code, String(status));
    assert.equal(error.retryable, retryable, String(status));
    if (status === 429) assert.equal(error.details.retry_after_seconds, 30);
  }
});

test('a run created without the CLI is imported from a read', async t => {
  const { service, placement, api } = await setup(t);
  const other = await new Placement(new StateStore(await mkdtemp(join(tmpdir(), 'inboxally-http-other-')), 'production'), api)
    .prepare(FROM, 'mailchimp', 'Campaign').then(async intent => api.create(intent.body, intent.local_request_id));
  const run = await placement.adopt(other.test_id, { from: FROM, platform: 'mailchimp', campaign: 'Campaign', uuid: other.run_uuid });
  assert.equal(run.remote.test_code, other.test_id);
  assert.equal(service.tests.size, 1);
});

test('doctor probes the service only when the free-tier transport is enabled', async t => {
  const { api, placement } = await setup(t);
  let out = '';
  const code = await runCli(['doctor', '--json'], { placement, env: {}, stdout: s => { out += s; }, stderr: () => {} });
  assert.equal(code, 0);
  const checks = JSON.parse(out).data.checks;
  assert.equal(checks.find(c => c.name === 'service').status, 'pass');
  assert.equal(checks.find(c => c.name === 'api_contract').status, 'warn');
  void api;
});

test('a sender reported with a display name is matched by its address alone', async t => {
  const named = await setup(t);
  const a = await named.placement.create(named.select);
  named.service.arrive(a.remote.uuid, { from: `Harbor Goods <${FROM}>`, placements: allInbox, status: 'completed' });
  const r = await named.placement.status(named.select);
  assert.equal(r.validation.status, 'valid');
  assert.ok(r.recipient_results.every(item => item.observed_from === FROM));

  for (const header of [`"Sales <EU>" <${FROM}>`, `<${FROM}> (Harbor Goods)`]) {
    const odd = await setup(t);
    const run = await odd.placement.create(odd.select);
    odd.service.arrive(run.remote.uuid, { from: header, placements: allInbox, status: 'completed' });
    assert.equal((await odd.placement.status(odd.select)).validation.status, 'valid', header);
  }

  const other = await setup(t);
  const b = await other.placement.create(other.select);
  other.service.arrive(b.remote.uuid, { from: `Harbor Goods <someone@elsewhere.example.org>`, placements: allInbox, status: 'completed' });
  assert.deepEqual((await other.placement.status(other.select)).validation, { status: 'invalid', reasons: ['SENDER_MISMATCH'] });

  const broken = await setup(t);
  const c = await broken.placement.create(broken.select);
  broken.service.arrive(c.remote.uuid, { from: `Harbor Goods <not an address>`, placements: allInbox, status: 'completed' });
  await assert.rejects(broken.placement.status(broken.select), { code: 'INVALID_RESULTS', exitCode: 5 });
});

test('seeds the service did not find or could not check are missing and unreachable, and older runs upgrade to match', async t => {
  const { root, service, placement, select } = await setup(t);
  const run = await placement.create(select);
  // The first live run's shape: seven inbox, five spam, two missing, one the service could not check.
  const placements = ['inbox', 'inbox', 'inbox', 'inbox', 'missing', 'error', 'inbox', 'inbox', 'inbox', 'spam', 'spam', 'spam', 'spam', 'spam', 'missing'];
  service.arrive(run.remote.uuid, { from: FROM, placements, status: 'completed' });
  const r = await placement.status(select);
  assert.equal(r.status, 'incomplete');
  const count = key => r.provider_results.reduce((sum, g) => sum + g[key], 0);
  assert.deepEqual([count('inbox'), count('spam'), count('missing'), count('unreachable'), count('pending')], [7, 5, 2, 1, 0]);
  const unreachable = r.recipient_results.find(item => item.placement === 'unreachable');
  assert.equal(unreachable.delivery, 'unknown');

  // The same run as a version 5 file saved it: unseen seeds pending, no counts for them.
  const path = join(root, `${select.request}.json`);
  const saved = JSON.parse(await readFile(path, 'utf8'));
  const legacy = structuredClone(saved);
  legacy.local_schema_version = 5;
  for (const item of legacy.snapshot.recipient_results) if (['missing', 'unreachable'].includes(item.placement)) item.placement = 'pending';
  for (const g of legacy.snapshot.provider_results) { g.pending += g.missing + g.unreachable; delete g.missing; delete g.unreachable; }
  delete legacy.snapshot.service_summary;
  await writeFile(path, JSON.stringify(legacy) + '\n');
  assert.deepEqual((await placement.store.load(select.request)).snapshot, { ...saved.snapshot, service_summary: null });
  // The next read of the finished test agrees with the upgraded rows, and gains the service's figures.
  const reread = await placement.status(select);
  assert.deepEqual(reread.recipient_results, saved.snapshot.recipient_results);
  assert.deepEqual(reread.service_summary, saved.snapshot.service_summary);
});

test('an older saved run upgrades to exactly what the next read gives, whatever its final status', async t => {
  const cases = [
    // Expired with nothing received: every seed stays pending; nothing was ever checked.
    { status: 'expired', placements: [], from: null },
    // Completed with seeds the service never reported on: they count as missing.
    { status: 'completed', placements: ['inbox', 'spam', null, 'error'], from: FROM },
    // Refused on arrival, with rows the service marked missing: not a completed measurement, so pending.
    { status: 'rate_limited', placements: ['missing', 'missing', 'error'], from: FROM },
    { status: 'failed', placements: ['missing', null, 'error'], from: FROM },
  ];
  for (const c of cases) {
    const { root, service, placement, select } = await setup(t);
    const run = await placement.create(select);
    const test = service.tests.get(run.remote.uuid);
    if (c.status === 'expired') test.status = 'expired';
    else service.arrive(run.remote.uuid, { from: c.from, placements: c.placements, status: c.status });
    await placement.status(select);
    const path = join(root, `${select.request}.json`);
    const saved = JSON.parse(await readFile(path, 'utf8'));
    const legacy = structuredClone(saved);
    legacy.local_schema_version = 5;
    for (const item of legacy.snapshot.recipient_results) if (['missing', 'unreachable'].includes(item.placement)) item.placement = 'pending';
    for (const g of legacy.snapshot.provider_results) { g.pending += g.missing + g.unreachable; delete g.missing; delete g.unreachable; }
    delete legacy.snapshot.service_summary;
    await writeFile(path, JSON.stringify(legacy) + '\n');
    const reread = await placement.status(select);
    assert.deepEqual(reread.recipient_results, saved.snapshot.recipient_results, c.status);
  }
});

test('a finished measurement carries the service\'s own figures, which must agree with the rows', async t => {
  const placements = ['inbox', 'inbox', 'inbox', 'inbox', 'missing', 'error', 'inbox', 'inbox', 'inbox', 'spam', 'spam', 'spam', 'junk', 'spam', 'missing'];
  const { service, placement, select } = await setup(t);
  const run = await placement.create(select);
  // Mid-test, the service's running percentages are not a measurement and are not carried.
  service.arrive(run.remote.uuid, { from: FROM, placements: placements.slice(0, 4) });
  assert.equal((await placement.status(select)).service_summary, null);
  service.arrive(run.remote.uuid, { from: FROM, placements, status: 'completed' });
  const r = await placement.status(select);
  // The first live run's figures: 7 inbox and 5 spam of 14 scored, 2 missing, 1 not checkable.
  assert.deepEqual(r.service_summary, {
    label: 'Mixed Delivery', level: 'warning', inbox_rate: 50, delivery_rate: 86,
    counts: { inbox: 7, spam: 5, missing: 2, unreachable: 1 }, scored_total: 14,
    by_provider: [
      { provider: 'gmail', inbox: 4, spam: 0, missing: 1, total: 5, inbox_rate: 80 },
      { provider: 'outlook', inbox: 3, spam: 2, missing: 0, total: 5, inbox_rate: 60 },
      { provider: 'yahoo', inbox: 0, spam: 3, missing: 1, total: 4, inbox_rate: 0 },
    ],
  });

  // Figures that disagree with the rows are never quoted: the read keeps the measurement and drops
  // the figures. A saved snapshot that carried such figures would be refused.
  for (const edit of [
    f => { f.stats.counts.inbox = 8; },
    f => { f.verdict.inboxRate = 70; },
    f => { f.stats.byProvider[0].missing = 0; },
    f => { f.stats.scoredTotal = 15; },
    f => { f.verdict.inboxRate = 50.4; },
    f => { f.stats.counts.missing = 1; f.stats.counts.spam = 6; },
  ]) {
    const bad = await setup(t);
    const b = await bad.placement.create(bad.select);
    bad.service.arrive(b.remote.uuid, { from: FROM, placements, status: 'completed' });
    bad.service.controls.summary = f => { edit(f); return f; };
    const kept = await bad.placement.status(bad.select);
    assert.equal(kept.service_summary, null);
    assert.equal(kept.status, 'incomplete');
  }
  const forged = structuredClone(r);
  forged.service_summary.counts.inbox = 8;
  assert.throws(() => validateResult(forged, run.test, [REPORT_ORIGIN]), { code: 'INVALID_RESULTS' });

  // Once saved, the figures are kept: a later read whose own cannot be used, or whose wording
  // differs, neither loses nor replaces them.
  const later = await setup(t);
  const g = await later.placement.create(later.select);
  later.service.arrive(g.remote.uuid, { from: FROM, placements, status: 'completed' });
  const saved = (await later.placement.status(later.select)).service_summary;
  later.service.controls.summary = f => ({ ...f, stats: undefined });
  assert.deepEqual((await later.placement.status(later.select)).service_summary, saved);
  for (const reword of [f => ({ ...f, verdict: { ...f.verdict, label: 'Mixed Delivery!' } }), f => ({ ...f, verdict: { ...f.verdict, level: undefined } })]) {
    later.service.controls.summary = reword;
    assert.deepEqual((await later.placement.status(later.select)).service_summary, saved);
  }

  // No seed could be checked: the service lists no provider, and that is still a summary.
  const blind = await setup(t);
  const e = await blind.placement.create(blind.select);
  blind.service.arrive(e.remote.uuid, { from: FROM, placements: Array(15).fill('error'), status: 'completed' });
  const none = (await blind.placement.status(blind.select)).service_summary;
  assert.deepEqual([none.scored_total, none.by_provider.length, none.inbox_rate], [0, 0, 0]);

  // A shape the CLI does not recognise costs the summary, never the measurement; an odd label is dropped.
  const odd = await setup(t);
  const c = await odd.placement.create(odd.select);
  odd.service.arrive(c.remote.uuid, { from: FROM, placements, status: 'completed' });
  odd.service.controls.summary = f => ({ ...f, stats: { ...f.stats, counts: 'n/a' } });
  const unrecognised = await odd.placement.status(odd.select);
  assert.equal(unrecognised.service_summary, null);
  assert.equal(unrecognised.status, 'incomplete');
  const labelled = await setup(t);
  const d = await labelled.placement.create(labelled.select);
  labelled.service.arrive(d.remote.uuid, { from: FROM, placements, status: 'completed' });
  labelled.service.controls.summary = f => ({ ...f, verdict: { ...f.verdict, label: '<b>Great!</b>', level: 'celebrate' } });
  const s = (await labelled.placement.status(labelled.select)).service_summary;
  assert.equal(s.label, null);
  assert.equal(s.level, null);
  assert.equal(s.inbox_rate, 50);
});

test('a second test for a domain whose campaign arrived today is stopped before it is created', async t => {
  const { root, service, placement, select } = await setup(t);
  const run = await placement.create(select);
  service.arrive(run.remote.uuid, { from: FROM, placements: allInbox, status: 'completed' });
  await placement.status(select);
  // The earlier run is finished, so only the day's limit stands in the way.
  await placement.note(select, 'done', 'tool_observed', { note: 'explained' });
  const next = await placement.prepare(FROM, 'mailchimp', 'Another campaign');
  const posts = service.calls.filter(c => c.method === 'POST').length;
  const error = await placement.create({ request: next.local_request_id }).then(() => null, e => e);
  assert.equal(error.code, 'DOMAIN_RECENTLY_TESTED');
  assert.equal(error.exitCode, 4);
  assert.ok(Date.parse(error.data.likely_available_after) > Date.now());
  assert.equal(service.calls.filter(c => c.method === 'POST').length, posts, 'nothing was sent to the service');
  // The user may still choose to try.
  const tried = await placement.create({ request: next.local_request_id }, false, undefined, true);
  assert.equal(tried.state, 'allocated');
  void root;
});

test('status --brief, runs and inline note details give an agent the short answer', async t => {
  const { service, placement, select, api } = await setup(t);
  const run = await placement.create(select);
  service.arrive(run.remote.uuid, { from: FROM, placements: ['inbox', 'spam', 'missing', 'error', ...Array(11).fill('inbox')], status: 'completed' });
  const cli = async args => { let out = ''; const code = await runCli(args, { placement, env: {}, stdout: s => { out += s; }, stderr: () => {} }); return { code, json: JSON.parse(out) }; };
  const brief = (await cli(['placement', 'status', '--request', select.request, '--brief', '--json'])).json.data.summary;
  assert.deepEqual([brief.status, brief.placement.inbox, brief.placement.spam, brief.placement.missing, brief.placement.unreachable], ['incomplete', 12, 1, 1, 1]);
  assert.equal(brief.service_summary.inbox_rate, 86);
  assert.equal(brief.recipient_results, undefined);
  const listed = (await cli(['placement', 'runs', '--json'])).json.data.runs[0];
  assert.deepEqual([listed.result_status, listed.validity], ['incomplete', 'unknown']);
  const noted = await cli(['placement', 'note', '--request', select.request, '--event', 'watching', '--evidence', 'tool_observed', '--details', '{"note":"read"}', '--json']);
  assert.equal(noted.code, 0);
  const both = await cli(['placement', 'note', '--request', select.request, '--event', 'watching', '--evidence', 'tool_observed', '--details', '{}', '--details-file', 'x.json', '--json']);
  assert.equal(both.json.error.code, 'INVALID_ARGUMENTS');
  const platform = await cli(['placement', 'prepare', '--from', FROM, '--platform', 'gmail', '--campaign', 'x', '--json']);
  assert.match(platform.json.error.message, /google-workspace/);
  void api;
});

test('a rate-limited refusal says when the domain may test again, and never the bypass hint', async t => {
  const { service, placement, select } = await setup(t);
  const run = await placement.create(select);
  service.arrive(run.remote.uuid, { from: FROM, status: 'rate_limited' });
  const r = await placement.status(select);
  assert.equal(r.status, 'rate_limited');
  assert.ok(Math.abs(Date.parse(r.retry_after) - (Date.parse(run.test.created_at) + 86400000)) < 5000, r.retry_after);
  assert.ok(!JSON.stringify(r).includes('keyword'));
  // Read again, it is unchanged, and the finished refusal still reads back.
  assert.equal((await placement.status(select)).retry_after, r.retry_after);
  // A later create for the domain waits for the service's own retry time, not a day from this arrival.
  await placement.note(select, 'stopped', 'tool_observed', { note: 'refused' });
  const next = await placement.prepare(FROM, 'mailchimp', 'Another campaign');
  const error = await placement.create({ request: next.local_request_id }).then(() => null, e => e);
  assert.equal(error.code, 'DOMAIN_RECENTLY_TESTED');
  assert.equal(error.data.likely_available_after, new Date(Date.parse(r.retry_after)).toISOString());
});

test('a retry time the CLI does not recognise costs the retry time, not the read', async t => {
  const { service, placement, select } = await setup(t);
  const run = await placement.create(select);
  service.arrive(run.remote.uuid, { from: FROM, status: 'rate_limited' });
  service.controls.rateLimit = { retryAfter: 'tomorrow' };
  const r = await placement.status(select);
  assert.equal(r.status, 'rate_limited');
  assert.equal(r.retry_after, undefined);
});

test('a refusal from the wrong sender carries both reasons', async t => {
  const { service, placement, select } = await setup(t);
  const run = await placement.create(select);
  service.arrive(run.remote.uuid, { from: 'someone@free-mail.example.org', status: 'free_mail' });
  const r = await placement.status(select);
  assert.deepEqual(r.validation, { status: 'invalid', reasons: ['FREE_MAIL', 'SENDER_MISMATCH'] });
});

test('first detection stays put across reads, even for seeds with no timestamp of their own', async t => {
  let clock = Date.now();
  const { service, placement, select } = await setup(t, { now: () => clock, localNow: () => clock });
  const run = await placement.create(select);
  // A seed seen with no timestamp, before the test's own address has anything: no stable time
  // is on offer, so first detection must not fall back to the read's own clock.
  service.controls.noDetectedAt = true;
  Object.assign(service.arrive(run.remote.uuid, { from: FROM, placements: ['inbox'] }), { emailReceivedAt: null });
  clock += 60000;
  const first = await placement.status(select);
  // Seen by this read, with no reported time: the read's time, never the test's creation.
  assert.equal(first.first_detected_at, new Date(clock).toISOString());
  clock += 60000;
  const second = await placement.status(select);
  assert.equal(second.first_detected_at, first.first_detected_at);
});

test('first detection moves earlier when an earlier seed is reported late, and never later', async t => {
  let clock = Date.now();
  const { service, placement, select } = await setup(t, { now: () => clock, localNow: () => clock });
  const run = await placement.create(select);
  const at = offset => new Date(Date.parse(run.test.created_at) + offset).toISOString();
  clock += 120000;
  service.controls.detected = { 0: at(60000) };
  service.arrive(run.remote.uuid, { from: FROM, placements: ['inbox'] });
  assert.equal((await placement.status(select)).first_detected_at, at(60000));

  // A second provider reports a seed that arrived earlier.
  service.controls.detected = { 0: at(60000), 1: at(20000) };
  service.arrive(run.remote.uuid, { from: FROM, placements: ['inbox', 'inbox'] });
  assert.equal((await placement.status(select)).first_detected_at, at(20000));

  // The service then reports that seed later than before: the earlier time is kept.
  service.controls.detected = { 0: at(60000), 1: at(40000) };
  assert.equal((await placement.status(select)).first_detected_at, at(20000));
});

test('every service time lands on the local clock, even with the local clock far behind', async t => {
  // The local clock runs fifteen minutes behind the service's.
  const skew = -900000;
  const { service, placement, select } = await setup(t, { localNow: () => Date.now() + skew });
  const run = await placement.create(select);
  assert.equal(Date.parse(run.test.send_before) - Date.parse(run.test.created_at), SEND_DEADLINE_MINUTES * 60000);
  assert.ok(Math.abs(Date.parse(run.test.created_at) - (Date.now() + skew)) < 5000);
  service.arrive(run.remote.uuid, { from: FROM, placements: allInbox });
  const r = await placement.status(select);
  for (const time of [r.first_detected_at, r.updated_at]) assert.ok(Math.abs(Date.parse(time) - (Date.now() + skew)) < 5000, time);
  assert.ok(Date.parse(r.first_detected_at) >= Date.parse(run.test.created_at));
});

test('an oversized body is refused by its size in bytes, not characters', async t => {
  const { service, placement, select } = await setup(t);
  await placement.create(select);
  service.controls.oversize = true;
  await assert.rejects(placement.status(select), { code: 'INVALID_RESULTS', exitCode: 5 });
  // The run is preserved and the next ordinary read succeeds.
  assert.equal((await placement.status(select)).status, 'awaiting_message');
});

test('complete needs the test\'s own address reached and a sender; otherwise it is not called valid', async t => {
  const unreached = await setup(t);
  const a = await unreached.placement.create(unreached.select);
  Object.assign(unreached.service.arrive(a.remote.uuid, { from: FROM, placements: allInbox, status: 'completed' }), { emailReceivedAt: null });
  assert.equal((await unreached.placement.status(unreached.select)).status, 'incomplete');

  const anonymous = await setup(t);
  const b = await anonymous.placement.create(anonymous.select);
  anonymous.service.arrive(b.remote.uuid, { from: null, placements: allInbox, status: 'completed' });
  const r = await anonymous.placement.status(anonymous.select);
  assert.equal(r.status, 'complete');
  assert.equal(r.validation.status, 'unknown');
});

test('a body cut off after the headers is a lost response: create replays, a read is retryable', async t => {
  const { service, sleeps, placement, select } = await setup(t);
  service.controls.cutBody = 'create';
  await placement.create(select);
  assert.equal(service.tests.size, 1);
  assert.ok(sleeps[0] >= 25000);
  service.controls.cutBody = 'read';
  const error = await placement.status(select).then(() => null, e => e);
  assert.equal(error.code, 'NETWORK_ERROR');
  assert.equal(error.retryable, true);
});

test('a 429 without Retry-After gives no retry delay', async t => {
  const { service, placement, select } = await setup(t);
  await placement.create(select);
  Object.assign(service.controls, { status: 429, bareRetry: true });
  const error = await placement.status(select).then(() => null, e => e);
  assert.equal(error.code, 'RATE_LIMITED');
  assert.equal(error.details.retry_after_seconds, undefined);
});

test('doctor does not report ready when a readiness check failed', { skip: process.platform === 'win32' && 'POSIX permissions' }, async t => {
  const { root, api } = await setup(t);
  // A run directory that exists but cannot be read or written.
  const locked = join(root, 'locked');
  await mkdir(locked);
  await chmod(locked, 0o000);
  let out = '';
  let code;
  try {
    const placement = new Placement(new StateStore(locked, 'production'), api);
    code = await runCli(['doctor', '--json'], { placement, env: {}, stdout: s => { out += s; }, stderr: () => {} });
  } finally { await chmod(locked, 0o700); }
  assert.notEqual(code, 0);
  assert.equal(JSON.parse(out).error.code, 'NOT_READY');
});
