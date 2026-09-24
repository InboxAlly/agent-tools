import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateResult, progressMessage, resultSchema } from '../dist/results.js';
import { Placement } from '../dist/placement.js';
import { StateStore } from '../dist/state.js';
import { manifest, resultSnapshot, fakeClock } from './support/fixtures.mjs';
import { fixtureServer } from './support/server.mjs';
import { watch } from '../dist/watch.js';
import { runCli } from '../dist/cli.js';
import { CliError } from '../dist/errors.js';

const origins = ['https://reports.example.com'];
async function setup(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'inboxally-results-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const server = await fixtureServer(options);
  t.after(server.close);
  const placement = new Placement(new StateStore(root, 'mock'), server.api);
  const intent = await placement.prepare('newsletter@example.com', 'mailchimp', 'Campaign');
  const run = await placement.create({ request: intent.local_request_id });
  return { root, server, placement, run, id: run.test.test_id };
}

test('known states preserve 16 observations versus 15 placement denominators', async () => {
  const m = await manifest();
  for (const stage of ['awaiting', 'partial', 'unclassified', 'complete', 'incomplete', 'expired', 'failed', 'invalid', 'unknown']) {
    const r = validateResult(resultSnapshot(m, stage), m, origins);
    assert.equal(r.recipient_results.length, 16);
    assert.equal(r.provider_results.reduce((sum, p) => sum + p.expected_count, 0), 15);
  }
  const partial = validateResult(resultSnapshot(m, 'partial'), m, origins);
  assert.equal(partial.received_count, 9);
  assert.equal(partial.classified_count, 8);
  assert.match(progressMessage(partial), /8\/15/);
  assert.match(progressMessage(partial), /7 pending/);
  assert.ok(!progressMessage(partial).includes('%'));
});

test('malformed, mismatched, fabricated and changed results fail validation', async () => {
  const m = await manifest();
  const cases = [
    r => r.status = 'unexpected',
    r => r.test_id = 'different-run',
    r => r.recipients[0].email = 'changed@example.com',
    r => r.list_name = 'different-list',
    r => r.recipient_results[0].recipient_id = 'outside-manifest',
    r => r.recipient_results[0].recipient_id = r.recipient_results[1].recipient_id,
    r => r.received_count++,
    r => r.classified_count++,
    r => r.provider_results[0].inbox++,
    r => r.provider_results.push(r.provider_results[0]),
    r => r.provider_results[0].provider = 'guessed-provider',
    r => r.recipient_results[15].placement = 'inbox',
    r => r.recipient_results[0].observed_from = 'wrong@example.com',
    r => r.first_detected_at = null,
    r => r.updated_at = '2000-01-01T00:00:00Z',
    r => r.access.read_token = 'SECRET_SENTINEL',
  ];
  for (const mutate of cases) {
    const r = resultSnapshot(m, 'complete'); mutate(r);
    assert.throws(() => validateResult(r, m, origins), e => ['INVALID_RESULTS', 'INVALID_MANIFEST'].includes(e.code));
  }
  const incomplete = resultSnapshot(m, 'partial'); incomplete.status = 'complete';
  assert.throws(() => validateResult(incomplete, m, origins), { code: 'INVALID_RESULTS' });
  // Missing is a finding of a finished measurement: mid-test, an unseen seed is pending.
  const early = resultSnapshot(m, 'partial');
  const unseen = early.recipient_results.find(item => item.placement === 'pending');
  unseen.placement = 'missing';
  const group = early.provider_results.find(g => g.pending > 0 && m.recipients.find(r => r.id === unseen.recipient_id).provider === g.provider);
  group.pending--; group.missing++;
  assert.throws(() => validateResult(early, m, origins), { code: 'INVALID_RESULTS' });
});

test('the static placement.v1 examples match the current result schema', async () => {
  for (const name of ['results.complete.json', 'results.partial.json']) {
    const example = JSON.parse(await readFile(new URL(`../../../fixtures/placement.v1/${name}`, import.meta.url), 'utf8'));
    assert.ok(resultSchema.safeParse(example).success, name);
  }
});

test('provider order and optional wire fields do not change a public measurement', async () => {
  const m = await manifest();
  const raw = resultSnapshot(m, 'complete');
  raw.provider_results.reverse();
  raw.recipient_results.reverse();
  raw.private_debug = 'SECRET_SENTINEL';
  raw.recipient_results[0].raw_message = 'SECRET_SENTINEL';
  const result = validateResult(raw, m, origins);
  assert.ok(!JSON.stringify(result).includes('SECRET_SENTINEL'));
});

test('older or changed terminal snapshots cannot replace the saved measurement', async () => {
  const m = await manifest();
  const complete = resultSnapshot(m, 'complete');
  assert.throws(() => validateResult(resultSnapshot(m, 'partial'), m, origins, complete), { code: 'INVALID_RESULTS' });
  const invalid = resultSnapshot(m, 'invalid');
  invalid.updated_at = new Date(Date.parse(complete.updated_at) + 1000).toISOString();
  assert.throws(() => validateResult(invalid, m, origins, complete), { code: 'INVALID_RESULTS' });
  const refresh = structuredClone(complete);
  refresh.request_id = 'new-support-id';
  refresh.poll_after_seconds = 30;
  refresh.updated_at = new Date(Date.parse(complete.updated_at) + 1000).toISOString();
  assert.equal(validateResult(refresh, m, origins, complete).status, 'complete');
});

test('status persists partial results and resume returns the same test after restart', async t => {
  const { placement, root, server, run, id } = await setup(t, { stages: ['partial', 'complete'] });
  assert.equal((await placement.status({ test: id })).status, 'receiving');
  const restarted = new Placement(new StateStore(root, 'mock'), server.api);
  const recovered = await restarted.create({ request: run.local_request_id });
  assert.equal(recovered.snapshot.classified_count, 8);
  assert.equal((await restarted.status({ test: id })).status, 'complete');
  assert.equal(server.metrics.allocations, 1);
  assert.equal(server.metrics.charges, 1);
});

test('watch polls within limits and returns the completed snapshot without new allocation', async t => {
  const { placement, server, id } = await setup(t);
  const clock = fakeClock();
  const observed = [];
  const result = await watch(placement, { test: id }, { onProgress: r => observed.push(r.status) }, clock);
  assert.deepEqual(observed, ['awaiting_message', 'receiving', 'complete']);
  assert.deepEqual(clock.waits, [15000, 15000]);
  assert.equal(result.watch.elapsed_seconds, 30);
  assert.equal(result.watch.timed_out, false);
  assert.equal(server.metrics.allocations, 1);
  assert.equal(server.metrics.reads, 3);
});

test('watch timeout preserves the last snapshot without shortening server poll delays', async t => {
  const { placement, id, server } = await setup(t, { stages: ['partial'] });
  const original = server.api.get;
  server.api.get = async (...args) => ({ ...await original(...args), poll_after_seconds: 60 });
  const clock = fakeClock();
  await assert.rejects(watch(placement, { test: id }, { timeoutSeconds: 30 }, clock), e => {
    assert.equal(e.exitCode, 7);
    assert.equal(e.data.test.classified_count, 8);
    assert.equal(e.data.watch.timed_out, true);
    return true;
  });
  assert.deepEqual(clock.waits, [30000]);
  assert.equal(server.metrics.reads, 1);
  assert.equal((await placement.selected({ test: id })).snapshot.status, 'receiving');
});

test('lost result connection retries within the same watch and fixed test', async t => {
  const { placement, server, id } = await setup(t, { stages: ['partial', 'complete'], loseFirstReadResponse: true });
  const result = await watch(placement, { test: id }, {}, fakeClock());
  assert.equal(result.test.status, 'complete');
  assert.equal(server.metrics.reads, 3);
  assert.equal(server.metrics.charges, 1);
});

test('retry exhaustion and permanent errors return useful saved state', async t => {
  const { placement, server, id } = await setup(t, { stages: ['partial'] });
  await placement.status({ test: id });
  let attempts = 0;
  server.api.get = async () => { attempts++; throw new CliError('NETWORK_ERROR', 'Synthetic failure.', 6, true); };
  await assert.rejects(watch(placement, { test: id }, {}, fakeClock()), e => {
    assert.equal(e.exitCode, 6);
    assert.equal(e.data.test.classified_count, 8);
    return true;
  });
  assert.equal(attempts, 3);
  attempts = 0;
  server.api.get = async () => { attempts++; throw new CliError('AUTH_REQUIRED', 'Reconnect.', 3); };
  await assert.rejects(watch(placement, { test: id }, {}, fakeClock()), { code: 'AUTH_REQUIRED' });
  assert.equal(attempts, 1);
});

test('Retry-After cannot cause an early retry beyond the watch budget', async t => {
  const { placement, server, id } = await setup(t);
  let attempts = 0;
  server.api.get = async () => { attempts++; throw new CliError('RATE_LIMITED', 'Wait.', 4, true, null, { retry_after_seconds: 120 }); };
  const clock = fakeClock();
  await assert.rejects(watch(placement, { test: id }, { timeoutSeconds: 30 }, clock), { exitCode: 7 });
  assert.equal(attempts, 1);
  assert.deepEqual(clock.waits, [30000]);
});

test('terminal incomplete/expired/failed/invalid measurements use watch exit 8', async t => {
  for (const stage of ['incomplete', 'expired', 'failed', 'invalid']) {
    const { placement, id } = await setup(t, { stages: [stage] });
    await assert.rejects(watch(placement, { test: id }, {}, fakeClock()), e => {
      assert.equal(e.exitCode, 8);
      assert.equal(e.data.watch.timed_out, false);
      if (stage === 'invalid') assert.equal(e.data.test.validation.status, 'invalid');
      return true;
    });
  }
});

test('cancellation during polling returns latest snapshot and does not cancel the test', async t => {
  const { placement, id, server } = await setup(t, { stages: ['partial'] });
  const controller = new AbortController();
  await assert.rejects(watch(placement, { test: id }, { signal: controller.signal, onProgress: () => controller.abort() }, fakeClock()), e => {
    assert.equal(e.exitCode, 130);
    assert.equal(e.data.test.status, 'receiving');
    return true;
  });
  assert.equal((await placement.selected({ test: id })).snapshot.status, 'receiving');
  assert.equal(server.metrics.allocations, 1);
});

test('deadline interrupts an in-flight read, even before a first snapshot', async t => {
  const { placement, id, server } = await setup(t);
  server.api.get = async (_, signal) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  const started = performance.now();
  await assert.rejects(watch(placement, { test: id }, { timeoutSeconds: 1 }), e => {
    assert.equal(e.exitCode, 7);
    assert.equal(e.data.test.test_id, id);
    assert.equal(e.data.watch.timed_out, true);
    return true;
  });
  assert.ok(performance.now() - started < 1800);
});

test('CLI status exits 0 for incomplete; watch returns one JSON envelope and stderr progress', async t => {
  const { placement, id } = await setup(t, { stages: ['incomplete'] });
  const invoke = async args => {
    let stdout = '', stderr = '';
    const code = await runCli(args, { placement, env: {}, watchClock: fakeClock(),
      stdout: s => { stdout += s; }, stderr: s => { stderr += s; } });
    return { code, stdout, stderr };
  };
  assert.equal((await invoke(['placement', 'status', id, '--json'])).code, 0);
  const result = await invoke(['placement', 'watch', id, '--json']);
  assert.equal(result.code, 8);
  assert.equal(result.stdout.trim().split('\n').length, 1);
  assert.equal(JSON.parse(result.stdout).data.test.status, 'incomplete');
  assert.match(result.stderr, /8\/15/);
  assert.ok(!result.stderr.includes('example.com'));
  for (const timeout of ['0', '901', 'not-a-number', '1.5']) {
    assert.equal((await invoke(['placement', 'watch', id, '--timeout', timeout, '--json'])).code, 2);
  }
});

test('status remains readable after send cutoff without replacing allocation', async t => {
  const { placement, server, run, id } = await setup(t, { stages: ['complete'] });
  const old = await manifest(Date.now() - 10800000);
  old.test_id = id;
  old.list_name = run.test.list_name;
  run.test = old;
  await placement.store.save(run);
  server.api.get = async () => resultSnapshot(old, 'complete');
  assert.equal((await placement.status({ test: id })).status, 'complete');
  assert.equal(server.metrics.allocations, 1);
});

test('previous recipient observations cannot disappear behind unchanged aggregate counts', async () => {
  const m = await manifest();
  const previous = resultSnapshot(m, 'partial');
  const changed = structuredClone(previous);
  const seen = changed.recipient_results[6];
  const pending = changed.recipient_results[8];
  Object.assign(pending, { delivery: seen.delivery, placement: seen.placement, observed_from: seen.observed_from, received_at: seen.received_at });
  Object.assign(seen, { delivery: 'not_seen', placement: 'pending', observed_from: null, received_at: null });
  changed.updated_at = new Date(Date.parse(previous.updated_at) + 1000).toISOString();
  assert.throws(() => validateResult(changed, m, origins, previous), { code: 'INVALID_RESULTS' });
});

test('unexpected internal failures are not retried or exposed as raw messages', async t => {
  const { placement, server, id } = await setup(t);
  let attempts = 0;
  server.api.get = async () => { attempts++; throw new Error('SECRET_INTERNAL_SENTINEL'); };
  await assert.rejects(watch(placement, { test: id }, {}, fakeClock()), e => {
    assert.equal(e.code, 'INTERNAL_ERROR');
    assert.ok(!e.message.includes('SECRET_INTERNAL_SENTINEL'));
    return true;
  });
  assert.equal(attempts, 1);
});

test('cancellation interrupts an in-flight read and preserves the existing allocation', async t => {
  const { placement, server, id } = await setup(t);
  const controller = new AbortController();
  server.api.get = async (_, signal) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    queueMicrotask(() => controller.abort());
  });
  await assert.rejects(watch(placement, { test: id }, { signal: controller.signal }), { exitCode: 130 });
  assert.equal(server.metrics.allocations, 1);
});

// The real service gives no report link or allowance at creation, and refuses some campaigns on
// arrival: rate limited for the domain, or sent from a free-mail domain. Neither is a measurement.
test('a test without a report link or quota is valid, and a refusal on arrival is terminal and invalid', async () => {
  const m = await manifest();
  m.report_url = null;
  m.quota = null;
  for (const stage of ['awaiting', 'complete', 'rate_limited', 'free_mail']) {
    const r = validateResult(resultSnapshot(m, stage), m, origins);
    assert.equal(r.report_url, null);
  }
  for (const [stage, reason] of [['rate_limited', 'RATE_LIMITED'], ['free_mail', 'FREE_MAIL']]) {
    const r = validateResult(resultSnapshot(m, stage), m, origins);
    assert.equal(r.status, stage);
    assert.equal(r.classified_count, 0);
    assert.match(progressMessage(r), /15 not measured/);
    assert.doesNotMatch(progressMessage(r), /pending/);
    assert.deepEqual(r.validation, { status: 'invalid', reasons: [reason] });
    // A refusal without its reason, or one claiming measurements, is not accepted.
    const unlabelled = resultSnapshot(m, stage);
    unlabelled.validation = { status: 'unknown', reasons: [] };
    assert.throws(() => validateResult(unlabelled, m, origins), { code: 'INVALID_RESULTS' });
  }
  const measured = resultSnapshot(m, 'complete');
  measured.status = 'rate_limited';
  measured.validation = { status: 'invalid', reasons: ['RATE_LIMITED'] };
  assert.throws(() => validateResult(measured, m, origins), { code: 'INVALID_RESULTS' });
});

test('watch ends on a refusal with exit 8, keeping the refusal in its data', async t => {
  const { placement, id } = await setup(t, { stages: ['rate_limited'] });
  const error = await watch(placement, { test: id }, { timeoutSeconds: 60 }, fakeClock()).then(() => null, e => e);
  assert.equal(error.code, 'MEASUREMENT_UNUSABLE');
  assert.equal(error.exitCode, 8);
  assert.equal(error.data.test.status, 'rate_limited');
});
