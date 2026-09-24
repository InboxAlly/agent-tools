# Security

This project is the `@inboxally/cli` client and the placement-test skill. Report anything that
looks like a vulnerability.

## Reporting a vulnerability

Email **support@inboxally.com** with this subject line:

```
SECURITY REPORT: agent-tools - <one-line summary>
```

Keep the `SECURITY REPORT: agent-tools` prefix exactly. It is what lifts the message out of
general support triage and routes it to the InboxAlly engineering team.

Do not open a GitHub issue, pull request, or discussion for a vulnerability, and do not post it
anywhere public before we have had a chance to respond.

Please include:

- What an attacker can do, and what access they need to do it.
- The CLI version (`inboxally --version`), operating system, and Node version.
- Exact commands or steps to reproduce, with run-specific values replaced by placeholders.
- Whether the issue is already public or was reported elsewhere.

Please do not include, in the email or in any attachment:

- Credentials, API keys, or session material of any kind.
- Report URLs — a bearer link may grant access to a real report.
- Customer campaign content, real recipient addresses, or whole local state files. Describe the
  state instead, and use reserved example domains in any sample.

Where a proof of concept is possible against the synthetic loopback demo (`npm run demo`), that
is the safest form to send.

## What happens next

We acknowledge your report, investigate it, tell you what we find, and let you know when a fix
ships. Please give us a reasonable chance to fix the issue before disclosing it publicly. If you
would like credit in the changelog when the fix lands, say so and we will include it.

## Scope

This repository covers the CLI client and the skill. The CLI reaches the placement service's free tier
by default; `INBOXALLY_LIVE=0` keeps it offline, and the tests, demo and package check never reach it. Findings in the InboxAlly service, API, or
web application go to the same address — say which one in your summary line.

## Current security posture

The CLI has no public arbitrary API-origin override or mock switch. The free-tier transport is on
by default (`INBOXALLY_LIVE=0` turns it off), pinned to the placement
service's origin, which never follows redirects and sends only the run's request id when creating and the test code when reading; both are capabilities. Test fixtures and the loopback server are excluded from the npm
package. Code scanning and
dependency review run on this repository's pushes and pull requests.
