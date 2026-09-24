# What is verified

A summary of the evidence behind this release. Each line says what was checked and how, and
what was not.

## CLI

- **Behavioral tests.** `npm test` runs the CLI and grader suites on Node 22 and 24 across Linux,
  macOS and Windows in CI. They cover creation and replay after a lost response, interruption,
  exact audience comparison, the workflow journal and its recovery states, result validation
  (missing and unreachable seeds, the service's own figures reconciled against the rows, refused
  and expired tests, a later run on the same test code), bounded watching, run-file upgrades, and
  the free-tier transport against a fake of the service's two routes.
- **Synthetic demo.** `npm run demo` exercises a lost allocation response, recovery, audience
  verification, the journal and result polling against a loopback synthetic service.
- **Package.** `npm run package:check` packs the CLI, installs the tarball with an isolated cache,
  and runs the installed executable offline.

## Against the real placement service

Live runs on the free tier, sending from Google Workspace with the testers in BCC:

- Creating a test, verifying the audience, reading results as the measurement arrives, and a
  finished result whose seeds, missing and unreachable seeds, verdict and rates matched the
  InboxAlly app's report page for the same test.
- A same-day second test for a domain, refused as rate limited, with the service's retry time.

Not yet run live: a marketing platform (Mailchimp, Klaviyo and the others are covered by the skill's
platform guidance, which is not yet certified for any of them), and the service's longer
anonymous send window, which the CLI reads from the service when stated.

## Agent behavior

`evals/` grades recorded agent transcripts against rules the skill owns: approval boundaries,
existing lists, audience mismatches, the real send path, ambiguous sends, partial results,
unreached recipients, wrong senders, restarts, a skipped native-mail check, journal accuracy, and
what an agent offers a user without the CLI. Each agent ran in its own process outside the
repository, except the first Sonnet and Haiku round (`evals/runs/2026-09-22-*` without
`isolated` or `repeats`), which could read the repository's own maintainer notes:

| Model | Runs | Result under the current rules |
| --- | --- | --- |
| Claude Opus 5.5 | 33: 24 on a marketing platform across seven scenarios, 5 native mail, 4 without the CLI | 7 runs with a violation, all fixed in the skill and rerun: 3 journaled a list check before reading it (fixed; 4 later runs clean), and 4 ran the first native-mail flow, which took a pasted-back audience as the send approval (fixed with a separate approval; the rerun is clean) |
| Claude Sonnet 5 | 27: 23 on a marketing platform, 3 native mail, 1 without the CLI | 2 runs with a violation, both on that first native-mail flow; the rerun on the final flow is clean |
| Claude Haiku 4.5 | 8 on a marketing platform | 6 runs broke approval, existing-list or mismatch rules; not supported |

Every run is graded under today's rules, including runs recorded before a rule existed.

The recorded traces are in `evals/runs/`; `npm run eval -- <trace>` regrades any of them. All
eval data is synthetic.
