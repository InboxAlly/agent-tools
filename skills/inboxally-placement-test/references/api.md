# Running without the CLI

**In this version** direct API use is unsupported (see Availability below): use the CLI, as
`SKILL.md` describes. The rest of this reference describes a later version in which the CLI is
optional.

Then a user may install only this skill, in which case the agent talks
to the placement API directly. **Prefer the CLI whenever it is available.** It validates every
response, keeps durable state, compares audience membership exactly, bounds polling, builds
and checks the report link, and signals partial, invalid and unknown states through exit
codes. An agent following instructions does those things sometimes; the CLI does them every
time and fails loudly rather than plausibly.

## Choose the mode once, and say which one you are in

Check for the CLI at the start of a run (`inboxally --version`). If it is present, use it. If it
is absent, offer to install it before continuing once a released install command exists; in this
version there is none, so follow the "Who can run a test" rule in `SKILL.md` instead. Never degrade silently: the guarantees differ,
so the user should know which set they are getting.

**Never mix modes within one run.** A run created through the CLI keeps its state in the CLI's
store; calling the API directly for that same run leaves the local record describing a reality
that no longer holds. Pick a mode per run.

If the user installs the CLI partway through an API-only run, do not start a second test. Adopt
the existing one with `placement import --test-code <code> --uuid <run-uuid>` and continue in
CLI mode.

## Availability

Direct API use without the CLI is **not supported in this version** (the CLI itself reaches the
service), and the service's contract is not yet published. Concrete routes, request bodies and response fields are deliberately not
listed here: they are pending the placement team's contract documentation. Do not guess a route,
do not copy one out of a browser session, and do not present a draft contract as an approved
API. Until that documentation exists, direct API use is unsupported and the honest answer to a
user asking for it is that the integration is not ready.

The rules below apply when it becomes available, and they are what the CLI already enforces.

## What you must do yourself in API-only mode

**Persist identity before you show anything.** Write the run's UUID and test code to a file, with the sending domain, an optional label, the test's own address, and a
timestamp, the moment the response parses — before telling the user anything. A user must never
hold an address list you cannot name. Use the same field names the CLI uses, so the run can be
imported later:

```json
{
  "label": "acme-newsletter",
  "domain": "acme.example",
  "remote": { "uuid": "…", "test_code": "…", "email_address": "…", "allocated_at": "…" },
  "state": "allocated"
}
```

**Never invent identity.** Do not generate a UUID and send it: the CLI does, but only under a
recorded decision with its own persistence and replay rules. Never derive a test code, and do
not reconstruct either from a report link. Keep what you were given and reuse it unchanged.

**Keep one live address list per sending domain.** If a domain already has an unfinished test,
resume it. Two live lists mean a campaign can reach a test nobody is watching.

**Treat the UUID and test code as capabilities.** Whoever holds either can read the report and
create a public share link. Handle them like a report URL: never paste them into a public issue,
a screenshot, or a message to anyone but the user who owns the test.

**Quote the server's numbers; never compute your own.** The service returns the verdict and
statistics it considers authoritative. Report those. Do not calculate placement percentages from
per-recipient rows, and do not total anything by hand — partial data is exactly where invented
numbers come from.

**Compare identity on every read.** A read can resolve to a later run if a second message
reached the test address. If the identity you get back differs from the one you saved, report
the numbers as a later send, not as the measurement of the campaign the user approved.

**Claim less than the CLI would.** Without its exact-audience comparison you have not verified
membership; you have observed it. Say so. Without its store, recovery depends on the user
keeping the test code — surface it early and tell them to keep it. State plainly that if this
conversation is lost, that code is what resumes the test.

Every approval boundary, audience rule and interpretation limit in [SKILL.md](../SKILL.md) and
[results.md](results.md) applies unchanged. Fewer tools means weaker claims, never weaker rules.
