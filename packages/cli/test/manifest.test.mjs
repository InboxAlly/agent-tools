import test from 'node:test';
import assert from 'node:assert/strict';
import { validateManifest } from '../dist/manifest.js';
import { exportRecipients, parseRecipients, verifyRecipients } from '../dist/recipients.js';
import { manifest } from './support/fixtures.mjs';

const origins = ['https://reports.example.com'];
test('synthetic manifest preserves all 16 recipients and separate placement denominator', async () => {
  const m = validateManifest(await manifest(), origins);
  assert.equal(m.recipient_count, 16);
  assert.equal(m.expected_placement_count, 15);
  assert.equal(m.recipients.at(-1).role, 'correlation');
  for (const format of ['text', 'csv']) assert.equal(verifyRecipients(m, parseRecipients(exportRecipients(m, format))).matches, true);
  assert.equal(JSON.parse(exportRecipients(m, 'json')).length, 16);
});

test('invalid manifests stop before use, including credentials in public projection', async () => {
  const cases = [
    m => m.recipients.pop(),
    m => m.recipients.push(m.recipients[0]),
    m => m.recipients[1].email = m.recipients[0].email.replace('example.com', 'EXAMPLE.COM'),
    m => m.recipients[1].id = m.recipients[0].id,
    m => m.recipients[0].role = 'new_unknown_role',
    m => m.expected_placement_count = 16,
    m => m.report_url = 'https://reports.example.com.evil.test/report',
    m => m.report_url = 'https://secret@reports.example.com/report',
    m => m.list_name = 'unsafe\u001b[31m',
    m => m.send_before = m.created_at,
    m => m.contract_version = 'placement.v2',
    m => m.access.read_token = 'secret-sentinel',
  ];
  for (const mutate of cases) {
    const m = await manifest(); mutate(m);
    assert.throws(() => validateManifest(m, origins), { code: 'INVALID_MANIFEST' });
  }
});

test('sender/platform/test identity mismatches are rejected', async () => {
  const m = await manifest();
  assert.throws(() => validateManifest(m, origins, { expected_from: 'wrong@example.com', sending_platform: 'mailchimp' }), { code: 'INVALID_MANIFEST' });
  assert.throws(() => validateManifest(m, origins, undefined, 'different-run'), { code: 'INVALID_MANIFEST' });
});

test('equal count with a different member fails and duplicates remain visible', async () => {
  const m = await manifest();
  const actual = m.recipients.map(r => r.email);
  actual[0] = 'unexpected@example.com';
  const result = verifyRecipients(m, actual);
  assert.equal(result.actual_count, 16);
  assert.equal(result.matches, false);
  assert.deepEqual(result.missing, ['tester01@example.com']);
  assert.deepEqual(result.unexpected, ['unexpected@example.com']);
  actual[0] = actual[1];
  assert.deepEqual(verifyRecipients(m, actual).duplicates, ['tester02@example.com']);
  assert.throws(() => parseRecipients('email,email\na@example.com,b@example.com'), { code: 'INVALID_RECIPIENT_FILE' });
  assert.throws(() => parseRecipients('email,name\na@example.com'), { code: 'INVALID_RECIPIENT_FILE' });
});

test('expired send window prevents export without invalidating stored manifest', async () => {
  const m = validateManifest(await manifest(Date.now() - 10800000), origins);
  assert.throws(() => exportRecipients(m, 'csv'), { code: 'SEND_WINDOW_EXPIRED' });
});
