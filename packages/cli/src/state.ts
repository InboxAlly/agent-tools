import { mkdir, open, readFile, readdir, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { CliError } from "./errors.js";
import { createBodySchema, mailbox, manifestSchema, text } from "./manifest.js";
import { JOURNAL_LIMIT, journalEntrySchema, workflowStates } from "./journal.js";

import { legacyResultSchema, resultSchema, upgradeSnapshot } from "./results.js";

export const allocationStates = ["prepared", "allocation_unknown", "allocated"] as const;

// Identity minted by the placement service and learned at creation. Persisted the moment the
// response parses, never derived or regenerated. Both fields are capabilities: whoever holds
// them can read the report, so they are treated like a report URL, not like a name.
export const remoteSchema = z.object({
  uuid: z.uuid(),
  test_code: text,
  email_address: mailbox,
  allocated_at: z.iso.datetime(),
}).strict();
const runFields = {
  environment: z.enum(["production", "staging", "mock"]),
  local_request_id: z.uuid(),
  created_at: z.iso.datetime(),
  body: createBodySchema,
  campaign_reference: text,
  auth_mode: z.literal("anonymous"),
  // Optional human handle. The sending domain is derived from the body, never stored.
  label: text.optional(),
  remote: remoteSchema.optional(),
  // Set when a read resolved to a later run for the same test code. The approved run keeps its
  // own identity; this records that the numbers on screen belong to a different send.
  superseded_by: z.object({ uuid: z.uuid(), test_code: text, observed_at: z.iso.datetime() }).strict().optional(),
  test: manifestSchema.optional(),
  snapshot: resultSchema.optional(),
};
// Files before version 6 hold a snapshot in the earlier result shape.
const olderRunFields = { ...runFields, snapshot: legacyResultSchema.optional() };
// Where this CLI wrote the test's recipient exports, and a digest of what it wrote, so verify
// can refuse a file that is still exactly the CLI's own export: that comparison always matches
// and proves nothing about the platform. A file rewritten with the platform's members passes.
export const EXPORT_LIMIT = 64;
export const exportSchema = z.object({ path: z.string().min(1).max(4096), sha256: z.string().regex(/^[0-9a-f]{64}$/) }).strict();
const exportsSchema = z.array(exportSchema).max(EXPORT_LIMIT);
// Every run UUID a read of this test has resolved to, starting with the test's own. Reads resolve
// to the most recent run, so a read returning to one already seen, other than the current one,
// is the service going backwards, and is refused.
export const RUNS_SEEN_LIMIT = 64;
const runsSeenSchema = z.array(z.uuid()).max(RUNS_SEEN_LIMIT);
// Version 1 predates the workflow journal; version 2 predates service-minted identity and
// labels; version 3 predates recorded exports; version 4 predates the runs seen; version 5
// predates missing and unreachable seeds in the snapshot; version 6 predates a refused result's
// retry time. All are read, upgraded in memory, and rewritten as version 7 on the next save. An older build rejects a newer file rather than
// misreading it.
const legacyFields = (({ label: _l, remote: _r, superseded_by: _s, ...rest }) => rest)(olderRunFields);
const runSchemaV1 = z.object({ local_schema_version: z.literal(1), ...legacyFields, state: z.enum(allocationStates) }).strict();
const runSchemaV2 = z.object({
  local_schema_version: z.literal(2), ...legacyFields,
  state: z.enum([...allocationStates, ...workflowStates]),
  journal: z.array(journalEntrySchema).max(JOURNAL_LIMIT),
}).strict();
const runSchemaV3 = z.object({
  local_schema_version: z.literal(3), ...olderRunFields,
  state: z.enum([...allocationStates, ...workflowStates]),
  journal: z.array(journalEntrySchema).max(JOURNAL_LIMIT),
}).strict();
const runSchemaV4 = z.object({
  local_schema_version: z.literal(4), ...olderRunFields,
  state: z.enum([...allocationStates, ...workflowStates]),
  journal: z.array(journalEntrySchema).max(JOURNAL_LIMIT),
  exports: exportsSchema,
}).strict();
const runSchemaV5 = z.object({
  local_schema_version: z.literal(5), ...olderRunFields,
  state: z.enum([...allocationStates, ...workflowStates]),
  journal: z.array(journalEntrySchema).max(JOURNAL_LIMIT),
  exports: exportsSchema,
  runs_seen: runsSeenSchema,
}).strict();
const runSchemaV6 = z.object({
  local_schema_version: z.literal(6), ...runFields,
  state: z.enum([...allocationStates, ...workflowStates]),
  journal: z.array(journalEntrySchema).max(JOURNAL_LIMIT),
  exports: exportsSchema,
  runs_seen: runsSeenSchema,
}).strict();
const runSchema = z.object({
  local_schema_version: z.literal(7), ...runFields,
  state: z.enum([...allocationStates, ...workflowStates]),
  journal: z.array(journalEntrySchema).max(JOURNAL_LIMIT),
  exports: exportsSchema,
  runs_seen: runsSeenSchema,
}).strict();
export type Run = z.infer<typeof runSchema>;
export const isAllocated = (run: Pick<Run, "state">): boolean => run.state !== "prepared" && run.state !== "allocation_unknown";

// An upgraded run has seen whatever runs its saved identity and snapshot name.
// Older files may have no `remote`, so the saved test's own run UUID counts too.
const seenFrom = (run: { remote?: { uuid: string } | undefined; test?: { run_uuid: string } | undefined; snapshot?: { run_uuid: string } | undefined; superseded_by?: { uuid: string } | undefined }): string[] =>
  [...new Set([run.remote?.uuid, run.test?.run_uuid, run.snapshot?.run_uuid, run.superseded_by?.uuid].filter((u): u is string => u !== undefined))];

function parseRun(raw: unknown): Run {
  const current = runSchema.safeParse(raw);
  if (current.success) return current.data;
  // A version 6 snapshot is already in the current shape, without a retry time.
  const v6 = runSchemaV6.safeParse(raw);
  if (v6.success) return { ...v6.data, local_schema_version: 7 };
  return upgrade(parseOlder(raw));
}

type OlderRun = z.infer<typeof runSchemaV5>;
const upgrade = ({ local_schema_version: _v, snapshot, ...rest }: OlderRun): Run =>
  ({ local_schema_version: 7, ...rest, ...(snapshot ? { snapshot: upgradeSnapshot(snapshot, rest.environment) } : {}) });

function parseOlder(raw: unknown): OlderRun {
  const v5 = runSchemaV5.safeParse(raw);
  if (v5.success) return v5.data;
  const v4 = runSchemaV4.safeParse(raw);
  if (v4.success) {
    const { local_schema_version: _v4, ...legacy } = v4.data;
    return { local_schema_version: 5, ...legacy, runs_seen: seenFrom(legacy) };
  }
  const v3 = runSchemaV3.safeParse(raw);
  if (v3.success) {
    const { local_schema_version: _v3, ...legacy } = v3.data;
    return { local_schema_version: 5, ...legacy, exports: [], runs_seen: seenFrom(legacy) };
  }
  const v2 = runSchemaV2.safeParse(raw);
  if (v2.success) {
    const { local_schema_version: _v2, ...legacy } = v2.data;
    return { local_schema_version: 5, ...legacy, exports: [], runs_seen: seenFrom(legacy) };
  }
  const { local_schema_version: _v1, ...legacy } = runSchemaV1.parse(raw);
  return { local_schema_version: 5, ...legacy, journal: [], exports: [], runs_seen: seenFrom(legacy) };
}

export class StateStore {
  constructor(readonly root: string, readonly environment: Run["environment"]) {}

  private path(id: string): string {
    if (!z.uuid().safeParse(id).success) throw new CliError("INVALID_REQUEST_ID", "A UUID request ID is required.");
    return join(this.root, `${id}.json`);
  }

  async ensure(): Promise<void> { await mkdir(this.root, { recursive: true, mode: 0o700 }); }

  async load(id: string): Promise<Run> {
    const path = this.path(id);
    let raw: string;
    try { raw = await readFile(path, "utf8"); }
    catch { throw new CliError("STATE_UNAVAILABLE", "The selected local request cannot be read. Do not allocate a replacement automatically."); }
    try {
      const run = parseRun(JSON.parse(raw));
      if (run.local_request_id !== id || run.environment !== this.environment) throw new Error();
      if (isAllocated(run) !== (run.test !== undefined)) throw new Error();
      if (run.snapshot && (!run.test || run.snapshot.test_id !== run.test.test_id)) throw new Error();
      // The workflow state is exactly the last journal entry's state; without entries it is an allocation state.
      const last = run.journal.at(-1);
      if (last ? last.state !== run.state : !(allocationStates as readonly string[]).includes(run.state)) throw new Error();
      if (run.journal.some((entry, index) => entry.sequence !== index + 1)) throw new Error();
      return run;
    } catch { throw new CliError("STATE_INVALID", "The selected local request is corrupt or belongs to another environment."); }
  }

  async save(run: Run): Promise<void> {
    const parsed = runSchema.parse(run);
    if (parsed.environment !== this.environment) throw new CliError("STATE_INVALID", "State environment mismatch.");
    const destination = this.path(parsed.local_request_id);
    await this.ensure();
    const temp = join(this.root, `.${randomUUID()}.tmp`);
    const file = await open(temp, "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify(parsed) + "\n");
      await file.sync();
    } finally { await file.close(); }
    try { await rename(temp, destination); }
    finally { await unlink(temp).catch(() => {}); }
  }

  async locked<T>(id: string, action: () => Promise<T>): Promise<T> {
    const lockPath = this.path(id) + ".lock";
    await this.ensure();
    let lock;
    try { lock = await open(lockPath, "wx", 0o600); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      throw new CliError("REQUEST_BUSY", "This request is locked. Retry after the other process finishes; a stale lock requires manual recovery.", 2, true);
    }
    try { return await action(); }
    finally { await lock.close(); await unlink(lockPath); }
  }

  async runs(): Promise<Run[]> {
    let names: string[];
    try { names = await readdir(this.root); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return []; throw e; }
    const runs = await Promise.all(names.filter(n => n.endsWith(".json")).map(n => this.load(n.slice(0, -5))));
    return runs.sort((a, b) => b.created_at.localeCompare(a.created_at));
  }
}
