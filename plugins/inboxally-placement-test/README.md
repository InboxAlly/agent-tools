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
  `npx -y @inboxally/cli@0.1.0`, which downloads it from the npm registry. It needs Node.js 22 or
  later. The CLI's source is in
  [this repository](https://github.com/InboxAlly/agent-tools/tree/main/packages/cli), and the npm
  package carries provenance from that repository's release workflow.
- **The CLI's requests** go only to the InboxAlly placement service at `https://ipt.inboxally.com`:
  creating a test sends a random request id; reading results sends the test code. These requests
  carry no email content, contacts or credentials. Report links point to `https://app.inboxally.com`.
- **Your campaign** goes, when you approve the send, from your own sending platform to the 16 test
  addresses: 15 seed mailboxes at Gmail, Outlook and Yahoo, and one InboxAlly address. That is the
  test: InboxAlly reads where it landed and checks its authentication.
- **Your sending platform** is changed only through the tools your agent already has for it, and
  only after you approve each import and each send. The CLI itself never sends email or changes
  contacts.
- **Stored locally** by the CLI, so an interrupted test can resume: the sender, sending platform,
  campaign reference and optional label; the request id, test code and run id; the 16 test
  addresses and list name; the latest results; the paths and digests of recipient files it wrote;
  and a log of each step and approval. Nothing is stored remotely by the plugin.

## Requirements and limits

- Free, with no account: one test per sending domain per day, from your own domain (free-mail
  From addresses are refused).
- Paid sign-in to an InboxAlly account is not available yet.

## License

MIT. See [LICENSE](LICENSE).
