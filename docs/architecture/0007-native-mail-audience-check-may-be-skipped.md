# 0007: The user may skip the native-mail audience check

Status: accepted, 2026-09-23, by the maintainer. Narrows the exact-audience rule in `CLAUDE.md`
for native-mail mode only.

## Context

In native-mail mode (Gmail or Outlook, recipients in BCC) no list exists that the agent can
enumerate. The only evidence of the audience is the recipient field itself, so the skill asked the
user to copy it back. The first live run showed that step is awkward enough that a user may
reasonably decline it.

## Decision

1. The agent still asks for the recipient field, pasted in one go, and says why: an address cut
   off or mistyped in copying silently loses a recipient.
2. The user may reply "skip". The audience then rests on the user's word, and everything says so:
   `import_verified` is journaled as `user_reported`, the send-approval summary says the audience
   was not verified, and the agent never calls it verified afterwards.
3. Results for a skipped check describe a recipient that was never seen as not sent or not
   delivered, never as a confirmed miss, because the two cannot be told apart.
4. Marketing platforms are unchanged: their list is always enumerated and compared.

## Consequences

- The 16-recipient requirement is unchanged; only the evidence for it is weaker, and labelled.
- The CLI is unchanged: it already accepts a `user_reported` observation, and its own validity
  rules still apply to the measurement.
- `placement runs` reports `import_evidence`, so an agent resuming after a restart can see that
  the check was skipped.
- Criterion R01 grades it from fixtures: a skipped check journaled as tool-observed, or described
  as verified, is a violation until the user pastes the field after all and a comparison of it
  succeeds. No recorded agent run covers native
  mail yet.
