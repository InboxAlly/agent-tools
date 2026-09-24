## What this changes

<!-- The observable behavior that changes, and why it exists. Link the decision record or
     issue. Say explicitly if this is documentation only. -->

## Evidence

<!-- What you actually ran, and on which runtime and platform. Delete what does not apply;
     do not tick a box you did not run. CI supplies the Node 22/24 x ubuntu/macos/windows
     matrix, so list local runs separately. -->

- [ ] `npm run check`
- [ ] `npm test` (note new tests and the failure paths they exercise)
- [ ] `npm run demo`
- [ ] `npm run package:check` (required for dependency, packaging, or executable changes)
- [ ] Skill change reviewed against realistic execution and interruption traces

## Not verified

<!-- Be specific. Agent behavior, platform mutations, and anything live are separate kinds of
     evidence that this repository cannot certify today. -->

## Checklist

- [ ] Invariants in CLAUDE.md are preserved, or the decision record and behavioral evidence are
      updated together
- [ ] Persisted-state changes state their compatibility or migration strategy
- [ ] No credentials, customer data, real recipient addresses, bearer report URLs, or
      machine-specific paths in the diff, tests, or this description
