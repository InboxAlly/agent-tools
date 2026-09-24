# placement.v1 — provisional client projection

No production wire schema has been approved. The initial runtime projection is implemented
in `packages/cli/src/manifest.ts`, with result fields and semantic validation in
`packages/cli/src/results.ts`. `fixtures/placement.v1/manifest.wire.json` preserves the
synthetic example supplied in the specification, including a conspicuously fake read token.

The test adapter strips that fake token before projection. A live adapter will need a secure
capability store before it can do the same. Public projections reject credential fields in
`access` and expose only its mode. Unknown optional fields are discarded by the schema.

The fixture assumes 15 placement recipients and one correlation recipient. This is not
evidence of the real engine's roles. Provider labels are fixture metadata. Domain comparison
is case-insensitive; local parts are preserved. Final mailbox normalization needs approval.

The result projection requires complete recipient rows and provider counts backed by those
rows. UI aggregate-only progress is insufficient to manufacture those fields. Snapshot and
terminal correction policies are provisional and must be agreed with the service owner.

Before live implementation, publish approved OpenAPI/JSON schemas and wire fixtures here;
define request/replay/auth, immutable manifests, result semantics, errors, and safe output
projections. These client schemas must not be represented as API-team approval.
