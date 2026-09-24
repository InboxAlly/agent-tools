# 0005: Agent behavior is graded from traces, and the grader is not evidence about agents

Status: accepted client decision, 2026-09-22.

## Decision

Skill behavior is evaluated from a **trace** of one run: the commands invoked, the operations
performed on the sending platform, the reads made, the approvals received, and the claims
asserted to the user. Assertions are written against those observable events. No assertion may
depend on a sentence or heading in the skill, per specification 15.1.

Evaluation has two layers, and they are different kinds of evidence:

1. **The grader runs in CI against fixture traces.** Each fixture carries exactly one
   deliberate defect, and the grader must catch that one and stay silent on the rest. This is
   evidence that the grader works.
2. **Real agent runs produce evidence about agents, outside CI.** A model runs the skill
   against a mock sending platform and a fixture placement service; the trace is captured and
   graded; the result is recorded with model, harness and date.

A validation record may never cite layer 1 as evidence for layer 2.

## Why not run a model in CI

It would need credentials in CI, which this repository forbids, and it is nondeterministic and
costs money per run. Either way the grader is the prerequisite, so it is built first. A
model-in-the-loop job can be added later as an explicitly triggered workflow.

## Three outcomes

A criterion reports `pass`, `violated`, or `not_exercised`. The third exists because a run that
never sends cannot demonstrate that it would refuse to send twice. Reporting that as a pass
would manufacture confidence, which is the failure this repository is built to avoid in its
measurements and must avoid in its own tests.

## Mode awareness

The CLI is optional. A run in `cli` mode must also have recorded its approvals in the workflow
journal; a run in `api` mode is judged on the user's approval alone, because it has no journal.
Rules encode that difference rather than penalising a skill-only run for a record it cannot
keep.

## What this does not cover

Twelve criteria, chosen because the skill owns them: nine from the specification's acceptance
matrix (C06, C08, C09, C10, C14, C17, C18, C19, C30) and three the repository added, R01 to R03.
Rules not in the specification are numbered R01 onwards, so they never reuse a specification
ID; C20 and C21 there mean other things. C18 was added on 2026-09-22, once the synthetic service could report a send that missed part
of the audience. R01 was added on 2026-09-23, when native-mail mode let the user skip the
audience check; it is not from the specification. It is graded from fixtures only: the recorded
scenarios model a marketing platform, not native mail. R02 was added the same day, after three
of four Opus 5.5 runs journaled a list check before reading its result; it is not from the
specification either, and leaves acting on the evidence to C08 and C09. The remaining criteria in the specification's acceptance matrix concern installation, credentials,
quota, and the API contract, and are not gradeable from a skill trace. Certified ESP workflows
remain separate work.
