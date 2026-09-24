import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixtureServer } from '../packages/cli/test/support/server.mjs';
import { fakeClock } from '../packages/cli/test/support/fixtures.mjs';
import { Placement } from '../packages/cli/dist/placement.js';
import { StateStore } from '../packages/cli/dist/state.js';
import { runCli } from '../packages/cli/dist/cli.js';

if (process.env.INBOXALLY_API_KEY !== undefined) throw new Error('Remove INBOXALLY_API_KEY before running the isolated synthetic demo.');
const root = await mkdtemp(join(tmpdir(), 'inboxally-synthetic-demo-'));
// Two allocations are expected: the lost response leaves an unnamed test that reserves
// nothing and is never sent to, and the retry allocates the one this client can name.
const server = await fixtureServer({ loseFirstResponse: true, allowance: 2 });
const clock = fakeClock();
let placement = new Placement(new StateStore(join(root, 'runs'), 'mock'), server.api);
async function invoke(args, expectedCode = 0) {
  let stdout = '';
  const code = await runCli(args, { placement, env: {}, watchClock: clock,
    stdout: s => { stdout += s; }, stderr: s => process.stderr.write(s) });
  assert.equal(code, expectedCode);
  return stdout ? JSON.parse(stdout) : null;
}
const restart = () => { placement = new Placement(new StateStore(join(root, 'runs'), 'mock'), server.api); };
async function note(testId, event, evidence, details, expectedCode = 0) {
  const path = join(root, `note-${event}.json`);
  await writeFile(path, JSON.stringify(details));
  return invoke(['placement', 'note', testId, '--event', event, '--evidence', evidence, '--details-file', path, '--json'], expectedCode);
}
// Select the run by its test code: the listing holds more than one run once a second
// intent for the same domain exists.
const currentState = async id => (await invoke(['placement', 'runs', '--json'])).data.runs.find(r => r.test_code === id).state;
try {
  console.log('SYNTHETIC DEMO — example.com addresses; no real test or email send.');
  console.log('Polling uses an explicit virtual clock; production timing is unchanged.');
  const prepared = await invoke(['placement', 'prepare', '--from', 'newsletter@example.com',
    '--platform', 'mailchimp', '--campaign', 'SYNTHETIC campaign', '--label', 'synthetic-newsletter', '--json']);
  assert.equal(prepared.data.domain, 'example.com');
  const lost = await invoke(['placement', 'create', '--label', 'synthetic-newsletter', '--json'], 6);
  assert.equal(lost.error.code, 'ALLOCATION_UNKNOWN');
  console.log('Prepared intent under a label; simulated a lost allocation response.');

  restart();
  // Creation reserves no allowance, so the safe move after a lost response is to create again.
  const created = await invoke(['placement', 'create', '--label', 'synthetic-newsletter', '--json']);
  const testId = created.data.test.test_id;
  const listName = created.data.test.list_name;
  assert.equal(created.data.run_uuid, created.data.test.run_uuid);
  console.log('Restarted client and allocated a named test; identity came from the service.');

  const blocked = await invoke(['placement', 'prepare', '--from', 'offers@example.com',
    '--platform', 'mailchimp', '--campaign', 'SYNTHETIC second campaign', '--json']);
  const second = await invoke(['placement', 'create', '--request', blocked.data.local_request_id, '--json'], 5);
  assert.equal(second.error.code, 'DOMAIN_RUN_ACTIVE');
  console.log('Refused a second live address list for the same sending domain.');

  const exportPath = join(root, 'recipients.csv');
  await invoke(['placement', 'recipients', testId, '--format', 'csv', '--output', exportPath]);
  // The CLI's own export always matches, so verifying it proves nothing and is refused.
  const self = await invoke(['placement', 'verify', testId, '--recipients-file', exportPath, '--json'], 5);
  assert.equal(self.error.code, 'VERIFY_SELF_COMPARISON');
  // Stands in for the sending platform's export of the list's members after the import: the
  // platform's own format and order, not a copy of the CLI's export.
  const membersPath = join(root, 'platform-members.csv');
  const members = (await readFile(exportPath, 'utf8')).trim().split(/\r?\n/).slice(1).map(a => a.replaceAll('"', '')).reverse();
  await writeFile(membersPath, ['email,status', ...members.map(a => `${a},subscribed`)].join('\n') + '\n');
  // Selected by sending domain: the unallocated second intent is not a candidate.
  const verified = await invoke(['placement', 'verify', '--domain', 'example.com', '--recipients-file', membersPath, '--json']);
  assert.equal(verified.data.matches, true);
  console.log('Exported CSV; refused to verify the export against itself; verified the platform members, selected by sending domain.');

  await note(testId, 'awaiting_import_approval', 'tool_observed', { platform: 'mailchimp', workspace_label: 'SYNTHETIC workspace', list_name: listName, recipient_count: 16 });
  await note(testId, 'import_approved', 'user_reported', { list_name: listName, recipient_count: 16 });
  restart();
  assert.equal(await currentState(testId), 'import_outcome_unknown');
  console.log('Recorded import approval; after a restart the run says the import outcome must be inspected first.');
  await note(testId, 'import_verified', 'tool_observed', { esp_object_id: 'SYNTHETIC_list_1', recipient_count: 16 });
  await note(testId, 'awaiting_send_approval', 'tool_observed', {});
  const wrongSender = await note(testId, 'send_approved', 'user_reported',
    { from: 'other-sender@example.com', subject: 'SYNTHETIC subject', list_name: listName, recipient_count: 16 }, 5);
  assert.equal(wrongSender.error.code, 'APPROVAL_MISMATCH');
  await note(testId, 'send_approved', 'user_reported', { from: 'newsletter@example.com', subject: 'SYNTHETIC subject', list_name: listName, recipient_count: 16 });
  restart();
  assert.equal(await currentState(testId), 'send_outcome_unknown');
  console.log('Rejected a send approval for a different sender; accepted the matching one; after a restart the send outcome is unknown, never resent.');
  await note(testId, 'send_confirmed', 'tool_observed', { esp_object_id: 'SYNTHETIC_campaign_1', observed_at: new Date().toISOString() });

  const awaiting = await invoke(['placement', 'status', testId, '--json']);
  assert.equal(awaiting.data.test.status, 'awaiting_message');
  restart();
  const completed = await invoke(['placement', 'watch', testId, '--timeout', '60', '--json']);
  assert.equal(completed.data.test.status, 'complete');
  assert.equal(completed.data.test.classified_count, 15);
  // Two tests exist server-side: the unnamed one from the lost response, and the one this
  // client named. Only one was ever shown to a user, and only one can be sent to.
  assert.equal(server.metrics.allocations, 2);
  assert.equal((await invoke(['placement', 'runs', '--json'])).data.runs.filter(r => r.test_code).length, 1);
  await note(testId, 'done', 'tool_observed', { note: 'SYNTHETIC results explained; list left in place.' });
  assert.equal(await currentState(testId), 'done');
  console.log(JSON.stringify({ synthetic: true, status: completed.data.test.status, workflow_state: await currentState(testId),
    validity: completed.data.test.validation.status,
    required_send_recipients: completed.data.test.recipient_count,
    received_count: completed.data.test.received_count,
    classified_placement_recipients: completed.data.test.classified_count,
    provider_results: completed.data.test.provider_results,
    virtual_poll_waits_ms: clock.waits, fixture_metrics: server.metrics }, null, 2));
} finally {
  await server.close();
  await rm(root, { recursive: true, force: true });
}
