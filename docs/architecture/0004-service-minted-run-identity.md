# 0004: The placement service mints run identity; the client persists what it is given

Status: accepted client decision, 2026-09-22, after reading the deployed placement service and
confirming its behavior. Supersedes an earlier design (0003) for an anonymous context bootstrapped before creation. Its choice that
the client proposes no identity is reversed by [0006](0006-contract-derived-from-deployed-code.md),
with the free-tier adapter: the client will mint and persist the run UUID before creating, and
recover a lost response by replaying it, not by creating again. Until the adapter lands, this
decision describes the code. The service's written contract has been requested.

## What the service actually does

Earlier decisions were written against the specification's proposed API rather than a running
service. The deployed service behaves differently in four ways that matter to this client.

- **Creation reserves nothing.** A test can be created without consuming any allowance. The
  free tier's limit — one test per sending domain per day — is applied when the campaign
  arrives at the test address, not when the test is created. A test whose response is lost
  costs the user nothing, and nothing is ever sent to it.
- **The service mints run identity.** Creation returns a run UUID, a test code, and the seed
  addresses. A caller may supply a UUID, in which case an existing test is returned and an
  unknown one is adopted. This decision did not rely on adoption; decision 0006 does.
- **Reads resolve to the most recent run.** Reading results or status by test code returns the
  latest child run when one exists, and a second campaign delivered to the same test address
  creates such a child. The payload names the run it resolved to.
- **The audience is fifteen seed mailboxes plus the test's own address.** The sixteenth address
  belongs to InboxAlly, receives the campaign, and supplies header and authentication analysis.
  This confirms the fixture's fifteen-plus-one split, which was previously provisional.

## Decision

Run identity belongs to the service. The client creates without proposing an identity, persists
the returned UUID and test code the moment the response parses, and uses them unchanged for
every later request. It never invents, derives, or regenerates them.

Local identity stays local. `local_request_id` continues to name the run file and its lock, is
created during `prepare`, and is never transmitted. It exists so a record of intent exists
before any remote test does.

### Persistence and selection rules

- **Persist before display.** The run record is written before the agent reports anything to
  the user. A user must never hold an address list the client cannot name.
- **Select by what a human knows.** Runs are selected by sending domain, by an optional label,
  or by test code or UUID. A selector that matches more than one run stops and lists the
  candidates; the client never guesses which run was meant.
- **One live list per domain.** Creating for a domain that already has an unsent active run
  stops. The user resumes that run or asks explicitly for a new one. This prevents a user
  holding two address lists for one domain and sending to the wrong one.
- **Compare identity on every read.** A read that resolves to a different run than the one
  recorded is reported as a later send, never presented as the approved campaign's measurement.
- **Treat both identifiers as capabilities.** Anyone holding the UUID or test code can read the
  report and create a public share link. They receive the same handling as report URLs: private
  file modes, never logged, excluded from diagnostics.

## Why

Persisting a client-minted identity before creation existed to make a lost response recoverable
when creation atomically reserved a scarce allowance. Against this service there is no
reservation to protect: a lost response leaves an unnamed test that consumes nothing and that
nothing is sent to. Carrying the machinery anyway would mean maintaining recovery rules for a hazard that
does not exist, and asking the service to add an idempotency key to restore a property we no
longer need.

The invariant "one intent, one allocation" is kept, with its justification replaced. It is no
longer about protecting quota. It is about user clarity: two live tests for one domain means two
address lists, and a campaign sent to the wrong one produces a measurement for a test nobody is
watching.

## Consequences

- `prepare` records the sending domain and an optional label. `create` takes a selector rather
  than a caller-supplied request identity.
- `allocation_unknown` changes meaning. It records that a creation attempt did not return, so a
  test may exist that this client cannot name. Creating again is safe: the unnamed test reserves
  nothing, and nothing is sent to it. With the free-tier transport of decision 0006, creating
  again replays the same request and returns the same test. It is no longer a state requiring recovery of a specific allocation.
- Run files move to local schema version 3, adding the label, the sending domain, and the
  service-minted identity, with an in-memory upgrade from version 2.
- The skill gains two outcomes that only exist in the real service: a correct send that is
  refused as rate limited for the domain, and a sender domain refused as free-mail. Both arrive
  after the user has sent, so neither can be prevented by checking first.

## What this supersedes

Decision 0003 required an anonymous context to be bootstrapped before the first allocation
request, so that a lost response could be replayed by a principal that provably existed. The
deployed service has no anonymous principal: guest tests carry no identity, and the daily limit
is keyed on the sending domain observed in the delivered message. With nothing reserved at
creation and no principal to prove, the ordering that 0003 protects has no subject. It is
superseded rather than amended, and no part of it is implemented.

The division of responsibility in `CLAUDE.md` stands. The earlier assumption that
allocation is an atomic allowance reservation is not true of this service and is corrected here.
