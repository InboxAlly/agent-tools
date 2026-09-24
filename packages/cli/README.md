# @inboxally/cli

The command-line tool behind the InboxAlly placement-test skill. It creates a free inbox
placement test, gives you the exact 16 test addresses, checks your sending platform's list against
them, and reads the placement results, with durable local state so an interrupted run can resume.

It never sends email or changes your sending platform; you, or your agent with your approval,
do that.

```sh
npx -y @inboxally/cli@0.1.0 --help
```

Requires Node 22 or later. Most people use it through the agent skill; see the
[repository README](https://github.com/InboxAlly/agent-tools#readme).

- Reaches the InboxAlly placement service's free tier, which creates real tests (one per sending
  domain per day). Set `INBOXALLY_LIVE=0` to work offline.
- `inboxally doctor --json` checks readiness, including the service's health.
- Paid sign-in (`inboxally login`) is not available yet.

MIT licensed.
