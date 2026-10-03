# CLI reference and recovery

Version `0.1.0`, run as `npx -y @inboxally/cli@0.1.0` (Node 22 or later); `inboxally` below
means that command. Logical contract: `placement.v1`. Always use the pinned version, never an
unversioned package.

```text
inboxally --help
inboxally --version
inboxally doctor --json
inboxally placement prepare --from <address> --platform <slug> --campaign <reference> [--label <name>] [--anonymous] --json
inboxally placement runs --json
inboxally placement create <run> [--second-test] [--despite-recent-test] --json
inboxally placement import --test-code <code> --from <address> --platform <slug> --campaign <reference> [--label <name>] [--uuid <run-uuid>] --json
inboxally placement status <run> [--brief] --json
inboxally placement watch <run> --timeout 300 --json
inboxally placement recipients <run> --format text|csv|json [--output <path>] [--overwrite]
inboxally placement verify <run> --recipients-file <path> --json
inboxally placement note <run> --event <event> --evidence tool_observed|user_reported (--details-file <path> | --details <json>) --json
inboxally login
```

## Developing the CLI

Only for a user who says they are developing this repository. Build from source with `npm ci`
and run `node packages/cli/dist/index.js` in place of `inboxally`. `npm run demo` exercises the
workflow against synthetic data with its own temporary state. A built CLI reaches the real
service by default; `INBOXALLY_LIVE=0` keeps it offline, and nothing else is a dry run.

## Commands and modes

`inboxally login` is where signing in to a paid account will start. It is not available yet and
returns `LOGIN_UNAVAILABLE` (exit 6); tell a user who asks that paid sign-in is coming and that the
free tier needs no sign-in.

The CLI has no mock/URL override. `create`/`import`/`status`/`watch` use the free tier of the real
service, which creates real tests: send before the send deadline the CLI reports for the test
(`send_before`), or it expires. With
`INBOXALLY_LIVE=0` they report `INTEGRATION_NOT_CONFIGURED` (exit 6); prepare/runs work locally.
Paid sign-in and opening the report in a browser are not available yet.

## Selecting a run

Every command that acts on a run takes its test code as a positional argument, or exactly one
of `--domain`, `--label`, `--test`, `--uuid`, `--request`. Prefer `--domain` or `--label`: they
are what the user recognises. Selection narrows before it refuses — an intent with no allocated
test is not a candidate while an allocated run exists — and stops with `AMBIGUOUS_SELECTION`
(exit 2) listing the candidates rather than guessing between two live runs.

## Identity, creation, and recovery

The CLI sends the run's saved request id as its UUID, and the placement service mints the test
code; the CLI persists them when the response parses and never invents a test code. Creation reserves no allowance, so:

- `create` allocates for the selected intent, and returns the existing test unchanged if one is
  already allocated. It refuses (`DOMAIN_RUN_ACTIVE`, exit 5) when that sending domain already
  has an unfinished test, because two live address lists mean a campaign can reach a test nobody
  is watching. `--second-test` is the explicit way past that, and needs the user's intent.
- A create attempt that does not return leaves the run `allocation_unknown`: a test may exist
  that this client cannot name. Creating again is safe: it replays the same request, so the
  service returns the test the first attempt made, if it made one, and creation reserves no
  allowance. Do not hunt for the test another way, and do not treat it as a lost allowance.
- `create` also refuses (`DOMAIN_RECENTLY_TESTED`, exit 4) when a saved run for that domain was
  measured in the last 24 hours, or was refused as rate limited with a retry time still ahead:
  the free tier allows one test per domain per day, so the service would very likely refuse the
  new one after the user has done the sending.
  Tell the user when it should be available (`likely_available_after`); pass
  `--despite-recent-test` only if they want to try anyway.
- `import` adopts a run created without the CLI, which is what a session using the API directly
  produces. Give it the test code, and the run UUID when you have it; a mismatch is refused
  (`RUN_IDENTITY_MISMATCH`, exit 5) and writes nothing.

Reads resolve a test code to its most recent run, and a second delivery to the test address
starts one. When that happens the snapshot is still saved — it is the user's latest measurement
— and `placement runs` reports `superseded_by`. Report those numbers as belonging to a later
send, never as the measurement of the campaign the user approved.

JSON commands return one `cli.v1` object on stdout with `ok`, `command`, `data`, and `error`.
Errors include `code`, safe `message`, `retryable`, and `request_id` (null for local errors).
Recipient exports intentionally output an address array, one address per line, or an `email`
CSV column instead. File export emits its success notice on stderr, refuses overwriting
unless explicitly requested, and refuses an expired send window.

Current exit meanings: 0 success; 1 internal failure; 2 input/state/lock issue; 3 unverified
paid context; 4 quota/throttling; 5 manifest/result/audience/approval validation; 6
unavailable/unknown outcome; 7 local watch timeout; 8 expired or insufficient send window or
unusable terminal measurement; 130 interrupted read/watch. Status exits 0 for a successful lookup even when incomplete.
Watch exits 8 for incomplete/expired/failed or complete-but-invalid results. Complete with
unknown validity is returned honestly and is not described as validated.

`status --brief` returns a `summary` with the outcome, validity, per-placement totals, the
service's own figures and the report link, without the manifest or per-recipient rows; use it for
reporting, and the full result when you need rows. `placement runs` shows each run's
`result_status` and `validity` beside its workflow `state`: `done` with `incomplete` means the
workflow finished on a measurement that did not reach every recipient. `note` takes its details
as `--details '<json>'` or `--details-file <path>`. Recording `send_confirmed` is never refused;
if no `send_approved` preceded it, the output and `runs` say `sent_without_approval: true`, and
the report says the send was made before approval; `--help` lists the accepted `--platform`
values.

Watch emits progress on stderr and exactly one JSON envelope on stdout. Default duration is
300 seconds, maximum 900. It polls no faster than 15 seconds or the server delay, honors
Retry-After, and attempts transient reads at most three times consecutively. A local timeout
or cancellation returns the latest safe snapshot and never cancels/deletes/replaces the test.

Verify the platform's export of the list's members, never the CLI's own recipient export: that
comparison always matches. `verify` refuses a file that is still exactly what `recipients
--output` wrote (`VERIFY_SELF_COMPARISON`, exit 5). It cannot recognise an export printed to
stdout and saved by hand, or a copy of an export at another path, because a real platform
export can be byte-identical to the CLI's. The rule still applies there.

`RECIPIENT_MISMATCH` keeps the comparison in `data`. Missing/unexpected/duplicate details
must be resolved before sending. Membership matching is not verification of sendability.

## Workflow journal and recovery states

`placement note` appends one validated observation to the selected run and returns
`{entry}` with `sequence`, a CLI-generated `recorded_at`, `event`, `evidence`, `details`,
and the resulting `state`. It never contacts the API and never authorizes a platform action.
`placement runs` reports each run's current `state`; use it, not conversation memory, to
choose the safe next action after an interruption:

| State | Safe next action |
| --- | --- |
| `prepared` | Create only after identity confirmation and when the user is ready |
| `allocation_unknown` | Create again for the same intent; it replays the same request and returns the same test if one was made. This includes a create stopped with `INTERRUPTED` (exit 130) |
| `allocated` | Validate the manifest; read-only platform checks |
| `awaiting_import_approval` | Wait for the user's response |
| `import_outcome_unknown` | Inspect the exact list/object and full membership; stop if the outcome cannot be established |
| `import_verified` | Prepare the selected campaign and request final send approval. If `placement runs` shows `import_evidence: user_reported`, the user skipped the audience check: say the audience is not verified |
| `awaiting_send_approval` | Wait; material changes require a renewed review |
| `send_outcome_unknown` | Inspect platform send history and result evidence; never resend |
| `send_confirmed` | Read placement results |
| `watching` | Continue bounded polling or return the current state |
| `done` / `stopped` | Explain the outcome and preserve state; cleanup is a separate request |

Events are the states above from `awaiting_import_approval` onward plus `import_approved`
and `send_approved`. Recording an approval moves the run to the matching outcome-unknown
state, because the platform action may then happen at any moment; `import_verified` or
`send_confirmed` resolves it. A note cannot claim `prepared`, `allocation_unknown`, or
`allocated`; the CLI owns those. `status` and `watch` do not change the workflow state.

The details file is a JSON object of at most 16 KiB containing only `platform`,
`workspace_label`, `from`, `subject`, `list_name`, `recipient_count`, `esp_object_id`,
`observed_at`, and `note`. Other keys, credentials, campaign bodies, control characters, and
oversized values are rejected (`INVALID_NOTE_DETAILS`, exit 2). `import_approved` must record
`list_name` and `recipient_count`; `send_approved` must record `from`, `subject`, `list_name`,
and `recipient_count`. Approval details that differ from the test's platform, sender, exact
list name, or count are refused (`APPROVAL_MISMATCH`, exit 5). Send-oriented events are
refused after the send cutoff (`SEND_WINDOW_EXPIRED`, exit 8), and `send_approved` needs at
least 120 seconds remaining (`SEND_WINDOW_INSUFFICIENT`, exit 8); outcome events such as
`send_outcome_unknown`, `send_confirmed`, and `stopped` remain recordable.

Before release, replace this availability section with an exact published CLI version and
tested installer commands. Disclose required npm execution and respect host permissions.
Skill updates and global CLI updates are separate; never substitute another version silently.
