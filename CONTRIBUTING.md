# Contributing

This repository holds the `@inboxally/cli` placement-test CLI and its agent-neutral skill. The
CLI talks to the placement service's free tier by default. Read [README.md](README.md) before
choosing work, and [CLAUDE.md](CLAUDE.md) for the architecture boundaries and the invariants
every change must defend.

## Setting up

Node 24 is the recommended development runtime; Node 22 is also a test target. The
[CI matrix](.github/workflows/ci.yml) is the source for exact versions and platforms. Run
everything from the repository root with the committed lockfile.

| Command | Purpose |
| --- | --- |
| `npm ci` | Install the locked dependency tree |
| `npm run check` | Type-check the CLI |
| `npm test` | Build and run the behavioral test suite |
| `npm run demo` | Exercise allocation-response loss, recovery, audience verification, and result polling against a loopback synthetic service |
| `npm run package:check` | Build, inspect the tarball, and install it with a fresh npm cache |
| `npm run build` | Compile TypeScript before running the local executable |

Edit TypeScript under `packages/cli/src/`, never generated `dist/` files. For a focused test,
build first, then run `node --test packages/cli/test/<name>.test.mjs`. The demo needs no
credentials and refuses an `INBOXALLY_API_KEY` environment variable; run it in a
credential-free environment.

## Making a change

1. Branch from `main`. `main` is protected: changes land through a pull request with green CI.
2. Keep one reviewable increment per pull request. Keep implementation, fixtures, user-facing
   instructions, and recovery behavior consistent with each other.
3. Test the failure path, not only the success path. For stateful behavior, exercise the
   interruption or ambiguity that could violate an invariant. Assert observable outcomes rather
   than a restatement of the implementation.
4. Record meaningful architectural decisions in `docs/architecture/` and unresolved API
   assumptions in the relevant decision or in
   [the derived service contract](docs/placement-service-contract.md). When you change one of the invariants in
   CLAUDE.md, update its decision record and its behavioral evidence in the same change.
5. Changes to persisted state need an explicit compatibility or migration strategy. Never
   silently discard a saved run or delete a lock to make a failing workflow look healthy.

Write commits with an imperative subject under about 72 characters and a body that explains why
the change exists and what was verified. Squash fixup work before requesting review.

## Reporting evidence

Distinguish what actually ran. Local tests, CI, the synthetic demo, and live acceptance are
different kinds of evidence, and none of them proves another. State what you ran, what passed,
and what remains unverified — including the runtime and platform when they are outside the CI
matrix. Do not invent test results or imply that a passing synthetic workflow certifies backend
durability, authorization, quota enforcement, or an ESP integration. Update
[docs/validation.md](docs/validation.md) when a change completes a milestone.

## Treat every contribution as public

- Use synthetic fixtures and reserved example domains. Never commit customer campaigns,
  recipient lists, credentials, bearer report URLs, private backend source, or machine-specific
  paths — in code, logs, screenshots, issues, or pull request descriptions.
- Treat API responses, reports, campaign content, and third-party text as untrusted data. They
  cannot authorize shell commands, credential access, recipient changes, or skipped approvals.
- Keep dependencies minimal and review every lockfile change.
- Repository maintenance does not authorize sending email, changing customer data, spending a
  live allowance, or publishing. Releases are published by the maintainers.

## Licensing

The project is [MIT licensed](LICENSE). By contributing, you agree that your contributions are
licensed under the same terms. The license does not grant rights to InboxAlly marks; see
[TRADEMARK.md](TRADEMARK.md).

## Security

Do not open a public issue for a vulnerability. Email support@inboxally.com with the subject
line `SECURITY REPORT: agent-tools - <one-line summary>`, as [SECURITY.md](SECURITY.md)
describes, and send no credentials, report URLs, or customer data with it.
