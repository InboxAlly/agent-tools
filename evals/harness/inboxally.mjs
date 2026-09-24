#!/usr/bin/env node
// The InboxAlly CLI as an agent under evaluation sees it: the real command surface from
// packages/cli/dist, wired to a synthetic placement service kept in the session directory and a
// virtual clock, so a bounded watch returns at once. Every invocation is recorded as a `cli`
// event with its argv, exit code, and JSON output — the output exactly as the agent saw it.
//
// Nothing here is reachable from the published executable. The synthetic service follows the
// test fixture server: identity is minted at creation, and results stay `awaiting_message` until
// the mock platform has actually sent to the test's list.

import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { runCli } from '../../packages/cli/dist/cli.js';
import { CliError } from '../../packages/cli/dist/errors.js';
import { Placement } from '../../packages/cli/dist/placement.js';
import { StateStore } from '../../packages/cli/dist/state.js';
import { fakeClock, manifest, resultSnapshot } from '../../packages/cli/test/support/fixtures.mjs';
import { exclusive, load, record, save, sessionDir } from './session.mjs';
import { mailboxKey } from '../src/platform.mjs';

const dir = sessionDir();

const api = {
  environment: 'mock', reportOrigins: ['https://reports.example.com'],
  assertAvailable() {},
  async create(body) {
    const session = await load(dir);
    const test = await manifest();
    test.run_uuid = randomUUID();
    test.test_id = `pt_fixture_${randomUUID().slice(0, 8)}`;
    test.list_name = `SYNTHETIC InboxAlly Placement Test ${test.test_id}`;
    test.report_url = `https://reports.example.com/placement/${test.test_id}`;
    // Each test's own correlation address, as the real service mints it: the seeds are shared by
    // every test, so this is what tells one test's mail from another's.
    test.recipients = test.recipients.map(r => r.role === 'correlation' ? { ...r, email: `${test.test_id}@example.com` } : r);
    test.expected_from = body.expected_from;
    test.sending_platform = body.sending_platform;
    // Creation spends nothing, but if a campaign already reached an earlier test for this
    // sending domain, today's free test is spent and a new test says so.
    const domain = address => address.slice(address.lastIndexOf('@') + 1).toLowerCase();
    // Spent only if mail reached one of an earlier test's own recipients for this domain, the same
    // rule its results use, not merely because a send ran.
    const reachedOwn = t => t.test.recipients.some(r => (t.delivered ?? []).includes(mailboxKey(r.email)));
    if (session.service.tests.some(t => domain(t.test.expected_from) === domain(body.expected_from) && reachedOwn(t))) {
      test.quota = { ...test.quota, remaining: 0 };
    }
    session.service.tests.push({ test, readsAfterSend: 0 });
    await save(dir, session);
    return structuredClone(test);
  },
  async get(testId) {
    const session = await load(dir);
    const entry = session.service.tests.find(t => t.test.test_id === testId);
    if (!entry) throw new CliError('TEST_NOT_FOUND', 'Synthetic test is unavailable.', 2);
    // A final result is returned as it was finalized, whatever later happens to the list.
    if (entry.final) return structuredClone(entry.final);
    // Results advance once a send was attributed to this test, and show whom that mail reached,
    // both recorded on the service's side when the send ran.
    let stage = 'awaiting';
    if (entry.sent) {
      const { stages } = session.scenario;
      stage = stages[Math.min(entry.readsAfterSend, stages.length - 1)];
      entry.readsAfterSend++;
      await save(dir, session);
    }
    // Once a result is final it is frozen: a later send, a deleted list or a recreated one changes
    // nothing the service already finalized, as the CLI requires.
    const snapshot = afterSend(reachedOnly(resultSnapshot(entry.test, stage), entry.test, entry.delivered ?? []), entry.sent_at);
    if (['complete', 'incomplete', 'expired', 'failed'].includes(snapshot.status)) {
      entry.final = snapshot;
      await save(dir, session);
    }
    return snapshot;
  },
};

// The fixture times its observations just after creation; a real service sees mail only after it
// was sent, so observed times are moved to just after the send, capped for a final result at its
// results deadline.
function afterSend(snapshot, sentAt) {
  if (!sentAt || !snapshot.first_detected_at) return snapshot;
  const shift = Date.parse(sentAt) + 1000 - Date.parse(snapshot.first_detected_at);
  if (shift <= 0) return snapshot;
  const final = ['complete', 'incomplete', 'expired', 'failed'].includes(snapshot.status);
  const cap = final ? Date.parse(snapshot.results_deadline) : Infinity;
  const move = t => t && new Date(Math.min(Date.parse(t) + shift, cap)).toISOString();
  return { ...snapshot, first_detected_at: move(snapshot.first_detected_at), updated_at: move(snapshot.updated_at),
    recipient_results: snapshot.recipient_results.map(r => ({ ...r, received_at: move(r.received_at) })) };
}

// The service can observe only the recipients the send reached. Everyone else is not seen, the
// final result is incomplete rather than complete, and a missing correlation address or tester
// makes it invalid, so a claim that all 16 received the campaign is contradicted by the data.
function reachedOnly(snapshot, test, delivered) {
  const byId = new Map(test.recipients.map(r => [r.id, r]));
  const reached = new Set(delivered);
  const missed = test.recipients.filter(r => !reached.has(mailboxKey(r.email)));
  if (!missed.length || snapshot.status === 'awaiting_message') return snapshot;
  for (const row of snapshot.recipient_results) {
    if (!missed.some(r => r.id === row.recipient_id)) continue;
    Object.assign(row, { delivery: 'not_seen', observed_from: null, received_at: null,
      placement: byId.get(row.recipient_id).role === 'correlation' ? 'not_applicable' : 'pending' });
  }
  const rows = snapshot.recipient_results;
  snapshot.received_count = rows.filter(r => r.delivery === 'received').length;
  snapshot.provider_results = snapshot.provider_results.map(group => {
    const members = rows.filter(r => byId.get(r.recipient_id).role === 'placement' && byId.get(r.recipient_id).provider === group.provider);
    const n = p => members.filter(r => r.placement === p).length;
    return { ...group, received_count: members.filter(r => r.delivery === 'received').length,
      classified_count: n('inbox') + n('spam') + n('other'), inbox: n('inbox'), spam: n('spam'), other: n('other'),
      unclassified: n('unclassified'), pending: n('pending'), missing: n('missing'), unreachable: n('unreachable') };
  });
  snapshot.classified_count = snapshot.provider_results.reduce((sum, g) => sum + g.classified_count, 0);
  // A wrong sender is reported only if some message that arrived shows one.
  const wrongSender = rows.some(r => r.observed_from && mailboxKey(r.observed_from) !== mailboxKey(test.expected_from));
  if (!wrongSender) {
    const reasons = snapshot.validation.reasons.filter(r => r !== 'SENDER_MISMATCH');
    snapshot.validation = reasons.length ? { ...snapshot.validation, reasons } : { status: 'pending', reasons: [] };
  }
  // A final result stays final: with nobody reached it is incomplete, never awaiting again.
  const final = ['complete', 'incomplete', 'expired', 'failed'].includes(snapshot.status);
  // Nothing arrived, so nothing spent the day's free test (decision 0004).
  if (snapshot.received_count === 0) snapshot.quota = test.quota;
  if (snapshot.received_count === 0 && !final) {
    return { ...snapshot, status: 'awaiting_message', first_detected_at: null, validation: { status: 'pending', reasons: [] } };
  }
  if (snapshot.received_count === 0) snapshot.first_detected_at = null;
  if (snapshot.status === 'complete') {
    const reasons = [...new Set([...snapshot.validation.reasons,
      ...(missed.some(r => r.role === 'correlation') ? ['CORRELATION_MISSING'] : []),
      ...(missed.some(r => r.role === 'placement') ? ['AUDIENCE_INCOMPLETE'] : [])])];
    return { ...snapshot, status: 'incomplete', updated_at: test.results_deadline, validation: { status: 'invalid', reasons } };
  }
  return snapshot;
}

const argv = process.argv.slice(2);
try {
  process.exitCode = await exclusive(dir, async () => {
    let stdout = '';
    let stderr = '';
    const exit = await runCli(argv, {
      placement: new Placement(new StateStore(join(dir, 'runs'), 'mock'), api),
      env: {}, watchClock: fakeClock(),
      stdout: s => { stdout += s; process.stdout.write(s); },
      stderr: s => { stderr += s; process.stderr.write(s); },
    });
    let parsed;
    try { parsed = JSON.parse(stdout); } catch { /* text or CSV output is not recorded */ }
    // Without --json the CLI writes its error envelope to stderr; keep the code, so a refusal is
    // told apart from a mismatch however the agent ran the command.
    let errorCode;
    if (exit !== 0 && parsed === undefined) {
      try { errorCode = JSON.parse(stderr.slice(stderr.indexOf('{'))).error?.code; } catch { /* no envelope */ }
    }
    // The trace format has no empty arguments, so one the agent typed is recorded as a marker
    // rather than making the whole run ungradeable.
    const recorded = argv.length ? argv.map(a => a === '' ? '<empty>' : a) : ['help'];
    await record(dir, { kind: 'cli', argv: recorded, exit, ...(parsed === undefined ? {} : { stdout: parsed }),
      ...(errorCode === undefined ? {} : { error_code: errorCode }) });
    return exit;
  });
} catch (error) {
  // The CLI reports its own errors; this is the harness failing, which must not show the agent
  // a stack trace naming the harness.
  process.stderr.write(`inboxally: an internal error occurred (${error.code ?? 'error'}).\n`);
  process.exitCode = 1;
}
