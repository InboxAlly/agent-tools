import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { CliError, unavailable } from "./errors.js";
import { correlationAddress, createBodySchema, mailboxKey, MIN_SEND_WINDOW_SECONDS, platforms, PRODUCTION_REPORT_ORIGIN, requireSendWindow, senderDomain, text, validateManifest, type CreateBody, type Manifest } from "./manifest.js";
import { EXPORT_LIMIT, RUNS_SEEN_LIMIT, StateStore, type Run } from "./state.js";
import { detailsSchema, evidenceTypes, JOURNAL_LIMIT, journalEvents, requiredApprovalDetails, sendOrientedEvents, stateAfter, type JournalEntry, type NoteDetails } from "./journal.js";

import { validateResult, type Result } from "./results.js";

// v3 owns reservation, the signed service grant, and reconciliation. No grant is exposed here.
// How long a free-tier domain is treated as having used its test after a campaign arrived.
const RECENT_TEST_WINDOW_MS = 24 * 60 * 60 * 1000;
export interface PlacementApi {
  readonly environment: Run["environment"];
  readonly reportOrigins: readonly string[];
  assertAvailable(): void;
  // requestId is the run's local request id, which a transport may send as the run UUID so a
  // replay returns the same test.
  create(body: CreateBody, requestId: string, signal?: AbortSignal): Promise<unknown>;
  get(testId: string, signal?: AbortSignal, context?: ReadContext): Promise<unknown>;
}

// What a transport may need to translate a read: the saved test, or for a run created without
// the CLI, the intent to build one from.
export interface ReadContext { manifest?: Manifest; body?: CreateBody; previous?: Result }

export const unavailableApi: PlacementApi = {
  environment: "production", reportOrigins: [PRODUCTION_REPORT_ORIGIN], assertAvailable: unavailable, create: async () => unavailable(),
  get: async () => unavailable(),
};

// A run is selected by what a human knows: the sending domain, a label they chose, the test
// code, the service's run UUID, or the local record id. Never by position or recency.
export interface Selector {
  domain?: string;
  label?: string;
  test?: string;
  uuid?: string;
  request?: string;
}
export const selectorKeys: readonly (keyof Selector)[] = ["domain", "label", "test", "uuid", "request"];
export const runDomain = (run: Run): string => senderDomain(run.body.expected_from);
// A run still holds the user's attention until it reaches a terminal workflow state.
const openStates = new Set(["prepared", "allocation_unknown", "allocated", "awaiting_import_approval",
  "import_outcome_unknown", "import_verified", "awaiting_send_approval", "send_outcome_unknown",
  "send_confirmed", "watching"]);

export class Placement {
  constructor(readonly store: StateStore, readonly api: PlacementApi) {
    if (store.environment !== api.environment) throw new CliError("ENVIRONMENT_MISMATCH", "API and local state environments must match.");
  }

  async prepare(from: string, platform: string, campaign: string, label?: string): Promise<Run> {
    const run = this.newRun(from, platform, campaign, label);
    await this.store.locked(run.local_request_id, () => this.store.save(run));
    return run;
  }

  // Build a record without saving it, so an import that fails validation leaves nothing behind.
  private newRun(from: string, platform: string, campaign: string, label?: string): Run {
    const body = createBodySchema.safeParse({ expected_from: from, sending_platform: platform });
    const reference = text.safeParse(campaign);
    if (!body.success || !reference.success) {
      const badPlatform = !(platforms as readonly string[]).includes(platform);
      throw new CliError("INVALID_ARGUMENTS", badPlatform
        ? `Unsupported --platform. Use one of: ${platforms.join(", ")}.`
        : "Provide one valid From mailbox, a supported platform, and a nonempty campaign reference.");
    }
    const named = label === undefined ? undefined : text.safeParse(label);
    if (named && !named.success) throw new CliError("INVALID_ARGUMENTS", "A label must be short printable text.");
    const run: Run = {
      local_schema_version: 7, environment: this.store.environment,
      local_request_id: randomUUID(), created_at: new Date().toISOString(),
      body: body.data, campaign_reference: reference.data, auth_mode: "anonymous", state: "prepared", journal: [], exports: [], runs_seen: [],
      ...(named ? { label: named.data } : {}),
    };
    return run;
  }

  // "create" makes the first attempt or replays it under the same key. "resume" only recovers
  // an attempt that was actually made; a restart never turns a prepared intent into a test.
  // Creation sends the saved request id as the run's UUID, so a replay reaches the same test
  // (decision 0006); the service mints the test code. Creation reserves no allowance:
  // a lost response costs the user nothing and leaves an unnamed test nothing is ever sent to. What must
  // not happen is two live address lists for one domain, because a campaign sent to the wrong
  // one produces a measurement nobody is watching.
  async create(selector: Selector, allowSecond = false, signal?: AbortSignal, despiteRecent = false): Promise<Run> {
    this.api.assertAvailable();
    const chosen = await this.select(selector);
    return this.store.locked(chosen.local_request_id, async () => {
      const run = await this.store.load(chosen.local_request_id);
      if (run.test) {
        validateManifest(run.test, this.api.reportOrigins, run.body);
        if (run.snapshot) validateResult(run.snapshot, run.test, this.api.reportOrigins);
        return run;
      }
      if (!allowSecond) await this.assertSingleLiveRun(run);
      if (!despiteRecent) await this.assertNotRecentlyTested(run);
      // A creation attempt that does not return leaves a test this client cannot name. Recording
      // that is honest; it does not oblige recovery of a specific allocation.
      run.state = "allocation_unknown";
      await this.store.save(run);
      const raw = await this.api.create(run.body, run.local_request_id, signal);
      return this.adoptInto(run, raw);
    });
  }

  // Adopt a run created without the CLI. Identity is all the service needs to return the same
  // run, so a skill-only session continues here instead of starting a second test.
  async adopt(testCode: string, body: { from: string; platform: string; campaign: string; label?: string; uuid?: string }): Promise<Run> {
    this.api.assertAvailable();
    const existing = (await this.store.runs()).find(r => r.remote?.test_code === testCode || r.test?.test_id === testCode);
    if (existing) throw new CliError("RUN_ALREADY_SAVED", "That test is already saved locally; select it instead of importing it again.");
    const run = this.newRun(body.from, body.platform, body.campaign, body.label);
    const raw = await this.api.get(testCode, undefined, { body: run.body });
    const test = validateManifest(raw, this.api.reportOrigins, run.body, testCode);
    if (body.uuid !== undefined && test.run_uuid !== body.uuid) {
      throw new CliError("RUN_IDENTITY_MISMATCH", "That test does not carry the run UUID you supplied; nothing was saved.", 5);
    }
    return this.store.locked(run.local_request_id, () => this.adoptInto(run, raw, testCode));
  }

  // Persist what the service minted the moment the response parses, before anything is shown to
  // a user. A user must never hold an address list this client cannot name.
  private async adoptInto(run: Run, raw: unknown, testCode?: string): Promise<Run> {
    const test = validateManifest(raw, this.api.reportOrigins, run.body, testCode);
    run.test = test;
    run.remote = {
      uuid: test.run_uuid, test_code: test.test_id,
      email_address: correlationAddress(test), allocated_at: new Date().toISOString(),
    };
    run.state = "allocated";
    if (!run.runs_seen.includes(test.run_uuid)) run.runs_seen.push(test.run_uuid);
    await this.store.save(run);
    return run;
  }

  // One live address list per sending domain. This defends the user's clarity, not a quota.
  private async assertSingleLiveRun(run: Run): Promise<void> {
    const domain = runDomain(run);
    const live = (await this.store.runs()).filter(other =>
      other.local_request_id !== run.local_request_id && other.test !== undefined
      && runDomain(other) === domain && openStates.has(other.state));
    if (live.length === 0) return;
    const names = live.map(r => r.remote?.test_code ?? r.test?.test_id ?? r.local_request_id).join(", ");
    throw new CliError("DOMAIN_RUN_ACTIVE", `${domain} already has an unfinished test (${names}). Resume it, or pass --second-test if the user genuinely wants another live address list for this domain.`, 5);
  }

  // The free tier allows one test per sending domain per day, counted from when a campaign
  // arrives. A saved run for this domain that was measured less than a day ago, or was refused
  // with a retry time still ahead, means the service will very likely refuse a new test, after the
  // user has done all the sending work. A refusal's arrival is not a measurement: its own retry
  // time, from the service, says when the domain is free.
  private async assertNotRecentlyTested(run: Run): Promise<void> {
    const domain = runDomain(run);
    const now = Date.now();
    const free = (await this.store.runs())
      .filter(other => other.local_request_id !== run.local_request_id && other.environment === run.environment && runDomain(other) === domain && other.snapshot)
      .map(other => {
        const s = other.snapshot!;
        if (s.status === "rate_limited") return s.retry_after ? Date.parse(s.retry_after) : null;
        if (s.status === "free_mail" || s.first_detected_at === null) return null;
        return Date.parse(s.first_detected_at) + RECENT_TEST_WINDOW_MS;
      })
      .filter((at): at is number => at !== null && at > now);
    if (free.length === 0) return;
    const after = new Date(Math.max(...free)).toISOString();
    throw new CliError("DOMAIN_RECENTLY_TESTED", `${domain} has already used its free test for the day, so a new test would very likely be refused as rate limited. Try after about ${after}. Pass --despite-recent-test only if the user wants to try anyway.`, 4, false,
      { domain, likely_available_after: after });
  }

  // Selection never guesses. One selector, and an ambiguous match stops with the candidates.
  async select(selector: Selector): Promise<Run> {
    const given = selectorKeys.filter(key => selector[key] !== undefined && selector[key] !== "");
    if (given.length !== 1) throw new CliError("INVALID_ARGUMENTS", `Select a run with exactly one of: ${selectorKeys.map(k => `--${k}`).join(", ")}.`);
    const matches = (await this.store.runs()).filter(run => {
      if (selector.request !== undefined) return run.local_request_id === selector.request;
      if (selector.uuid !== undefined) return run.remote?.uuid === selector.uuid;
      if (selector.test !== undefined) return run.remote?.test_code === selector.test || run.test?.test_id === selector.test;
      if (selector.label !== undefined) return run.label === selector.label;
      return runDomain(run) === selector.domain!.trim().toLowerCase();
    });
    if (matches.length === 1) return matches[0]!;
    if (matches.length === 0) throw new CliError("STATE_UNAVAILABLE", "No saved local run matches that selection.");
    // Narrowing is not guessing: an intent with no allocated test is not a candidate while an
    // allocated run exists, and a finished run is not a candidate while one is still open.
    const allocated = matches.filter(run => run.test !== undefined);
    if (allocated.length === 1) return allocated[0]!;
    const open = (allocated.length > 1 ? allocated : matches).filter(run => openStates.has(run.state));
    if (open.length === 1) return open[0]!;
    const names = matches.map(r => r.remote?.test_code ?? r.local_request_id).join(", ");
    throw new CliError("AMBIGUOUS_SELECTION", `That selection matches ${matches.length} saved runs (${names}). Select one by test code or label.`);
  }

  async selected(selector: Selector): Promise<Run & { test: NonNullable<Run["test"]> }> {
    const run = await this.select(selector);
    if (!run.test) throw new CliError("STATE_UNAVAILABLE", "That run has no allocated test yet. Run placement create when the user is ready.");
    const test = validateManifest(run.test, this.api.reportOrigins, run.body, run.test.test_id);
    if (run.snapshot) validateResult(run.snapshot, test, this.api.reportOrigins);
    return { ...run, test };
  }

  async status(selector: Selector, signal?: AbortSignal): Promise<Result> {
    this.api.assertAvailable();
    signal?.throwIfAborted();
    const selected = await this.selected(selector);
    const testCode = selected.remote?.test_code ?? selected.test.test_id;
    return this.store.locked(selected.local_request_id, async () => {
      const run = await this.store.load(selected.local_request_id);
      const manifest = validateManifest(run.test, this.api.reportOrigins, run.body, testCode);
      const raw = await this.api.get(testCode, signal, { manifest, ...(run.snapshot ? { previous: run.snapshot } : {}) });
      signal?.throwIfAborted();
      // Consistency with the saved snapshot is a property of one run. A read that resolved to a
      // later run — after a refusal, say, the user sends again — is checked on its own.
      // Reads resolve to the most recent run, so a different run must be one not seen before: a
      // return to any earlier run is the service going backwards.
      const readUuid = typeof raw === "object" && raw !== null ? (raw as { run_uuid?: unknown }).run_uuid : undefined;
      const current = run.snapshot?.run_uuid ?? run.remote?.uuid ?? run.test?.run_uuid;
      const sameRun = run.snapshot !== undefined && readUuid === run.snapshot.run_uuid;
      const snapshot = validateResult(raw, manifest, this.api.reportOrigins, sameRun ? run.snapshot : undefined);
      if (snapshot.run_uuid !== current && run.runs_seen.includes(snapshot.run_uuid)) {
        throw new CliError("INVALID_RESULTS", "The service returned an earlier run after a later one. Stop and preserve this run.", 5);
      }
      if (!run.runs_seen.includes(snapshot.run_uuid)) {
        if (run.runs_seen.length >= RUNS_SEEN_LIMIT) throw new CliError("RUNS_FULL", "This test has resolved to more runs than the CLI records. Stop and preserve this run.", 5);
        run.runs_seen.push(snapshot.run_uuid);
      }
      // A read can resolve to a later run for the same test code, because a second delivery to
      // the test address starts one. The numbers are still the user's latest measurement, so
      // they are kept and reported — labelled as a different send, never as the approved one.
      if (run.remote && snapshot.run_uuid !== run.remote.uuid) {
        run.superseded_by = { uuid: snapshot.run_uuid, test_code: snapshot.test_id, observed_at: new Date().toISOString() };
      }
      run.snapshot = snapshot;
      await this.store.save(run);
      return snapshot;
    });
  }

  // Remember where a recipient export was written and what it held. Records are only ever
  // added: replacing one — say, after a failed export to the same path — would let the earlier,
  // unchanged export pass verify. When the run holds as many as it can, a new export is refused
  // rather than an old record forgotten.
  async recordExport(selector: Selector, path: string, contents: string): Promise<void> {
    const selected = await this.select(selector);
    const sha256 = createHash("sha256").update(contents).digest("hex");
    await this.store.locked(selected.local_request_id, async () => {
      const run = await this.store.load(selected.local_request_id);
      if (run.exports.some(e => e.path === path && e.sha256 === sha256)) return;
      if (run.exports.length >= EXPORT_LIMIT) {
        throw new CliError("EXPORTS_FULL", `This run already records ${EXPORT_LIMIT} recipient exports. Reuse an earlier export instead of writing another.`, 2);
      }
      run.exports.push({ path, sha256 });
      await this.store.save(run);
    });
  }

  // Append one validated workflow observation. This never contacts the API and never
  // authorizes a platform action; an approval entry records what a human approved.
  async note(selector: Selector, event: string, evidence: string, rawDetails: unknown): Promise<JournalEntry> {
    const parsedEvent = z.enum(journalEvents).safeParse(event);
    const parsedEvidence = z.enum(evidenceTypes).safeParse(evidence);
    if (!parsedEvent.success) throw new CliError("INVALID_ARGUMENTS", `--event must be one of: ${journalEvents.join(", ")}.`);
    if (!parsedEvidence.success) throw new CliError("INVALID_ARGUMENTS", `--evidence must be one of: ${evidenceTypes.join(", ")}.`);
    const details = detailsSchema.safeParse(rawDetails);
    if (!details.success) throw new CliError("INVALID_NOTE_DETAILS", `Details may contain only ${Object.keys(detailsSchema.shape).join(", ")} with valid types and sizes; no credentials or campaign bodies.`);
    const selected = await this.selected(selector);
    return this.store.locked(selected.local_request_id, async () => {
      const run = await this.store.load(selected.local_request_id);
      const manifest = validateManifest(run.test, this.api.reportOrigins, run.body, selected.test.test_id);
      if (sendOrientedEvents.has(parsedEvent.data)) requireSendWindow(manifest, Date.now(), parsedEvent.data === "send_approved" ? MIN_SEND_WINDOW_SECONDS : 0);
      checkApproval(parsedEvent.data, details.data, run.body, manifest);
      if (run.journal.length >= JOURNAL_LIMIT) throw new CliError("JOURNAL_FULL", `This run's journal already holds ${JOURNAL_LIMIT} entries.`);
      const entry: JournalEntry = {
        sequence: run.journal.length + 1, recorded_at: new Date().toISOString(),
        event: parsedEvent.data, evidence: parsedEvidence.data, details: details.data, state: stateAfter(parsedEvent.data),
      };
      run.journal.push(entry);
      run.state = entry.state;
      await this.store.save(run);
      return entry;
    });
  }
}

// An approval must name what was approved, and it must match the immutable intent and
// manifest. Other events may record a mismatch as evidence, for example before stopping.
function checkApproval(event: JournalEntry["event"], details: NoteDetails, body: CreateBody, manifest: Manifest): void {
  const required = requiredApprovalDetails[event];
  if (!required) return;
  const missing = required.filter(key => details[key] === undefined);
  if (missing.length) throw new CliError("INVALID_NOTE_DETAILS", `A ${event} note must record ${required.join(", ")}; missing ${missing.join(", ")}.`);
  const mismatch = (details.platform !== undefined && details.platform !== body.sending_platform)
    || (details.from !== undefined && mailboxKey(details.from) !== mailboxKey(manifest.expected_from))
    || (details.list_name !== undefined && details.list_name !== manifest.list_name)
    || (details.recipient_count !== undefined && details.recipient_count !== manifest.recipient_count);
  if (mismatch) throw new CliError("APPROVAL_MISMATCH", "The approved platform, sender, list name, or recipient count differs from this test. Stop; a changed intent needs a new explicitly requested test.", 5);
}
