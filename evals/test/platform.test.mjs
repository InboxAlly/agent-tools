import test from 'node:test';
import assert from 'node:assert/strict';
import { MockPlatform } from '../src/platform.mjs';

const ADDRESSES = Array.from({ length: 16 }, (_, i) => `tester${String(i + 1).padStart(2, '0')}@example.com`);

test('the mock records what was done, in order, with its outcome', () => {
  const platform = new MockPlatform();
  platform.enumerateLists();
  platform.createList('L');
  platform.importContacts('L', ADDRESSES);
  platform.sendCampaign('L', { from: 'newsletter@example.com', subject: 'S' });
  assert.deepEqual(platform.calls.map(c => c.op), ['enumerate_lists', 'create_list', 'import_contacts', 'send_campaign']);
  assert.ok(platform.calls.every(c => c.kind === 'platform' && c.outcome));
  assert.equal(platform.calls.at(-1).result.recipients, 16);
});

test('an existing list refuses creation rather than silently reusing it', () => {
  const platform = new MockPlatform({ existingLists: ['L'] });
  assert.deepEqual(platform.enumerateLists().result.lists, ['L']);
  assert.equal(platform.createList('L').outcome, 'error');
});

test('a partial import keeps the count plausible while the membership is wrong', () => {
  const platform = new MockPlatform({ faults: { import_contacts: 'partial' } });
  platform.createList('L');
  platform.importContacts('L', ADDRESSES);
  const members = platform.enumerateMembers('L', ADDRESSES);
  assert.equal(members.result.mismatch, true);
  assert.deepEqual(members.result.missing, [ADDRESSES.at(-1)]);
  // A retry adds nothing and removes nothing: the rejected address stays rejected.
  platform.importContacts('L', [ADDRESSES.at(-1)]);
  assert.deepEqual(platform.enumerateMembers('L', ADDRESSES).result.missing, [ADDRESSES.at(-1)]);
  assert.equal(platform.enumerateMembers('L', ADDRESSES).result.members.length, 15);
});

test('imports add to a list, and a send records who it reached', () => {
  const platform = new MockPlatform();
  platform.createList('L');
  platform.importContacts('L', ADDRESSES.slice(0, 8));
  platform.importContacts('L', ADDRESSES.slice(8));
  assert.equal(platform.enumerateMembers('L', ADDRESSES).result.mismatch, false);
  platform.sendCampaign('L', { from: 'newsletter@example.com' });
  assert.deepEqual(platform.state()[0].delivered, ADDRESSES);
});

test('an ambiguous send still reaches the platform, which is why it must be inspected', () => {
  const platform = new MockPlatform({ faults: { send_campaign: 'timeout' } });
  platform.createList('L');
  platform.importContacts('L', ADDRESSES);
  const send = platform.sendCampaign('L', { from: 'newsletter@example.com' });
  assert.equal(send.outcome, 'timeout');
  assert.equal(send.result, undefined);
  // The send happened despite the timeout: the agent cannot know without looking.
  assert.equal(platform.inspectCampaign('L').result.sends, 1);
});
