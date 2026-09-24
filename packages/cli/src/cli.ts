import { parseArgs } from "node:util";
import { access, lstat, open, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { CliError, safeText, unavailable } from "./errors.js";
import { readBoundedUtf8 } from "./input.js";
import { DETAILS_FILE_LIMIT } from "./journal.js";
import { platforms, validateManifest } from "./manifest.js";
import { HttpPlacementApi } from "./http.js";
import { Placement, runDomain, selectorKeys, unavailableApi, type PlacementApi, type Selector } from "./placement.js";
import { StateStore } from "./state.js";
import { exportRecipients, parseRecipients, readRecipientFile, verifyRecipients } from "./recipients.js";
import { progressMessage, type Result } from "./results.js";
import { watch, readStatus, type WatchClock } from "./watch.js";

export const VERSION = "0.1.0";
const HELP = `InboxAlly CLI ${VERSION}

Local commands:
  inboxally --help | --version
  inboxally placement prepare --from <address> --platform <slug> --campaign <reference> [--label <name>] [--anonymous] [--json]
  inboxally placement runs [--json]
  inboxally placement recipients <run> --format text|csv|json [--output <path>] [--overwrite]
  inboxally placement verify <run> --recipients-file <path> [--json]
  inboxally placement note <run> --event <event> --evidence tool_observed|user_reported (--details-file <path> | --details <json>) [--json]

API routing (the placement service's free tier; INBOXALLY_LIVE=0 works offline):
  inboxally doctor [--json]
  inboxally placement create <run> [--second-test] [--despite-recent-test] [--json]
  inboxally placement import --test-code <code> --from <address> --platform <slug> --campaign <reference> [--label <name>] [--uuid <run-uuid>] [--json]
  inboxally placement status <run> [--brief] [--json]
  inboxally placement watch <run> [--timeout <seconds>] [--json]

Platforms (--platform): ${platforms.join(", ")}

Selecting a run: give its test code, or exactly one of
  --domain <sending-domain> | --label <name> | --test <test-code> | --uuid <run-uuid> | --request <local-id>
The CLI sends each run's saved request id as its UUID; the placement service mints the test code.
  inboxally login [--json]            Sign in to a paid account (not available yet)
Planned: whoami, logout, open.
No sending-platform mutations are performed by this CLI.
`;

export interface Context {
  placement: Placement;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  watchClock?: WatchClock;
  stdout: (value: string) => void;
  stderr: (value: string) => void;
}

// An INBOXALLY_LIVE value that says neither on nor off: every command that would reach the service
// stops, and says why.
const misconfiguredApi = (value: string): PlacementApi => {
  const refuse = (): never => { throw new CliError("INVALID_ENVIRONMENT", `INBOXALLY_LIVE=${JSON.stringify(value.slice(0, 20))} is not recognised; use 0 to work offline or 1 (or unset) to use the service.`, 2); };
  return { ...unavailableApi, assertAvailable: refuse, create: async () => refuse(), get: async () => refuse() };
};

export function defaultContext(): Context {
  const base = process.platform === "win32" ? (process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"))
    : process.platform === "darwin" ? join(homedir(), "Library", "Application Support")
    : (process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"));
  // The free-tier transport runs against a contract derived by the client (decision 0006) and is
  // on by default; INBOXALLY_LIVE=0 turns it off, for work that must never reach the service.
  // Only recognised values decide it; anything else refuses rather than guessing, since guessing
  // "on" would create real tests for someone who meant off.
  const live = process.env.INBOXALLY_LIVE;
  const api = live === undefined || ["1", "true", "on", "yes"].includes(live) ? new HttpPlacementApi()
    : ["0", "false", "off", "no"].includes(live) ? unavailableApi : misconfiguredApi(live);
  return {
    placement: new Placement(new StateStore(join(base, "inboxally", "production", "runs"), "production"), api),
    env: process.env,
    stdout: s => { process.stdout.write(s); }, stderr: s => { process.stderr.write(s); },
  };
}

const stringOption = { type: "string" as const };
const booleanOption = { type: "boolean" as const };

// The recorded sends that no send approval preceded since the previous send: the user sent early,
// for example. Each send needs its own approval.
export function unapprovedSends(journal: readonly { event: string }[]): number[] {
  const found: number[] = [];
  let approved = false;
  journal.forEach((e, i) => {
    if (e.event === "send_approved") approved = true;
    if (e.event === "send_confirmed") { if (!approved) found.push(i); approved = false; }
  });
  return found;
}
export const sentWithoutApproval = (journal: readonly { event: string }[]): boolean => unapprovedSends(journal).length > 0;

// A compact reading for an agent: the outcome, the counts, the service's own figures, and where to
// look, without the manifest and per-recipient rows. The full result stays the default.
export function briefResult(r: Result) {
  const total = (key: "inbox" | "spam" | "other" | "unclassified" | "missing" | "unreachable" | "pending") => r.provider_results.reduce((sum, g) => sum + g[key], 0);
  return {
    test_id: r.test_id, status: r.status, validity: r.validation.status, reasons: r.validation.reasons,
    received: r.received_count, expected: r.expected_observation_count,
    placement: { inbox: total("inbox"), spam: total("spam"), other: total("other"), unclassified: total("unclassified"),
      missing: total("missing"), unreachable: total("unreachable"), pending: total("pending") },
    service_summary: r.service_summary,
    report_url: r.report_url, send_before: r.send_before, updated_at: r.updated_at,
    ...(r.retry_after ? { retry_after: r.retry_after } : {}),
  };
}

export async function runCli(argv: string[], context: Context): Promise<number> {
  let command = argv[0] ?? "help";
  const json = argv.includes("--json");
  const output = (data: unknown) => {
    const value = json ? { schema_version: "cli.v1", ok: true, command, data, error: null } : data;
    context.stdout(JSON.stringify(value, null, json ? undefined : 2) + "\n");
  };
  try {
    if (!argv.length || (argv.length === 1 && argv[0] === "--help")) { context.stdout(HELP); return 0; }
    if (argv.length === 1 && argv[0] === "--version") { context.stdout(VERSION + "\n"); return 0; }
    let args = argv.slice(1);
    if (command === "placement") { command += "." + (argv[1] ?? ""); args = argv.slice(2); }
    const options: Record<string, { type: "boolean" | "string" }> = { json: booleanOption };
    switch (command) {
      case "placement.prepare": Object.assign(options, { from: stringOption, platform: stringOption, campaign: stringOption, label: stringOption, anonymous: booleanOption }); break;
      case "placement.create": Object.assign(options, { "second-test": booleanOption, "despite-recent-test": booleanOption }); break;
      case "placement.import": Object.assign(options, { "test-code": stringOption, from: stringOption, platform: stringOption, campaign: stringOption, label: stringOption, uuid: stringOption }); break;
      case "placement.recipients": Object.assign(options, { format: stringOption, output: stringOption, overwrite: booleanOption }); delete options.json; break;
      case "placement.verify": options["recipients-file"] = stringOption; break;
      case "placement.note": Object.assign(options, { event: stringOption, evidence: stringOption, "details-file": stringOption, details: stringOption }); break;
      case "placement.watch": options.timeout = stringOption; break;
      case "placement.status": options.brief = booleanOption; break;
      case "doctor": case "placement.runs": case "login": break;
      default: throw new CliError("COMMAND_UNAVAILABLE", "Unknown or unimplemented command. Run inboxally --help for this development build's commands.");
    }
    const selectable = ["placement.create", "placement.recipients", "placement.verify", "placement.status", "placement.watch", "placement.note"];
    if (selectable.includes(command)) for (const key of selectorKeys) options[key] = stringOption;
    let parsed;
    try { parsed = parseArgs({ args, options, allowPositionals: true, strict: true }); }
    catch { throw new CliError("INVALID_ARGUMENTS", "Invalid arguments. Run inboxally --help."); }
    const { values, positionals } = parsed;
    const needsTest = ["placement.recipients", "placement.verify"].includes(command);
    if (positionals.length > (selectable.includes(command) ? 1 : 0)) throw new CliError("INVALID_ARGUMENTS", "Unexpected positional arguments.");
    // A bare positional is the test code: the handle a user copies out of a report.
    const selector: Selector = positionals[0] !== undefined
      ? { test: positionals[0] }
      : Object.fromEntries(selectorKeys.flatMap(k => (values[k] === undefined ? [] : [[k, String(values[k])]])));
    const required = (key: string): string => {
      const value = values[key];
      if (typeof value !== "string" || !value) throw new CliError("INVALID_ARGUMENTS", `Missing --${key}.`);
      return value;
    };
    const { placement } = context;
    const { store, api } = placement;

    // Sign-in to a paid account will be an OAuth flow started here; until it exists, say so plainly
    // rather than fall through to an unknown command. The free tier needs no sign-in.
    if (command === "login") {
      throw new CliError("LOGIN_UNAVAILABLE", "Signing in to a paid InboxAlly account isn't available yet. The free tier works without signing in.", 6);
    }
    if (command === "doctor") {
      let stateStatus = "pass";
      try { await access(store.root, constants.R_OK | constants.W_OK); }
      catch (e) { stateStatus = (e as NodeJS.ErrnoException).code === "ENOENT" ? "warn" : "fail"; }
      const checks = [
        { name: "runtime", status: [22, 24].includes(Number(process.versions.node.split(".")[0])) ? "pass" : "warn", message: `Node ${process.versions.node}; target matrix is Node 22 and 24.` },
        { name: "local_state", status: stateStatus, message: stateStatus === "pass" ? "Local run directory is accessible." : "Local run directory is absent or inaccessible; doctor does not create it." },
        { name: "credential_store", status: "warn", message: "Credential-store integration is not implemented." },
      ];
      const data = { cli_version: VERSION, environment: store.environment, supported_contracts: ["placement.v1"], checks };
      if (api instanceof HttpPlacementApi) {
        const reachable = await api.reachable();
        checks.push({ name: "api_contract", status: "warn", message: "Free-tier transport: a contract derived by the client from the deployed service. It creates real tests." });
        checks.push({ name: "service", status: reachable ? "pass" : "fail", message: reachable ? "The placement service answered its health check." : "The placement service did not answer its health check." });
        if (!reachable) throw new CliError("SERVICE_UNAVAILABLE", "The placement service did not answer its health check.", 6, true, data);
        if (checks.some(c => c.status === "fail")) throw new CliError("NOT_READY", "A readiness check failed; see the checks.", 2, false, data);
        output(data);
        return 0;
      }
      // A value that is neither on nor off says so, rather than being reported as off.
      if (api !== unavailableApi) api.assertAvailable();
      checks.push({ name: "api_contract", status: "fail", message: "Live transport is off (INBOXALLY_LIVE=0); no connectivity probe was made." });
      throw new CliError("INTEGRATION_NOT_CONFIGURED", "Live integration is turned off.", 6, false, data);
    }
    if (command === "placement.prepare") {
      if (context.env.INBOXALLY_API_KEY !== undefined && !values.anonymous) throw new CliError("AUTH_CONTEXT_UNVERIFIED", "An environment API key is present. Paid identity validation is not implemented; no anonymous fallback was selected.", 3);
      const run = await placement.prepare(required("from"), required("platform"), required("campaign"), values.label as string | undefined);
      output({ local_request_id: run.local_request_id, expected_from: run.body.expected_from, sending_platform: run.body.sending_platform,
        domain: runDomain(run), label: run.label ?? null, campaign_reference: run.campaign_reference, auth_mode: run.auth_mode, state: run.state });
      return 0;
    }
    if (command === "placement.runs") {
      output({ runs: (await store.runs()).map(r => ({
        local_request_id: r.local_request_id, label: r.label ?? null, domain: runDomain(r),
        test_code: r.remote?.test_code ?? r.test?.test_id ?? null, run_uuid: r.remote?.uuid ?? null,
        created_at: r.created_at, environment: r.environment, state: r.state,
        superseded_by: r.superseded_by ?? null,
        // How the latest audience check was evidenced: `user_reported` means nothing compared it.
        import_evidence: r.journal.filter(e => e.event === "import_verified").at(-1)?.evidence ?? null,
        // The latest saved result, beside the workflow state: `done` with `incomplete` means the
        // workflow finished on a measurement that did not reach every recipient.
        result_status: r.snapshot?.status ?? null, validity: r.snapshot?.validation.status ?? null,
        sent_without_approval: sentWithoutApproval(r.journal),
      })) });
      return 0;
    }
    if (command === "placement.create") {
      const run = await placement.create(selector, values["second-test"] === true, context.signal, values["despite-recent-test"] === true);
      output({ local_request_id: run.local_request_id, run_uuid: run.remote?.uuid ?? null, test: run.snapshot ?? run.test });
      return 0;
    }
    if (command === "placement.import") {
      const run = await placement.adopt(required("test-code"), {
        from: required("from"), platform: required("platform"), campaign: required("campaign"),
        ...(values.label === undefined ? {} : { label: String(values.label) }),
        ...(values.uuid === undefined ? {} : { uuid: String(values.uuid) }),
      });
      output({ local_request_id: run.local_request_id, run_uuid: run.remote?.uuid ?? null, test: run.test });
      return 0;
    }
    if (command === "placement.status") {
      const result = await readStatus(placement, selector, 20000, context.signal);
      output(values.brief === true ? { summary: briefResult(result) } : { test: result });
      return 0;
    }
    if (command === "placement.watch") {
      const timeoutSeconds = values.timeout === undefined ? 300 : Number(values.timeout);
      const data = await watch(placement, selector, {
        timeoutSeconds, ...(context.signal ? { signal: context.signal } : {}),
        onProgress: result => context.stderr(progressMessage(result) + "\n"),
      }, context.watchClock);
      output(data);
      return 0;
    }
    if (command === "placement.note") {
      if ((values["details-file"] === undefined) === (values.details === undefined)) throw new CliError("INVALID_ARGUMENTS", "Give exactly one of --details-file or --details.");
      const inline = values.details !== undefined;
      const invalid = (detail: string) => new CliError("INVALID_NOTE_DETAILS", `The ${inline ? "--details value" : "details file"} ${detail}.`);
      const raw = inline ? String(values.details) : await readBoundedUtf8(required("details-file"), DETAILS_FILE_LIMIT, invalid);
      if (inline && Buffer.byteLength(raw, "utf8") > DETAILS_FILE_LIMIT) throw invalid(`must be at most ${DETAILS_FILE_LIMIT} bytes`);
      let details: unknown;
      try { details = JSON.parse(raw); } catch { throw invalid("must contain a JSON object"); }
      if (typeof details !== "object" || details === null || Array.isArray(details)) throw invalid("must contain a JSON object");
      const entry = await placement.note(selector, required("event"), required("evidence"), details);
      // Recording a send is never refused, since it records what happened; one that no send
      // approval preceded is said so plainly.
      const run = entry.event === "send_confirmed" ? await placement.select(selector) : undefined;
      output({ entry, ...(run && unapprovedSends(run.journal).includes(entry.sequence - 1) ? { sent_without_approval: true } : {}) });
      return 0;
    }
    if (needsTest) {
      const run = await placement.select(selector);
      if (!run.test) throw new CliError("STATE_UNAVAILABLE", "That run has no allocated test yet.");
      const manifest = validateManifest(run.test, api.reportOrigins, run.body, run.test.test_id);
      if (command === "placement.verify") {
        // Comparing the test with this CLI's own export always matches, so it says nothing about
        // what the sending platform holds. Only the platform's export of the list is evidence.
        const source = await realpath(required("recipients-file")).catch(() => undefined);
        const input = await readRecipientFile(required("recipients-file"));
        const digest = createHash("sha256").update(input).digest("hex");
        if (run.exports.some(e => e.path === source && e.sha256 === digest)) {
          throw new CliError("VERIFY_SELF_COMPARISON", "That file is still this CLI's own recipient export, so it always matches. Export the list's members from the sending platform and verify that.", 5);
        }
        const result = verifyRecipients(manifest, parseRecipients(input));
        if (!result.matches) throw new CliError("RECIPIENT_MISMATCH", "Audience membership differs from the test manifest.", 5, false, result);
        output(result);
      } else {
        const contents = exportRecipients(manifest, required("format"));
        if (values.output) {
          // Recorded before the file is written: if the run is locked, nothing reaches the disk and
          // a plain retry works. A record whose file was never written adds a digest nothing on
          // disk matches, and replaces nothing; an export on disk that was never recorded would pass
          // verify unnoticed.
          // Written through a symlink, the record would name the link while verify resolves the
          // file it points to, so such an output is refused.
          const existing = await lstat(required("output")).catch(() => undefined);
          if (existing?.isSymbolicLink()) throw new CliError("INVALID_ARGUMENTS", "The export path is a symbolic link. Give the real file path.");
          // Refused before anything is recorded, so a refusal costs no record.
          if (existing && !values.overwrite) throw new CliError("OUTPUT_EXISTS", "The export already exists. Use --overwrite only with explicit permission.");
          // An existing file is recorded under the name the filesystem resolves it to, which is what
          // verify will look up, even when it was named here in another letter case.
          const target = existing ? await realpath(required("output")) : join(await realpath(dirname(required("output"))), basename(required("output")));
          await placement.recordExport({ request: run.local_request_id }, target, contents);
          let file;
          try { file = await open(required("output"), values.overwrite ? "w" : "wx", 0o600); }
          catch (e) {
            if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new CliError("OUTPUT_EXISTS", "The export already exists. Use --overwrite only with explicit permission.");
            throw e;
          }
          try { await file.writeFile(contents); } finally { await file.close(); }
          context.stderr("Exported 16 recipient records.\n");
        } else context.stdout(contents);
      }
      return 0;
    }
    unavailable();
  } catch (error) {
    const e = error instanceof CliError ? error : new CliError("INTERNAL_ERROR", "An unexpected error occurred; local request state is preserved.", 1);
    const envelope = {
      schema_version: "cli.v1", ok: false, command: safeText(command), data: e.data,
      error: { code: e.code, message: safeText(e.message), retryable: e.retryable, request_id: null,
        ...(e.details.retry_after_seconds === undefined ? {} : { retry_after_seconds: e.details.retry_after_seconds }),
        ...(e.details.api_request_id === undefined ? {} : { api_request_id: safeText(e.details.api_request_id) }),
        ...(e.code === "INTERNAL_ERROR" ? { diagnostic_id: randomUUID() } : {}) },
    };
    if (json) context.stdout(JSON.stringify(envelope) + "\n");
    else context.stderr(JSON.stringify(envelope, null, 2) + "\n");
    return e.exitCode;
  }
}
