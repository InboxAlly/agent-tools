# Development support and state

`--help`, `--version`, `doctor`, and listing an absent run directory do not initialize state
or allocate tests. `placement prepare` writes only a local intent. `create`/`import`/`status`/`watch` use
the free-tier transport against the real service by default
([decision 0006](architecture/0006-contract-derived-from-deployed-code.md)), which creates real
tests. With `INBOXALLY_LIVE=0` they stop with `INTEGRATION_NOT_CONFIGURED` (exit 6) instead.

Run state lives below the platform application-data directory:

- macOS: `~/Library/Application Support/inboxally/production/runs/`
- Linux: `${XDG_DATA_HOME:-~/.local/share}/inboxally/production/runs/`
- Windows: `%LOCALAPPDATA%/inboxally/production/runs/`

State contains sender, campaign reference, request ID, timestamps, and the run's state.
Allocated state includes the validated manifest, the latest validated result snapshot, and the
workflow journal written by `placement note`: sequence, CLI timestamp, event, evidence type,
and validated details (platform, workspace label, From, subject, list name, recipient count,
platform object ID, observed time, note). The journal never contains credentials, campaign
bodies, or recipient exports. Retain state until explicit removal. Remote report retention is
separate; local state cannot recover an expired or revoked remote report.

Run files are `local_schema_version` 7. Version 1 predates the journal, version 2 predates
service-minted identity and labels, version 3 predates recorded exports, version 4 predates
the record of runs seen, version 5 predates missing and unreachable seeds and the service's
own figures in a result, and version 6 predates a refused result's retry time; all load through an
in-memory upgrade and are rewritten as version 7 on
the next save. In a version 5 production snapshot, a seed the service could not check becomes
unreachable, and an unseen seed in a measurement the service completed becomes missing, exactly
as a fresh read now reports them; the snapshot has no service figures until its next read. An older build rejects a
newer file as `STATE_INVALID` rather than misreading it. Version 4 records the path and SHA-256
digest of each recipient export written with `--output`, never its contents, so `verify` can
refuse a file that is still the CLI's own export. Records are only added, never replaced. A run
holds up to 64, after which a new export is refused (`EXPORTS_FULL`) rather than an old record
forgotten. An export path that is a symbolic link is refused. A file whose state disagrees with its journal is rejected the same way. See
[the journal decision](architecture/0002-local-workflow-journal.md) and
[run identity](architecture/0004-service-minted-run-identity.md). Version 5 records every run UUID a read has resolved to, starting with the test's own, so a read
that goes back to an earlier run is refused; an upgrade seeds it from the saved identity.

An allocated run also stores its identity: the run UUID, the test code, and the test's own
address. The free-tier transport sends the local request id as the run UUID, so the two are the
same value there. Both identifiers are capabilities — whoever holds either can
read that report and create a public share link — so they are handled like report URLs and kept
out of tickets, screenshots and logs, and so is the local request id.
Never paste whole state files into support tickets; report URLs may grant report access.
Paid and anonymous capability storage is not implemented. POSIX private file/directory
modes are requested; Windows ACL handling remains a release gate.

Writes use a temporary file, fsync, and rename. An exclusive lock prevents concurrent calls
from changing the same request. `REQUEST_BUSY` can be retried once the other process exits.
After a crash, verify no process owns the request before manually removing only its `.lock`
file. Preserve the JSON request record and original request ID. Corrupt or missing state
must never trigger automatic replacement allocation. A creation attempt that does not return
leaves the run `allocation_unknown`, meaning a test may exist that this client cannot name. With
the free-tier transport, creating again replays the same request id, so the service returns the
test the first attempt made, if it made one; the transport itself replays once after a pause
before reporting the outcome unknown. An interrupt (Ctrl-C) during creation stops the wait,
releases the lock and leaves the same `allocation_unknown` state, with the same recovery; only a
hard kill leaves a lock behind. Creation reserves no allowance either way.

Runs are selected by sending domain, label, test code, run UUID, or local record id. An
ambiguous selection stops with `AMBIGUOUS_SELECTION` and lists the candidates; support should
never resolve it by picking the most recent. A sending domain keeps one live address list, and
`DOMAIN_RUN_ACTIVE` reports the unfinished test that already holds it.

After an interruption, `placement runs` reports each run's workflow state. An approval that
was recorded but never resolved leaves the run in `import_outcome_unknown` or
`send_outcome_unknown`; inspect the sending platform before acting and never resend.

`placement verify` validates membership only. It cannot establish sendability, suppression
status, full ESP pagination, approval, or actual send evidence.
