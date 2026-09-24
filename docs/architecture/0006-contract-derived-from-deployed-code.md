# 0006: Build the free-tier adapter against a contract derived by the client

Status: accepted client decision, 2026-09-22, by the maintainer. Reverses one part of
[0004](0004-service-minted-run-identity.md): the client now proposes the run UUID. This is an
explicit exception to the rule that live transport waits for an approved contract.

## Context

The CLI cannot run a real test until it has an HTTP adapter, and the adapter was waiting for the
placement service to publish a contract. The free flow uses only two unauthenticated routes, and
their behavior could be established without waiting. The maintainer decided not to wait.

## Decision

1. **Use a contract derived by the client.** It is recorded in
   [the derived contract](../placement-service-contract.md), labelled everywhere as derived, not
   approved. When the service publishes a contract, it governs, and any difference is a defect in
   the client to resolve.
2. **The adapter validates strictly and fails loudly.** A response that does not match the
   derived shape is an error that preserves the run. It is never mapped by guesswork, so a change
   on the service side surfaces at once.
3. **The CLI mints the run UUID and persists it before creating.** It is the run's local request
   id, saved when the intent is prepared. A replayed UUID returns the existing test, so after a
   lost create response the adapter replays the same UUID instead of creating again: once itself,
   after waiting longer than the 20-second request timeout, and again whenever `placement create`
   is run for the same intent. The wait makes a replay overlapping a first request still in
   progress rare; the client alone cannot make it impossible, and the CLI's lock only keeps two
   local processes from racing.
   This is how the client upholds the first invariant in `CLAUDE.md`, one intent, one
   allocation, as far as it can without the service's guarantee. The UUID and the test code are
   both capabilities: results are readable by test code alone and include the UUID, and a
   replayed UUID returns the address and seeds. Both are shown to the user who owns the test and
   kept out of anything shared, as report links already are; hiding one while showing the other
   would protect nothing.
4. **Fields the service does not return are the client's own.** These are the list name and the
   report link: the InboxAlly app's guest report page for the test code and UUID, the page the app
   itself links a guest test to. **The send deadline is the service's** when it states one
   (`expiresAt` on the create response). From a service that does not, the client derives it as
   10 minutes from the service's
   own `createdAt`, read straight after creation and shifted onto the local clock by the
   difference `serverNow` shows. A replay reads the same `createdAt`, so the deadline cannot drift
   later. The list name is derived from the test code.
5. **Every live run needs explicit approval.** Building and testing the adapter against recorded
   responses needs none. A run against production creates a real test, sends real mail to real
   seed mailboxes, and uses the sending domain's real daily test, so each run needs the
   maintainer's approval, from a sending domain that is not InboxAlly's.

## In effect

The free-tier adapter implements this. It was first off by default behind `INBOXALLY_LIVE=1`; on
2026-09-23 the maintainer made it the default, trusting the service team to keep the fields the
CLI reads stable (a CI contract check is requested on the service's side), with `INBOXALLY_LIVE=0`
to work offline. Its
recovery guidance — create again after `allocation_unknown`, which replays the same request — is in
`docs/support.md` and the skill's `references/cli.md`.

## Open product questions

- **The send deadline and the approvals.** Resolved on two fronts: the skill now creates the test
  only when the user can send at once, and the service's split clocks give an anonymous test 4
  hours to receive the campaign. The 10-minute constraint remains only for a service without them.
- **Paid plans.** Whether a paid plan reserves allowance at creation is still undecided.

## Consequences

- The provisional `placement.v1` projection in `packages/cli/src/manifest.ts` and `results.ts`
  was a proposal. The adapter maps the real responses onto the CLI's guarantees; the parts the
  service cannot supply are either derived by the client or dropped.
- Anything the derived contract gets wrong is a client defect, found by strict validation or by a
  live run, and fixed here.
