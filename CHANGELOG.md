# Changelog

## 0.1.0

First public release.

- **CLI** (`@inboxally/cli`): creates a free placement test on the InboxAlly placement service,
  with a request id saved first so a lost response is recovered rather than repeated; exports and
  verifies the exact 16-address audience; records a workflow journal whose entries drive recovery
  after an interruption; reads results with bounded polling, naming missing and unreachable test
  mailboxes and carrying the service's own verdict and rates, checked against the rows; stops a
  same-day second test for a domain before it is created, and reports when a refused domain may
  test again. `status --brief`, `runs`, `note --details` and `doctor` are built for agents.
  `login` is a placeholder for paid sign-in.
- **Skill** (`inboxally-placement-test`): guides an agent through the test on the user's real
  campaign and sending platform, with separate identity, import and send approvals, a short flow
  for sending from Gmail or Outlook, and results reported only as measured. Installable as a
  Claude Code plugin.
- **Evals**: a grader for recorded agent transcripts, a recording harness with a synthetic
  sending platform and service, and recorded runs for Claude Opus 5.5, Sonnet 5 and Haiku 4.5.
