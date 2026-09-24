# Placement service contract, as derived by the client

**Not an approved contract.** The placement service has no published contract yet. This
describes the service as the client team understood it on 2026-09-22, cross-checked against the
service's public `/openapi.json`. It has not been reviewed by the service team and can change
without notice. When the service publishes a contract, that one governs. See
[decision 0006](architecture/0006-contract-derived-from-deployed-code.md).

The client relies only on what is described here, and validates every response against it, so
that a change on the service side surfaces as an error rather than as a wrong result. Only what
the CLI's free, anonymous flow needs is described.

## Create a test: `POST /api/generate-test`

No authentication. The request body is JSON.

| Field | The CLI sends |
| --- | --- |
| `uuid` | Always: a UUID the CLI minted and saved before the request. If a test with this UUID already exists, the service returns it unchanged; otherwise the new test takes this UUID. |
| Any other field | Nothing. The CLI sends only `uuid`. |

The response is JSON:

| Field | Meaning |
| --- | --- |
| `testCode` | The test code. |
| `emailAddress` | The test's own address. It must receive the campaign. |
| `uuid` | The test's UUID, which must equal the one sent. |
| `seedAddresses` | The seed mailboxes the campaign must also reach: fifteen. |
| `status` | `pending` for a new test. A replayed UUID returns the existing test as it now is, so any status below is valid there. |
| `expiresAt`, `sentinelWaitMinutes` | When the test stops waiting for the campaign (4 hours after creation for an anonymous test), or `null` once it has arrived. Added by the service's split clocks; a service without them omits both. |
| `maxMeasurementMinutes` | The cap on the measurement, which arrivals can extend from the window after arrival (`measurementEndsAt`, `arrivalGraceSeconds`). |

The sixteen-address audience is the fifteen seeds plus `emailAddress`.

## Read results: `GET /api/results/{test_code}`

No authentication. 404 for an unknown code. The read resolves to the most recent run of the
test code: a second campaign to the test address starts a new run, and the payload then names
that run. Fields the CLI uses:

| Field | Meaning |
| --- | --- |
| `testCode`, `uuid` | The run the read resolved to. Compared with the saved identity. |
| `status` | See below. |
| `totalSeeds`, `foundCount`, `missingCount` | Counts over the seeds. |
| `fromEmail`, `fromDomain`, `subject` | Learned from the campaign when it arrives; `null` before. `fromEmail` is the From header as sent: a bare address, or a display name followed by the address in angle brackets. |
| `createdAt`, `emailReceivedAt`, `serverNow` | Timestamps (ISO 8601). Whether a later run keeps the test's `createdAt` or has its own is not established, so the client relies on it only for the run it created. |
| `testWindowMinutes` | The measurement window after the campaign arrives. |
| `results[]` | One row per seed: `provider`, `seedEmail`, `placement` (`inbox`, `spam`, `junk`, `missing`, `error`, or `null` while pending), `folder`, `detectedAt`, and `auth` (`spf`, `dkim`, `dmarc`). |
| `stats` | The service's own counts: `counts` (`inbox`, `spam`, `missing`, `error`), `scoredTotal`, `totalTesters`, `unreachable`, `byProvider[]` (`provider`, `inbox`, `spam`, `missing`, `total`, `inboxRate`). The `spam` count includes rows whose placement is `junk`, and `missing` includes rows still `null`. `scoredTotal` and each provider's `total` leave out `error` rows, which the service could not check. |
| `verdict` | The service's own `label`, `level`, `subtitle`, `inboxRate` and `deliveryRate`. Rates are whole percentages of `stats.scoredTotal`; `deliveryRate` counts inbox plus spam. |
| `rateLimit` | Set only when `status` is `rate_limited`: `domain`, `retryAfter`, `retryAfterHours`, and a hint. |
| `freeMail` | Set only when `status` is `free_mail`: the refused domain. |
| `seedAddresses` | The seeds bound to the test. |

### Status

| Service status | When | Terminal |
| --- | --- | --- |
| `pending` | Created; no campaign has arrived. | No |
| `processing` | The campaign arrived; seeds are being checked. | No |
| `completed` | The measurement window after arrival has passed. Seeds not found are `missing`, so completion does not mean every seed was seen. | Yes |
| `expired` | No campaign arrived in time. | Yes |
| `failed` | Checking failed. | Yes |
| `rate_limited` | The campaign arrived, but the sending domain had already run its free test within the limit period. | Yes |
| `free_mail` | The campaign came from a free-mail or disposable domain, which cannot be tested. | Yes |

## What the client does

- **Identity.** The CLI sends the run's local request id, saved before creating, as the UUID. It
  bounds the create request with a 20-second timeout, and after a lost response waits longer
  than that before replaying the same UUID, which returns the same test instead of creating
  another. The client
  alone cannot rule out a first request the service is still processing after that wait, so a
  replay can still overlap it; the wait makes that unlikely, not impossible. The wait also uses
  part of the send deadline, which matters only under the 10-minute legacy rule.
- **Two timers.** The campaign must arrive before the service stops waiting; that is the send
  deadline. The measurement (`testWindowMinutes`, extendable by arrivals up to
  `maxMeasurementMinutes`) is a separate timer that starts when the campaign arrives. The CLI takes
  the send deadline from the create response's `expiresAt`, or `sentinelWaitMinutes` after
  `createdAt`; from a service that states neither, 10 minutes after `createdAt`, which was the
  service's original wait. Service times are shifted onto the local clock by the difference
  `serverNow` shows against the local time taken before the read, so time in transit makes the
  deadline early, never late. Results are awaited until the send deadline plus the measurement cap
  and a margin. A replay reads the same times, so the deadline never drifts later. A run adopted
  from a results read takes the deadlines from that read if it states them, and otherwise the
  10-minute rule, the safe side.
- **At the send deadline.** Once its own send deadline passes, the CLI blocks a send and never
  replaces the test automatically. It does not declare the test expired on its own clock: its
  deadline comes at or before the service's, and a campaign already sent can still arrive and be
  measured. It keeps reading, within its usual bounds, until the service reports a terminal
  status, and reports whatever the service says. The skill's approvals have to fit before
  `send_before`, so it creates the test only when the user can send at once.
- **A later run.** A second campaign to the test address starts a new run, and every later read
  resolves to it, with a different `uuid`. The CLI records the later run, keeps the last
  snapshot of the run it saved, and reports the new numbers as a different send, never as the
  approved campaign's result. The saved run cannot be read again after that, and the skill says
  so.
- **Capabilities.** The test code and the UUID each give access to the test: results are
  readable by test code, and include the UUID. Both are shown only to the user who owns the test
  and kept out of anything shared.
- **A test nobody can name.** A test whose create response was lost and never replayed has an
  address no one knows, so nothing is sent to it: it measures nothing and costs nothing, whatever
  status it keeps.
- **The service's figures.** For a finished measurement the CLI carries `verdict` and `stats` as
  its `service_summary`, after checking every count and rate against the seed rows. Figures that
  disagree, or a shape it does not recognise, leave the summary null without losing the
  measurement, and the subtitle is not kept. Once saved for a finished run, the figures are kept. A seed not found in a measurement the service has
  completed, whether marked `missing` or left `null`, is reported as missing; before completion,
  or in a test that ended another way, it is pending. An `error` row is unreachable.
- **Fields the service does not return.** The list name, the send deadline and the report link
  are the CLI's own, and are labelled as such. The report link is the InboxAlly app's guest report
  page, `https://app.inboxally.com/placement-report/{testCode}/{uuid}`, which needs no login and
  follows the test live. It carries the test code, so it is a capability like the code itself. The allowance appears only as `rateLimit` after a
  refusal.
- **Sender.** The service learns the sender only when the campaign arrives. The CLI checks it
  against the approved From address.
- **The rate-limit hint.** The CLI never relays it. The skill forbids altering the subject to get
  another test.
- **Validation.** Validation runs use a sending domain the tester controls, not an InboxAlly
  domain.
