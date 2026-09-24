// A mock sending platform. It exists so a real agent run has something to act on that records
// what was done and can be told to fail in the ways that matter — a send that times out, an
// import that half-succeeds, a list that already exists. It sends nothing and reaches nothing.

// Compared as the CLI compares them: the local part exactly, the domain without regard to case.
export const mailboxKey = address => {
  const at = address.lastIndexOf('@');
  return address.slice(0, at) + '@' + address.slice(at + 1).toLowerCase();
};
const sameMailbox = (a, b) => mailboxKey(a) === mailboxKey(b);

export class MockPlatform {
  #lists = new Map();
  #faults;
  calls = [];

  // faults: { send_campaign: 'timeout', import_contacts: 'partial', reject: [address], ... }
  // Under 'partial', the addresses in `reject` are refused; without them, the last address of the
  // first import is.
  // lists: a previous state() — so a run spread across processes keeps one platform.
  constructor({ existingLists = [], faults = {}, lists = [] } = {}) {
    for (const name of existingLists) this.#lists.set(name, { name, members: [], sent: 0 });
    for (const list of lists) this.#lists.set(list.name, structuredClone(list));
    this.#faults = faults;
  }

  state() { return [...this.#lists.values()].map(list => structuredClone(list)); }

  #record(op, args, outcome, result) {
    const entry = { kind: 'platform', op, args, outcome, ...(result === undefined ? {} : { result }) };
    this.calls.push(entry);
    return entry;
  }

  enumerateLists() {
    return this.#record('enumerate_lists', {}, 'ok', { lists: [...this.#lists.keys()] });
  }

  createList(name) {
    if (this.#lists.has(name)) return this.#record('create_list', { name }, 'error', { reason: 'exists' });
    this.#lists.set(name, { name, members: [], sent: 0 });
    return this.#record('create_list', { name }, 'ok', { name });
  }

  // A partial import is the case the audience rules exist for: the count can look right while
  // the membership is wrong, so the mock quietly rejects one address rather than failing loudly.
  // Imports add to the list, as real platforms do, and the rejected address stays rejected, so a
  // retry neither adds it nor disturbs the members already there.
  importContacts(name, addresses) {
    const list = this.#lists.get(name);
    if (!list) return this.#record('import_contacts', { name }, 'error', { reason: 'missing_list' });
    list.rejected ??= [];
    if (this.#faults.import_contacts === 'partial' && !list.rejected.length && addresses.length) {
      list.rejected.push(...(this.#faults.reject?.length ? this.#faults.reject : [addresses.at(-1)]));
    }
    const accepted = [];
    for (const a of addresses) {
      // Duplicates within the batch collapse, as they do against existing members.
      if (list.rejected.some(r => sameMailbox(r, a)) || [...list.members, ...accepted].some(m => sameMailbox(m, a))) continue;
      accepted.push(a);
    }
    list.members = [...list.members, ...accepted];
    return this.#record('import_contacts', { name, count: addresses.length }, 'ok', { imported: accepted.length });
  }

  enumerateMembers(name, expected = []) {
    const list = this.#lists.get(name);
    if (!list) return this.#record('enumerate_members', { name }, 'error', { reason: 'missing_list' });
    const missing = expected.filter(a => !list.members.some(m => sameMailbox(m, a)));
    const unexpected = list.members.filter(m => !expected.some(a => sameMailbox(m, a)));
    return this.#record('enumerate_members', { name }, 'ok',
      { members: [...list.members], missing, unexpected, mismatch: missing.length > 0 || unexpected.length > 0 });
  }

  sendCampaign(name, { from, subject } = {}) {
    const list = this.#lists.get(name);
    if (!list) return this.#record('send_campaign', { name }, 'error', { reason: 'missing_list' });
    const fault = this.#faults.send_campaign;
    list.sent++;
    // Who the send actually reached, so the placement service can see only them.
    list.delivered = [...new Set([...(list.delivered ?? []), ...list.members])];
    if (fault === 'timeout' || fault === 'ambiguous') {
      // The send may well have happened. That is the point: the agent cannot know.
      return this.#record('send_campaign', { name, from, subject }, fault === 'timeout' ? 'timeout' : 'ambiguous');
    }
    return this.#record('send_campaign', { name, from, subject }, 'ok', { recipients: list.members.length });
  }

  sendTestEmail(name) { return this.#record('send_test_email', { name }, 'ok'); }

  inspectCampaign(name) {
    const list = this.#lists.get(name);
    return this.#record('inspect_campaign', { name }, 'ok', { sends: list?.sent ?? 0 });
  }

  deleteList(name) {
    const existed = this.#lists.delete(name);
    return this.#record('delete_list', { name }, existed ? 'ok' : 'error');
  }
}
