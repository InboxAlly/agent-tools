# InboxAlly placement test

A Claude Code plugin that runs an [InboxAlly](https://www.inboxally.com) inbox placement test on
your real email campaign. You send your campaign, from your normal sending platform, to 16 test
addresses InboxAlly supplies, and the agent reports where it landed: inbox, spam or missing, by
provider (Gmail, Outlook, Yahoo).

It contains one skill, `inboxally-placement-test`. Ask, for example: *"Run an InboxAlly placement
test on my latest newsletter."*

## What it does, step by step

1. Confirms your sender, sending platform and campaign with you.
2. Creates a free test, which supplies the 16 test addresses and a list name.
3. Asks before creating a list or importing contacts on your platform, then checks the list's
   members (or the recipients you paste back from Gmail or Outlook) against the test.
4. Asks separately before sending, then reads the results and reports only what was measured.

## What it runs, sends and stores

- **Runs** the InboxAlly CLI, pinned to an exact version, through npm:
  `npx -y @inboxally/cli@0.1.0`. It needs Node.js 22 or later. The CLI's source is in
  [this repository](https://github.com/InboxAlly/agent-tools/tree/main/packages/cli), and the npm
  package carries provenance from that repository's release workflow.
- **Sends** requests only to the InboxAlly placement service at `https://ipt.inboxally.com`: to
  create a test (sending a random request id) and to read its results (by test code). No email
  content, contacts or credentials are sent to it. Report links point to
  `https://app.inboxally.com`.
- **Stores** each test's state (sender, campaign label, test code, the 16 test addresses, results,
  and a log of approvals) in a local folder for the InboxAlly CLI, so an interrupted test can resume.
- **Changes your sending platform** only through the tools your agent already has for it, and only
  after you approve each import and each send. The CLI itself never sends email or changes contacts.
- Sends nothing anywhere else.

## Requirements and limits

- Free, with no account: one test per sending domain per day, from your own domain (free-mail
  From addresses are refused).
- Paid sign-in to an InboxAlly account is not available yet.

## License

MIT. See [LICENSE](LICENSE).
