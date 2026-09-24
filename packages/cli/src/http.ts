import { z } from "zod";
import { CliError } from "./errors.js";
import { mailbox, mailboxKey, PRODUCTION_REPORT_ORIGIN, type CreateBody, type Manifest } from "./manifest.js";
import { summaryFits, type Result } from "./results.js";
import type { ReadContext } from "./placement.js";

// The free-tier transport to the placement service, built against the contract the client derived
// (docs/placement-service-contract.md, decision 0006). It translates the service's responses into
// the CLI's own projection, which the existing validators then check, so everything downstream —
// recovery, audience comparison, the journal — is unchanged. Anything outside the derived shape
// is an error that preserves the run, never a guess.

export const SERVICE_ORIGIN = "https://ipt.inboxally.com";
// The InboxAlly app's guest report page, which needs no login and follows the test live. The
// service returns no link; the CLI builds it from the test code and run UUID, as the app does.
export const REPORT_ORIGIN = PRODUCTION_REPORT_ORIGIN;
export const reportUrl = (testCode: string, uuid: string): string =>
  `${REPORT_ORIGIN}/placement-report/${encodeURIComponent(testCode)}/${encodeURIComponent(uuid)}`;
// An anonymous test needs the campaign within this long of its creation.
export const SEND_DEADLINE_MINUTES = 10;
// Slack after the measurement window before the service finalizes a test.
const FINALIZE_GRACE_MINUTES = 5;
const REQUEST_TIMEOUT_MS = 20000;
// After a lost create, wait longer than the request timeout before replaying the UUID, so the
// replay rarely overlaps a first request the service is still processing.
const REPLAY_DELAY_MS = REQUEST_TIMEOUT_MS + 5000;
const RESPONSE_LIMIT = 1024 * 1024;
const POLL_SECONDS = 15;

const iso = z.iso.datetime({ offset: true });
const statuses = ["pending", "processing", "completed", "expired", "failed", "rate_limited", "free_mail"] as const;
const placements = ["inbox", "spam", "junk", "missing", "error"] as const;

const createSchema = z.object({
  testCode: z.string().min(1).max(64),
  emailAddress: mailbox,
  uuid: z.uuid(),
  seedAddresses: z.array(mailbox).length(15),
  status: z.enum(statuses),
  // The service's own deadlines, when it states them. A service that predates them omits them;
  // `expiresAt` is null once the campaign has arrived.
  expiresAt: iso.nullable().optional(),
  sentinelWaitMinutes: z.number().int().positive().max(10080).nullable().optional(),
  maxMeasurementMinutes: z.number().int().positive().max(1440).nullable().optional(),
});

const rowSchema = z.object({
  provider: z.string().min(1).max(64).nullable(),
  seedEmail: mailbox,
  placement: z.enum(placements).nullable(),
  detectedAt: iso.nullable(),
});

// The service reports the sender as the From header gave it: a bare address, or a display name
// followed by the address in angle brackets. Only the address is kept; the display name is
// untrusted text and is never shown or stored.
const sender = z.string().max(1024).transform((value, ctx) => {
  // The address is the last angle-bracketed part, which may be followed only by a comment; a
  // quoted display name can itself contain angle brackets.
  const named = /<([^<>]+)>\s*(?:\([^()]*\)\s*)?$/.exec(value);
  const address = (named ? named[1]! : value).trim();
  if (!mailbox.safeParse(address).success) {
    ctx.addIssue({ code: "custom", message: "not a sender address" });
    return z.NEVER;
  }
  return address;
});

// The service's own verdict and figures. Parsed loosely: a shape the CLI does not recognise costs
// the summary, never the measurement. The subtitle is prose and is not kept.
// Whole percentages, as the service reports them; anything else is a shape the CLI does not know.
const percent = z.number().int().min(0).max(100).nullable();
const tally = z.number().int().min(0).max(16);
const summarySchema = z.object({
  verdict: z.object({ label: z.string(), level: z.string().nullable().optional(), inboxRate: percent, deliveryRate: percent }),
  stats: z.object({
    counts: z.object({ inbox: tally, spam: tally, missing: tally, error: tally }),
    scoredTotal: tally,
    byProvider: z.array(z.object({ provider: z.string().min(1).max(64), inbox: tally, spam: tally, missing: tally, total: tally, inboxRate: percent })).max(16),
  }),
});
const safeLabel = /^[\p{L}\p{N} .,'&()-]{1,64}$/u;
const levels = ["success", "warning", "danger", "info"] as const;
function toSummary(raw: unknown): unknown {
  const parsed = summarySchema.safeParse(raw);
  if (!parsed.success) return null;
  const { verdict, stats } = parsed.data;
  return {
    label: safeLabel.test(verdict.label) ? verdict.label : null,
    level: (levels as readonly string[]).includes(verdict.level ?? "") ? verdict.level : null,
    inbox_rate: verdict.inboxRate, delivery_rate: verdict.deliveryRate,
    counts: { inbox: stats.counts.inbox, spam: stats.counts.spam, missing: stats.counts.missing, unreachable: stats.counts.error },
    scored_total: stats.scoredTotal,
    by_provider: stats.byProvider.map(p => ({ provider: p.provider.toLowerCase(), inbox: p.inbox, spam: p.spam, missing: p.missing, total: p.total, inbox_rate: p.inboxRate })),
  };
}

const retryAfter = (rateLimit: unknown): string | null => {
  const parsed = z.object({ retryAfter: iso }).loose().safeParse(rateLimit);
  return parsed.success ? parsed.data.retryAfter : null;
};

const resultsSchema = z.object({
  testCode: z.string().min(1).max(64),
  uuid: z.uuid(),
  emailAddress: mailbox,
  status: z.enum(statuses),
  fromEmail: sender.nullable(),
  createdAt: iso,
  emailReceivedAt: iso.nullable(),
  serverNow: iso,
  testWindowMinutes: z.number().int().positive().max(1440),
  seedAddresses: z.array(mailbox).length(15),
  results: z.array(rowSchema).length(15),
  // Kept whole for the summary, which parses it on its own terms.
  verdict: z.unknown().optional(),
  // Only the time a refused domain may test again, read on its own terms below; the service's
  // hint is never relayed.
  rateLimit: z.unknown().optional(),
  // The service's deadlines, if a read states them, for a run adopted from a read.
  expiresAt: iso.nullable().optional(),
  sentinelWaitMinutes: z.number().int().positive().max(10080).nullable().optional(),
  maxMeasurementMinutes: z.number().int().positive().max(1440).nullable().optional(),
  stats: z.unknown().optional(),
});
export type ServiceResults = z.infer<typeof resultsSchema>;

const drift = (what: string): never => {
  throw new CliError("INVALID_RESULTS", `The placement service returned ${what} outside the derived contract. Stop and preserve this run.`, 5);
};
const toIso = (ms: number): string => new Date(ms).toISOString();

// The list name is the client's own; the service provides none.
export const listName = (testCode: string): string => `InboxAlly Placement Test ${testCode}`;

// A manifest for a new test, built from the create response and the first results read, which
// already lists every bound seed with its provider. Deadlines come from the service's clock,
// shifted onto the local one by the difference `serverNow` shows.
export function toManifest(created: z.infer<typeof createSchema>, first: ServiceResults, body: CreateBody, localNow: number): Manifest {
  if (first.uuid !== created.uuid || first.testCode !== created.testCode) drift("a first read for a different test");
  const providers = new Map(first.results.map(r => [mailboxKey(r.seedEmail), (r.provider ?? "unknown").toLowerCase()]));
  // Every service time is put on the local clock by the offset `serverNow` shows at creation, so
  // the deadlines compare with the local clock and with each other on one scale. `localNow` is
  // taken before the request, so the time in transit makes the offset, and every deadline, early
  // rather than late.
  const offset = localNow - Date.parse(first.serverNow);
  const createdLocal = Date.parse(first.createdAt) + offset;
  const created_at = toIso(createdLocal);
  // The send deadline is the service's own wait deadline when it states one; a service that does
  // not, and still waits only ten minutes, gets the CLI's own rule.
  const wait = created.expiresAt ? Date.parse(created.expiresAt) + offset
    : created.sentinelWaitMinutes ? createdLocal + created.sentinelWaitMinutes * 60000
    : createdLocal + SEND_DEADLINE_MINUTES * 60000;
  const sendBefore = wait;
  // Arrivals can extend the measurement up to the service's cap, so results are awaited that long.
  // Never shorter than the stated window, whatever the cap says.
  const measuring = Math.max(created.maxMeasurementMinutes ?? 0, first.testWindowMinutes);
  return {
    contract_version: "placement.v1",
    test_id: created.testCode,
    created_at,
    expected_from: body.expected_from,
    sending_platform: body.sending_platform,
    list_name: listName(created.testCode),
    recipient_count: 16,
    recipients: [
      ...created.seedAddresses.map((email, i) => ({
        id: `s${String(i + 1).padStart(2, "0")}`, email, role: "placement" as const,
        provider: providers.get(mailboxKey(email)) ?? "unknown",
      })),
      { id: "c16", email: created.emailAddress, role: "correlation" as const, provider: "inboxally" },
    ],
    expected_observation_count: 16,
    expected_placement_count: 15,
    report_url: reportUrl(created.testCode, created.uuid),
    send_before: toIso(sendBefore),
    results_deadline: toIso(sendBefore + (measuring + FINALIZE_GRACE_MINUTES) * 60000),
    report_expires_at: null,
    poll_after_seconds: POLL_SECONDS,
    quota: null,
    access: { mode: "anonymous" },
    run_uuid: created.uuid,
  };
}

// A results read, translated onto the saved manifest. Rows are matched by seed address. The
// service's `completed` means the window closed, not that every seed was seen, so a completion
// with unseen seeds is `incomplete`. Validity is the client's call, from the data: a wrong sender
// is invalid, a refusal is invalid with its reason, a full measurement is valid, and anything
// else is not yet known.
type PreviousRead = { run_uuid: string; first_detected_at: string | null; recipient_results: { recipient_id: string; received_at: string | null }[]; service_summary?: unknown };

export function toResult(res: ServiceResults, m: Manifest, localNow: number, previous?: PreviousRead): unknown {
  // For the saved run, the same offset the manifest used: its created_at is the service's
  // createdAt on the local clock. Whether a later run keeps the test's createdAt or has its own is
  // not established, so a later run is shifted by the offset this read's serverNow shows instead.
  const offset = res.uuid === m.run_uuid ? Date.parse(m.created_at) - Date.parse(res.createdAt) : localNow - Date.parse(res.serverNow);
  const utc = (value: string): string => toIso(Date.parse(value) + offset);
  // A seed's arrival time, once recorded for this run, is kept. A later run's offset moves a little
  // with every read, and a finalized measurement must read back identically.
  const sameRead = previous?.run_uuid === res.uuid ? previous : undefined;
  const kept = new Map((sameRead?.recipient_results ?? []).map(r => [r.recipient_id, r.received_at]));
  const at = (id: string, value: string): string => kept.get(id) ?? utc(value);
  // The seeds are a shared pool, so they cannot tell tests apart: the test's code and own address
  // must be the saved test's, or this read belongs to another test.
  const own = m.recipients.find(r => r.role === "correlation")!;
  if (res.testCode !== m.test_id || mailboxKey(res.emailAddress) !== mailboxKey(own.email)) drift("a read of a different test");
  const bySeed = new Map(res.results.map(r => [mailboxKey(r.seedEmail), r]));
  const sameAudience = m.recipients.filter(r => r.role === "placement").every(r => bySeed.has(mailboxKey(r.email)));
  if (!sameAudience) drift("a run whose seeds differ from the saved test");
  const received = (at: string | null) => at !== null;
  const rows = m.recipients.map(recipient => {
    if (recipient.role === "correlation") {
      const arrived = received(res.emailReceivedAt);
      return { recipient_id: recipient.id, delivery: arrived ? "received" : "not_seen", placement: "not_applicable",
        observed_from: arrived ? res.fromEmail : null, received_at: arrived ? at(recipient.id, res.emailReceivedAt!) : null };
    }
    const row = bySeed.get(mailboxKey(recipient.email))!;
    const seen = row.placement === "inbox" || row.placement === "spam" || row.placement === "junk";
    return {
      recipient_id: recipient.id,
      delivery: seen ? "received" : row.placement === "error" ? "unknown" : "not_seen",
      // A seed is missing only in a measurement the service completed, where its own figures count
      // every seed not found, reported or not; in any other state an unseen seed is pending. The
      // upgrade of older snapshots applies the same rule, so the two always agree.
      placement: row.placement === "inbox" ? "inbox" : seen ? "spam" : row.placement === "error" ? "unreachable"
        : res.status === "completed" ? "missing" : "pending",
      observed_from: seen ? res.fromEmail : null,
      // A seed seen without its own timestamp takes the campaign's arrival, which never moves.
      received_at: seen ? (row.detectedAt ? at(recipient.id, row.detectedAt) : res.emailReceivedAt ? at(recipient.id, res.emailReceivedAt) : null) : null,
    };
  });
  const receivedRows = rows.filter(r => r.delivery === "received");
  const classified = rows.filter(r => r.placement === "inbox" || r.placement === "spam").length;
  const times = receivedRows.map(r => r.received_at).filter((t): t is string => t !== null).map(Date.parse);
  // Never later than a previous read of the same run said: mail is reported out of order, so the
  // earliest time can only move earlier. With seeds seen but no time reported for any, the only
  // observation is that they had arrived by this read, so it is the read's time, which the next
  // read carries forward rather than replacing with its own.
  const computed = times.length ? Math.min(...times) : receivedRows.length ? Date.parse(res.serverNow) + offset : null;
  const before = sameRead?.first_detected_at ? Date.parse(sameRead.first_detected_at) : null;
  const firstDetected = computed === null ? null : toIso(before === null ? computed : Math.min(computed, before));
  const providers = [...new Set(m.recipients.filter(r => r.role === "placement").map(r => r.provider))];
  const provider_results = providers.map(provider => {
    const ids = new Set(m.recipients.filter(r => r.role === "placement" && r.provider === provider).map(r => r.id));
    const group = rows.filter(r => ids.has(r.recipient_id));
    const n = (p: string) => group.filter(r => r.placement === p).length;
    return { provider, expected_count: group.length, received_count: group.filter(r => r.delivery === "received").length,
      classified_count: n("inbox") + n("spam"), inbox: n("inbox"), spam: n("spam"), other: 0, unclassified: 0, pending: n("pending"), missing: n("missing"), unreachable: n("unreachable") };
  });
  const status = ({
    pending: receivedRows.length ? "receiving" : "awaiting_message",
    processing: receivedRows.length ? "receiving" : "awaiting_message",
    // Complete needs every seed classified and the test's own address reached, as the validator does.
    completed: classified === m.expected_placement_count && res.emailReceivedAt !== null ? "complete" : "incomplete",
    expired: "expired", failed: "failed", rate_limited: "rate_limited", free_mail: "free_mail",
  } as const)[res.status];
  if (status === "expired" && receivedRows.length) drift("an expired test that received mail");
  const wrongSender = res.fromEmail !== null && mailboxKey(res.fromEmail) !== mailboxKey(m.expected_from);
  const refusal = status === "rate_limited" ? "RATE_LIMITED" : status === "free_mail" ? "FREE_MAIL" : null;
  // Valid needs evidence of the sender; without one a full measurement is only unknown.
  const validation = refusal ? { status: "invalid", reasons: wrongSender ? [refusal, "SENDER_MISMATCH"] : [refusal] }
    : wrongSender ? { status: "invalid", reasons: ["SENDER_MISMATCH"] }
    : status === "complete" ? (res.fromEmail !== null ? { status: "valid", reasons: [] } : { status: "unknown", reasons: [] })
    : ["incomplete", "expired", "failed"].includes(status) ? { status: "unknown", reasons: [] }
    : { status: "pending", reasons: [] };
  const result = {
    ...m,
    run_uuid: res.uuid,
    status,
    updated_at: utc(res.serverNow),
    first_detected_at: firstDetected,
    received_count: receivedRows.length,
    classified_count: classified,
    recipient_results: rows,
    provider_results,
    validation,
    service_summary: null as unknown,
    // When a domain refused as rate limited may test again, on the local clock.
    // A retry time in a shape the CLI does not recognise costs the retry time, not the read.
    ...(status === "rate_limited" && retryAfter(res.rateLimit) ? { retry_after: utc(retryAfter(res.rateLimit)!) } : {}),
  };
  // Only a finished measurement carries the service's figures, and only figures that agree with the
  // rows: a shape the CLI does not recognise, or figures it cannot reconcile, cost the summary,
  // never the measurement. A refusal, expiry or failure has none. Figures are saved only for a
  // finished measurement and must agree with its rows, which cannot change, so once saved for this
  // run they are kept: a later read's wording or shape never replaces or loses them.
  const summary = status === "complete" || status === "incomplete" ? toSummary({ verdict: res.verdict, stats: res.stats }) : null;
  const usable = summary !== null && summaryFits(result as unknown as Result, summary as NonNullable<Result["service_summary"]>);
  result.service_summary = sameRead?.service_summary ?? (usable ? summary : null);
  return result;
}

type Fetch = typeof fetch;

async function readBounded(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > RESPONSE_LIMIT) {
      await reader.cancel().catch(() => undefined);
      return drift("an oversized response");
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

export class HttpPlacementApi {
  readonly environment = "production" as const;
  readonly reportOrigins: readonly string[] = [REPORT_ORIGIN];

  constructor(
    private readonly origin = SERVICE_ORIGIN,
    private readonly fetcher: Fetch = fetch,
    private readonly sleep = (ms: number, signal?: AbortSignal) => new Promise<void>(resolve => {
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
    }),
    private readonly now = () => Date.now(),
  ) {}

  assertAvailable(): void {}

  // Whether the service answers its public health check; used by doctor only.
  async reachable(): Promise<boolean> {
    try {
      const response = await this.fetcher(this.origin + "/api/health", { redirect: "error", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      return response.ok;
    } catch { return false; }
  }

  // Create with the UUID the CLI saved before this call. If the response is lost, wait, then
  // replay the same UUID once: the service returns the test the first attempt made, if it made
  // one. Only if the replay is lost too is the outcome unknown.
  // An interrupt stops the wait and any request, so the caller's lock is released; the outcome is
  // then as unknown as a lost response, with the same recovery.
  async create(body: CreateBody, requestId: string, signal?: AbortSignal): Promise<unknown> {
    const stopped = () => new CliError("INTERRUPTED", "Stopped locally before creation finished. A test may exist; placement create replays the same request and returns it.", 130);
    let created: z.infer<typeof createSchema>;
    try {
      created = await this.createOnce(requestId, signal);
    } catch (error) {
      if (signal?.aborted) throw stopped();
      if (!(error instanceof CliError) || error.code !== "ALLOCATION_UNKNOWN") throw error;
      await this.sleep(REPLAY_DELAY_MS, signal);
      if (signal?.aborted) throw stopped();
      try { created = await this.createOnce(requestId, signal); }
      catch (replayError) { throw signal?.aborted ? stopped() : replayError; }
    }
    if (created.uuid !== requestId) drift("a test with a different UUID");
    // The test exists, but nothing is saved until the first read supplies its providers and
    // creation time. A read that fails here leaves the same unknown outcome as a lost create, and
    // the same recovery: creating again replays the UUID. A response outside the contract stays drift.
    let first: ServiceResults;
    const sent = this.now();
    try {
      first = await this.results(created.testCode, signal);
    } catch (error) {
      if (signal?.aborted) throw stopped();
      if (error instanceof CliError && error.code === "INVALID_RESULTS") throw error;
      throw new CliError("ALLOCATION_UNKNOWN", "The test was created, but its first read failed, so it was not saved. placement create replays the same request and returns it.", 6, true);
    }
    return toManifest(created, first, body, sent);
  }

  async get(testId: string, signal?: AbortSignal, context?: ReadContext): Promise<unknown> {
    const sent = this.now();
    const res = await this.results(testId, signal);
    if (context?.manifest) return toResult(res, context.manifest, sent, context.previous);
    if (context?.body) {
      // A run created without the CLI: build its manifest from a read. The send deadline is
      // counted from the service's creation time, as for a run the CLI created.
      // Deadlines come from the read if it states them; otherwise the ten-minute rule, the safe side.
      const created = { testCode: res.testCode, emailAddress: res.emailAddress, uuid: res.uuid, seedAddresses: res.seedAddresses, status: res.status,
        expiresAt: res.expiresAt, sentinelWaitMinutes: res.sentinelWaitMinutes, maxMeasurementMinutes: res.maxMeasurementMinutes };
      return toManifest(created, res, context.body, sent);
    }
    return drift("a read without a saved test to compare it with");
  }

  private async createOnce(requestId: string, signal?: AbortSignal) {
    const response = await this.request("POST", "/api/generate-test", JSON.stringify({ uuid: requestId }), signal, true);
    const parsed = createSchema.safeParse(response);
    return parsed.success ? parsed.data : drift("a create response");
  }

  private async results(testCode: string, signal?: AbortSignal): Promise<ServiceResults> {
    const response = await this.request("GET", `/api/results/${encodeURIComponent(testCode)}`, undefined, signal, false);
    const parsed = resultsSchema.safeParse(response);
    return parsed.success ? parsed.data : drift("a results response");
  }

  private async request(method: string, path: string, body: string | undefined, signal: AbortSignal | undefined, creating: boolean): Promise<unknown> {
    const lost = (): never => {
      if (creating) throw new CliError("ALLOCATION_UNKNOWN", "The create request did not return. A test may exist that this client cannot name; placement create replays the same request.", 6, true);
      throw new CliError("NETWORK_ERROR", "The placement service could not be reached.", 6, true);
    };
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    let response: Response;
    try {
      response = await this.fetcher(this.origin + path, {
        method, body: body ?? null, redirect: "error",
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        headers: { accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) },
      });
    } catch (error) {
      if (signal?.aborted) throw signal.reason instanceof CliError ? signal.reason : new CliError("INTERRUPTED", "Stopped locally; the remote test remains available.", 130);
      if (timeout.aborted && !creating) throw new CliError("REQUEST_TIMEOUT", "The placement service did not answer in time.", 6, true);
      return lost();
    }
    if (response.status === 404) throw new CliError("TEST_NOT_FOUND", "The placement service has no test with that code.", 2);
    if (response.status === 429) {
      const header = response.headers.get("retry-after");
      const retry = header === null ? NaN : Number(header);
      throw new CliError("RATE_LIMITED", "The placement service asked the client to slow down.", 4, true, null,
        Number.isFinite(retry) && retry >= 0 ? { retry_after_seconds: retry } : {});
    }
    if (response.status >= 500) {
      if (creating) return lost();
      throw new CliError("SERVICE_UNAVAILABLE", "The placement service is unavailable.", 6, true);
    }
    if (response.status !== 200) throw new CliError("REQUEST_REFUSED", `The placement service refused the request (${response.status}).`, 5);
    // A body cut off after the headers is as lost as no response at all. Bytes are counted as they
    // arrive, so an oversized body is refused before it is held in memory.
    let text: string;
    try { text = await readBounded(response); }
    catch (error) {
      if (error instanceof CliError) throw error;
      return lost();
    }
    try { return JSON.parse(text); } catch { return drift("a response that is not JSON"); }
  }
}
