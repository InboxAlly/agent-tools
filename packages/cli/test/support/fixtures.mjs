import { readFile } from 'node:fs/promises';

export async function manifest(now = Date.now()) {
  const wire = JSON.parse(await readFile(new URL('../../../../fixtures/placement.v1/manifest.wire.json', import.meta.url), 'utf8'));
  // Synthetic wire credential deliberately never enters the public projection or state.
  wire.access = { mode: wire.access.mode };
  wire.created_at = new Date(now).toISOString();
  wire.send_before = new Date(now + 3600000).toISOString();
  wire.results_deadline = new Date(now + 7200000).toISOString();
  wire.report_expires_at = new Date(now + 86400000).toISOString();
  wire.quota.reset_at = new Date(now + 86400000).toISOString();
  return wire;
}

export function resultSnapshot(m, stage = 'complete') {
  // A refusal on arrival: the campaign reached the test address, and nothing was measured.
  if (stage === 'rate_limited' || stage === 'free_mail') {
    const base = resultSnapshot(m, 'awaiting');
    const correlation = m.recipients.find(r => r.role === 'correlation');
    const arrived = new Date(Date.parse(m.created_at) + 1000).toISOString();
    base.recipient_results = base.recipient_results.map(row => row.recipient_id === correlation.id
      ? { ...row, delivery: 'received', observed_from: m.expected_from, received_at: arrived } : row);
    return { ...base, status: stage, received_count: 1, first_detected_at: arrived,
      updated_at: new Date(Date.parse(m.created_at) + 2000).toISOString(),
      validation: { status: 'invalid', reasons: [stage === 'rate_limited' ? 'RATE_LIMITED' : 'FREE_MAIL'] } };
  }
  const terminalStage = ['incomplete', 'expired', 'failed'].includes(stage);
  const hasMail = !['awaiting', 'expired', 'failed'].includes(stage);
  const full = ['complete', 'invalid', 'unknown'].includes(stage);
  const delivered = full ? 15 : hasMail ? 8 : 0;
  const first = new Date(Date.parse(m.created_at) + 1000).toISOString();
  const updated = terminalStage ? m.results_deadline : new Date(Date.parse(m.created_at) + (full ? 3000 : hasMail ? 2000 : 0)).toISOString();
  let index = 0;
  const rows = m.recipients.map(recipient => {
    const received = recipient.role === 'correlation' ? hasMail : index++ < delivered;
    const placement = recipient.role === 'correlation' ? 'not_applicable'
      : !received ? 'pending' : stage === 'unclassified' && index === 8 ? 'unclassified'
      : index <= 6 ? 'inbox' : index <= 8 ? 'spam' : 'inbox';
    return {
      recipient_id: recipient.id, delivery: received ? 'received' : 'not_seen', placement,
      observed_from: received ? (stage === 'invalid' ? 'wrong-sender@example.com' : m.expected_from) : null,
      received_at: received ? first : null,
    };
  });
  const providers = [...new Set(m.recipients.filter(r => r.role === 'placement').map(r => r.provider))];
  const provider_results = providers.map(provider => {
    const ids = new Set(m.recipients.filter(r => r.role === 'placement' && r.provider === provider).map(r => r.id));
    const members = rows.filter(r => ids.has(r.recipient_id));
    const n = placement => members.filter(r => r.placement === placement).length;
    return { provider, expected_count: members.length,
      received_count: members.filter(r => r.delivery === 'received').length,
      classified_count: n('inbox') + n('spam') + n('other'),
      inbox: n('inbox'), spam: n('spam'), other: n('other'), unclassified: n('unclassified'), pending: n('pending'), missing: n('missing'), unreachable: n('unreachable'),
    };
  });
  // Creation spends nothing (decision 0004): the free limit is applied when the campaign
  // arrives, so the allowance reads as spent only once mail has been received.
  const quota = m.quota?.mode === 'free' && hasMail ? { ...m.quota, remaining: 0 } : m.quota;
  return {
    ...structuredClone(m),
    quota,
    status: full ? 'complete' : stage === 'awaiting' ? 'awaiting_message' : terminalStage ? stage : 'receiving',
    updated_at: updated, first_detected_at: hasMail ? first : null,
    received_count: rows.filter(r => r.delivery === 'received').length,
    classified_count: provider_results.reduce((sum, p) => sum + p.classified_count, 0),
    recipient_results: rows, provider_results,
    // The proposed placement.v1 fixtures carry no service figures.
    service_summary: null,
    validation: stage === 'invalid' ? { status: 'invalid', reasons: ['SENDER_MISMATCH'] }
      : stage === 'unknown' || stage === 'failed' ? { status: 'unknown', reasons: [] }
      : full ? { status: 'valid', reasons: [] } : { status: 'pending', reasons: [] },
  };
}

export function fakeClock() {
  let elapsed = 0;
  const waits = [];
  return {
    now: () => elapsed,
    async sleep(ms, signal) { signal?.throwIfAborted(); waits.push(ms); elapsed += ms; },
    waits,
  };
}
