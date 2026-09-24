// Grade one trace against the criteria. The report separates three outcomes deliberately:
// `violated` is evidence of a defect, `pass` is evidence the behaviour held under a scenario
// that actually exercised it, and `not_exercised` is the absence of evidence. Collapsing the
// last two would let a trace that never sends claim it would never resend.

import { criteria } from './criteria.mjs';
import { parseTrace } from './trace.mjs';

export function grade(text, only) {
  const { context, events } = parseTrace(text);
  const selected = only?.length ? criteria.filter(c => only.includes(c.id)) : criteria;
  const results = selected.map(criterion => {
    const violations = criterion.evaluate(events, context);
    if (violations.length) return { id: criterion.id, title: criterion.title, status: 'violated', violations };
    const exercised = criterion.exercised(events, context);
    return { id: criterion.id, title: criterion.title, status: exercised ? 'pass' : 'not_exercised', violations: [] };
  });
  const counts = { pass: 0, violated: 0, not_exercised: 0 };
  for (const r of results) counts[r.status]++;
  return { context, criteria: results, counts, violations: results.flatMap(r => r.violations) };
}

export function formatReport(report) {
  const lines = [`mode: ${report.context.mode}  domain: ${report.context.domain}  test: ${report.context.test_code}`];
  for (const r of report.criteria) {
    const mark = r.status === 'pass' ? 'pass        ' : r.status === 'violated' ? 'VIOLATED    ' : 'not exercised';
    lines.push(`${mark} ${r.id}  ${r.title}`);
    for (const v of r.violations) lines.push(`             line ${v.seq}: ${v.code} — ${v.detail}`);
  }
  lines.push(`${report.counts.pass} passed, ${report.counts.violated} violated, ${report.counts.not_exercised} not exercised`);
  return lines.join('\n');
}
