# InboxAlly agent tools

Run an [InboxAlly](https://www.inboxally.com) inbox placement test with your AI agent. You send
your real campaign, from your real sending platform, to 16 test addresses InboxAlly supplies, and
the agent reports where it landed: inbox, spam or missing, by provider.

The agent does the fiddly parts and asks before anything changes:

- creates the test and hands you the exact 16 addresses and list name;
- checks the list on your platform, or the recipients you paste back, against the test before
  anything is sent;
- asks separately before importing contacts and before sending;
- reads the results, and reports only what was measured.

## Install

In Claude Code:

```
/plugin marketplace add InboxAlly/agent-tools
/plugin install inboxally-placement-test@inboxally
```

Then ask: *"Run an InboxAlly placement test on my latest newsletter."*

The skill runs the InboxAlly CLI through `npx`, so there is nothing else to install. It needs
[Node.js](https://nodejs.org) 22 or later.

Other agents: copy [`skills/inboxally-placement-test/`](skills/inboxally-placement-test/) into
your agent's skills folder. The CLI is on npm as
[`@inboxally/cli`](https://www.npmjs.com/package/@inboxally/cli).

## What to expect

- **Free, no account.** One test per sending domain per day. The campaign must come from your
  own domain: a From address at a free-mail provider (gmail.com, outlook.com and similar) can't be
  tested. Sending through Google Workspace or Microsoft 365 from your own domain works.
- **Send soon after the test is created.** The agent creates the test only when you're ready and
  tells you the deadline.
- **Your platform, your approval.** Nothing is imported or sent without your explicit yes. Test
  lists are left in place afterwards unless you ask the agent to remove them.
- **Honest results.** Missing or unreachable test mailboxes are named, and a result is only called
  valid when every address received it from your sender.
- **Private links.** The test code and report link give access to your report; keep them to
  yourself.
- **Models.** Validated with Claude Opus 5.5 and Claude Sonnet 5. Claude Haiku 4.5 is not
  supported.
- **Paid accounts.** Signing in to a paid InboxAlly account is coming soon.

## What's here

- [`skills/inboxally-placement-test/`](skills/inboxally-placement-test/): the agent skill.
- [`packages/cli/`](packages/cli/): the `@inboxally/cli` command-line tool.
- [`evals/`](evals/): a grader for agent behavior, with recorded runs.
- [`docs/`](docs/): how the CLI reads the placement service, decisions, and
  [what is verified](docs/validation.md).

## Develop

```sh
npm ci
npm run check          # type-check
npm test               # build and run the tests
npm run demo           # a synthetic end-to-end run; no real service or email
npm run package:check  # pack and install the CLI, then run it offline
```

A CLI built from source reaches the real placement service by default and creates real tests;
set `INBOXALLY_LIVE=0` to work offline. See [CONTRIBUTING.md](CONTRIBUTING.md) and
[CLAUDE.md](CLAUDE.md) for how changes are made and the rules they defend.

## Security and license

Report security issues as [SECURITY.md](SECURITY.md) describes. MIT licensed; see
[LICENSE](LICENSE). The license grants no rights to InboxAlly's marks, as
[TRADEMARK.md](TRADEMARK.md) explains.
