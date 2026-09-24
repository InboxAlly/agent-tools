import { z } from "zod";
import { CliError } from "./errors.js";
import { mailbox, mailboxKey, manifestSchema, text, validateManifest, type Manifest } from "./manifest.js";

const count = z.number().int().min(0).max(16);
// A percentage as the service rounds it; null when there is nothing to divide by.
const rate = z.number().int().min(0).max(100).nullable();
// A seed the service checked and did not find is `missing`; one it could not check is
// `unreachable`; `pending` is only a seed not yet checked.
const placements = ["pending", "inbox", "spam", "other", "unclassified", "not_applicable", "missing", "unreachable"] as const;
export const resultFieldsSchema = z.object({
  // rate_limited and free_mail are refusals decided when the campaign arrives: the send happened,
  // but nothing was measured for it.
  status: z.enum(["awaiting_message", "receiving", "complete", "incomplete", "expired", "failed", "rate_limited", "free_mail"]),
  updated_at: z.iso.datetime(),
  first_detected_at: z.iso.datetime().nullable(),
  received_count: count,
  classified_count: count,
  recipient_results: z.array(z.object({
    recipient_id: text,
    delivery: z.enum(["not_seen", "received", "bounced", "unknown"]),
    placement: z.enum(placements),
    observed_from: mailbox.nullable(),
    received_at: z.iso.datetime().nullable(),
  })).length(16),
  provider_results: z.array(z.object({
    provider: text, expected_count: count, received_count: count, classified_count: count,
    inbox: count, spam: count, other: count, unclassified: count, pending: count, missing: count, unreachable: count,
  })).min(1).max(16),
  validation: z.object({
    status: z.enum(["pending", "valid", "invalid", "unknown"]),
    reasons: z.array(z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/)).max(32),
  }),
  // The service's own verdict and figures for a finished measurement, to quote rather than
  // recompute. Null until the measurement is final, and for a refusal, expiry or failure. Its
  // counts must reconcile with the rows; `missing` counts every seed not found or not yet checked,
  // and `scored_total` leaves out the seeds the service could not check.
  // For a result refused as rate limited: when the domain may test again, as the service gives it.
  retry_after: z.iso.datetime().optional(),
  service_summary: z.object({
    label: z.string().min(1).max(64).regex(/^[\p{L}\p{N} .,'&()-]+$/u).nullable(),
    level: z.enum(["success", "warning", "danger", "info"]).nullable(),
    inbox_rate: rate,
    delivery_rate: rate,
    counts: z.object({ inbox: count, spam: count, missing: count, unreachable: count }),
    scored_total: count,
    by_provider: z.array(z.object({ provider: text, inbox: count, spam: count, missing: count, total: count, inbox_rate: rate })).max(16),
  }).nullable(),
});

// Provisional normalized projection, not the existing Python wire shape.
export const resultSchema = manifestSchema.extend(resultFieldsSchema.shape);

// Snapshots saved by run files before version 6: no missing or unreachable placement, and no
// counts for them. Kept only so older run files still load and upgrade.
export const legacyResultSchema = manifestSchema.extend({
  ...resultFieldsSchema.omit({ service_summary: true }).shape,
  recipient_results: z.array(resultFieldsSchema.shape.recipient_results.element.extend({
    placement: z.enum(["pending", "inbox", "spam", "other", "unclassified", "not_applicable"]),
  })).length(16),
  provider_results: z.array(resultFieldsSchema.shape.provider_results.element.omit({ missing: true, unreachable: true })).min(1).max(16),
});
type LegacyResult = z.infer<typeof legacyResultSchema>;

// Upgrade a legacy snapshot to what a fresh read of the same data now gives, so the two compare
// equal. Only the free-tier transport (production) distinguished these seeds: there, a seed the
// service could not check (delivery unknown) is unreachable, and one still unseen when the service
// completed the measurement is missing. Anything else keeps its placement.
export function upgradeSnapshot(s: LegacyResult, environment: string): Result {
  const completed = environment === "production" && ["complete", "incomplete"].includes(s.status);
  const recipient_results = s.recipient_results.map(item => environment !== "production" || item.placement !== "pending" ? item
    : item.delivery === "unknown" ? { ...item, placement: "unreachable" as const }
    : item.delivery === "not_seen" && completed ? { ...item, placement: "missing" as const } : item);
  const provider = new Map(s.recipients.map(recipient => [recipient.id, recipient.provider]));
  const provider_results = s.provider_results.map(group => {
    const rows = recipient_results.filter(item => provider.get(item.recipient_id) === group.provider);
    const n = (p: string) => rows.filter(item => item.placement === p).length;
    return { ...group, pending: n("pending"), missing: n("missing"), unreachable: n("unreachable") };
  });
  return { ...s, recipient_results, provider_results, service_summary: null };
}

// Whether the service's figures agree with the rows they summarize. The adapter drops figures that
// do not; the validator refuses a snapshot that carries them.
export function summaryFits(r: Pick<Result, "status" | "provider_results" | "expected_placement_count">, summary: NonNullable<Result["service_summary"]>): boolean {
  if (!["complete", "incomplete"].includes(r.status)) return false;
  const sum = (key: "inbox" | "spam" | "missing" | "pending" | "unreachable") => r.provider_results.reduce((total, g) => total + g[key], 0);
  const { inbox, spam, missing, unreachable } = summary.counts;
  if (inbox !== sum("inbox") || spam !== sum("spam") || missing !== sum("missing") + sum("pending") || unreachable !== sum("unreachable")) return false;
  if (summary.scored_total !== r.expected_placement_count - unreachable || inbox + spam + missing !== summary.scored_total) return false;
  if (!rateFits(summary.inbox_rate, inbox, summary.scored_total) || !rateFits(summary.delivery_rate, inbox + spam, summary.scored_total)) return false;
  const groups = new Map(r.provider_results.map(g => [g.provider, g]));
  if (summary.by_provider.length !== new Set(summary.by_provider.map(p => p.provider)).size) return false;
  for (const p of summary.by_provider) {
    const g = groups.get(p.provider);
    if (!g || p.inbox !== g.inbox || p.spam !== g.spam || p.missing !== g.missing + g.pending || p.total !== g.expected_count - g.unreachable) return false;
    if (p.inbox + p.spam + p.missing !== p.total) return false;
    if (!rateFits(p.inbox_rate, p.inbox, p.total)) return false;
  }
  // A provider whose every seed was unreachable may be left out; any other must be listed.
  return !r.provider_results.some(g => g.expected_count > g.unreachable && !summary.by_provider.some(p => p.provider === g.provider));
}

// A rate is consistent with its counts under any rounding the service might use.
const rateFits = (rate: number | null, part: number, whole: number): boolean =>
  whole === 0 ? rate === null || rate === 0 : rate !== null && Math.abs(rate - (100 * part) / whole) < 1;
export type Result = z.infer<typeof resultSchema>;
export type PublicTest = Manifest | Result;
export const terminal = (r: Result): boolean => ["complete", "incomplete", "expired", "failed", "rate_limited", "free_mail"].includes(r.status);
// A refusal is never a measurement, so it always carries its reason as invalid.
const refusalReason: Partial<Record<Result["status"], string>> = { rate_limited: "RATE_LIMITED", free_mail: "FREE_MAIL" };

function immutable(m: Manifest): string {
  // run_uuid is excluded deliberately: reads resolve to the most recent run, and that case
  // is reported as a supersession rather than as a corrupted measurement.
  const { quota: _quota, poll_after_seconds: _poll, run_uuid: _run, ...fixed } = manifestSchema.parse(m);
  return JSON.stringify({ ...fixed, recipients: [...fixed.recipients].sort((a, b) => a.id.localeCompare(b.id)) });
}
function measurement(r: Result, withSummary = true): string {
  // retry_after is advice about the domain, not part of the measurement.
  const { updated_at: _updated, retry_after: _retry, service_summary, ...parsed } = resultFieldsSchema.parse(r);
  const fields = withSummary ? { ...parsed, service_summary } : parsed;
  return JSON.stringify({ ...fields,
    recipient_results: [...fields.recipient_results].sort((a, b) => a.recipient_id.localeCompare(b.recipient_id)),
    provider_results: [...fields.provider_results].sort((a, b) => a.provider.localeCompare(b.provider)),
  });
}

export function validateResult(raw: unknown, manifest: Manifest, origins: readonly string[], previous?: Result): Result {
  const fail = (message = "The result snapshot is inconsistent with the saved test."): never => {
    throw new CliError("INVALID_RESULTS", message, 5);
  };
  validateManifest(raw, origins, { expected_from: manifest.expected_from, sending_platform: manifest.sending_platform }, manifest.test_id);
  const parsed = resultSchema.safeParse(raw);
  if (!parsed.success) return fail();
  const r = parsed.data;
  if (immutable(r) !== immutable(manifest)) return fail("The server changed the allocated manifest. Stop and preserve this run.");
  if (Date.parse(r.updated_at) < Date.parse(r.created_at)) return fail();
  if (r.first_detected_at !== null && (Date.parse(r.first_detected_at) < Date.parse(r.created_at) || Date.parse(r.first_detected_at) > Date.parse(r.updated_at))) return fail();
  if ((r.received_count === 0) !== (r.first_detected_at === null)) return fail();
  const recipients = new Map(manifest.recipients.map(item => [item.id, item]));
  const seen = new Set<string>();
  let received = 0, classified = 0, senderMismatch = false;
  const groups = new Map<string, Result["provider_results"][number]>();
  for (const item of r.recipient_results) {
    const recipient = recipients.get(item.recipient_id);
    if (!recipient || seen.has(item.recipient_id)) return fail();
    seen.add(item.recipient_id);
    if (item.delivery === "received") received++;
    if (item.received_at !== null) {
      if (item.delivery !== "received" || r.first_detected_at === null ||
          Date.parse(item.received_at) < Date.parse(r.first_detected_at) || Date.parse(item.received_at) > Date.parse(r.updated_at)) return fail();
    }
    if (item.observed_from !== null) {
      if (item.delivery !== "received") return fail();
      if (mailboxKey(item.observed_from) !== mailboxKey(manifest.expected_from)) senderMismatch = true;
    }
    if (recipient.role === "correlation") {
      if (item.placement !== "not_applicable") return fail();
      continue;
    }
    if (item.placement === "not_applicable") return fail();
    if (["inbox", "spam", "other", "unclassified"].includes(item.placement) && item.delivery !== "received") return fail();
    // Missing is a finding of a finished measurement; before that an unseen seed is pending.
    if (item.placement === "missing" && (item.delivery !== "not_seen" || !["complete", "incomplete"].includes(r.status))) return fail();
    if (item.placement === "unreachable" && item.delivery !== "unknown") return fail();
    const group = groups.get(recipient.provider) ?? { provider: recipient.provider, expected_count: 0,
      received_count: 0, classified_count: 0, inbox: 0, spam: 0, other: 0, unclassified: 0, pending: 0, missing: 0, unreachable: 0 };
    group.expected_count++;
    if (item.delivery === "received") group.received_count++;
    group[item.placement]++;
    if (["inbox", "spam", "other"].includes(item.placement)) { classified++; group.classified_count++; }
    groups.set(recipient.provider, group);
  }
  if (received !== r.received_count || classified !== r.classified_count) return fail();
  if (groups.size !== r.provider_results.length) return fail();
  for (const provided of r.provider_results) {
    const expected = groups.get(provided.provider);
    if (!expected || Object.keys(expected).some(key => expected[key as keyof typeof expected] !== provided[key as keyof typeof provided])) return fail();
    groups.delete(provided.provider);
  }
  const fullyObserved = received >= r.expected_observation_count && classified === r.expected_placement_count;
  if (r.status === "complete" && !fullyObserved) return fail();
  if (r.status === "incomplete" && fullyObserved) return fail();
  if (["awaiting_message", "expired"].includes(r.status) && received !== 0) return fail();
  if (r.status === "receiving" && received === 0) return fail();
  if (r.validation.status === "invalid" && r.validation.reasons.length === 0) return fail();
  const refusal = refusalReason[r.status];
  if (refusal && !(r.validation.status === "invalid" && r.validation.reasons.includes(refusal) && classified === 0)) return fail();
  if (r.validation.status === "valid" && r.validation.reasons.length > 0) return fail();
  if (senderMismatch && !(r.validation.status === "invalid" && r.validation.reasons.includes("SENDER_MISMATCH"))) return fail();
  if (r.retry_after !== undefined && r.status !== "rate_limited") return fail();
  // Only a finished measurement carries the service's figures, and they must agree with the rows.
  if (r.service_summary !== null && !summaryFits(r, r.service_summary)) return fail();
  if (previous) {
    if (Date.parse(r.updated_at) < Date.parse(previous.updated_at)) return fail("The service returned an older result snapshot.");
    if (r.received_count < previous.received_count || r.classified_count < previous.classified_count) return fail();
    // Seeds sit in different providers' mailboxes and can be reported out of order, so the first
    // detection may move earlier as late reports arrive. It may never move later.
    if (previous.first_detected_at !== null && (r.first_detected_at === null || Date.parse(r.first_detected_at) > Date.parse(previous.first_detected_at))) return fail();
    const prior = new Map(previous.recipient_results.map(item => [item.recipient_id, item]));
    for (const current of r.recipient_results) {
      const old = prior.get(current.recipient_id)!;
      if (old.delivery === "received" && current.delivery !== "received") return fail();
      if (["inbox", "spam", "other"].includes(old.placement) && !["inbox", "spam", "other"].includes(current.placement)) return fail();
    }
    // A snapshot saved before summaries existed may gain one; once present, it is final too.
    const withSummary = previous.service_summary !== null;
    if (terminal(previous) && measurement(r, withSummary) !== measurement(previous, withSummary)) return fail("The service changed a finalized measurement.");
  }
  return r;
}

export function progressMessage(r: Result): string {
  const inbox = r.provider_results.reduce((sum, g) => sum + g.inbox, 0);
  const spam = r.provider_results.reduce((sum, g) => sum + g.spam, 0);
  const other = r.provider_results.reduce((sum, g) => sum + g.other, 0);
  const unclassified = r.provider_results.reduce((sum, g) => sum + g.unclassified, 0);
  const missing = r.provider_results.reduce((sum, g) => sum + g.missing, 0);
  const unreachable = r.provider_results.reduce((sum, g) => sum + g.unreachable, 0);
  return r.status + ": " + r.classified_count + "/" + r.expected_placement_count + " placement recipients classified; " +
    inbox + " inbox, " + spam + " spam, " + other + " other, " + unclassified + " unclassified, " +
    missing + " missing, " + unreachable + " unreachable, " +
    // A final result will classify nothing more, so what is left is not measured, not pending.
    (r.expected_placement_count - r.classified_count - unclassified - missing - unreachable) + (terminal(r) ? " not measured" : " pending") + ". Validity: " + r.validation.status + ".";
}
