# Interpret the measurement

Status/watch implement this provisional contract. From the CLI they read the real service; the
eval harness and the demo read synthetic fixtures. Do not present fixture results as
live.

All 16 addresses receive the campaign. Only recipients marked `placement` contribute to
placement percentages. The illustrative 15+1 fixture is not confirmation of real roles.
Use server provider groups and explicit denominators; do not infer provider from the domain.

Distinguish awaiting, receiving, complete, incomplete, expired, and failed, and the two refusals
on arrival, rate_limited and free_mail, which measured nothing. Completion means
required observations/classifications exist. Validity is separate: a complete test with
wrong sender or ambiguous correlation is invalid for the intended campaign.

While partial, report counts such as “8 of 15 placement inboxes have reported: 6 inbox,
2 spam, 7 pending.” Do not describe 6/8 as overall placement. Keep other-folder, unclassified,
and missing observations visible. Repeated messages must not inflate recipient counts.

Each placement recipient's `placement` says what the service found: `inbox`, `spam`, `missing`
(checked, and the message was not there), `unreachable` (the service could not check that
mailbox), or `pending` (not checked yet). Name missing and unreachable seeds as such. A final
result from the live service has no pending seeds; one from the synthetic contract may, and
those are not measured, not still to come.

The send cutoff blocks new sending, but already-sent mail may remain in transit. The server's
results deadline governs finalization. A local watch timeout neither expires nor cancels the
server test. Watch defaults to five minutes and is capped at fifteen minutes;
do not chain indefinite watch loops.

The service computes the verdict and statistics it considers authoritative. For a finished
measurement the CLI returns them as `service_summary`: the verdict `label`, `inbox_rate` and
`delivery_rate` (whole percentages of `scored_total`, which leaves out unreachable seeds), the
counts, and a figure per provider. The CLI has checked they agree with the rows. Quote them as
the service's figures, next to the CLI's validity; do not compute percentages yourself, and do not
total anything by hand. `service_summary` is null before the measurement is final and for a
refusal, expiry or failure: then report counts, not a rate. On a `complete` or `incomplete`
result it is final: null there means no usable figures (none given, or none that agreed with the
rows), so do not promise them later. The service counts a seed not yet
checked as missing, so for an `incomplete` result say which seeds were missing or unreachable
rather than letting a low rate read as a spam-folder failure.

Report the outcome in a few lines: the result (the service's figures, or counts), validity, and
the report link. Add a caveat only when it changes how the numbers should be read, such as
synthetic data, an unverified audience, missing or unreachable seeds, or a later run. Do not list
what is as expected, and do not repeat a caveat already given.

A measurement that belongs to a later run than the one the user approved is reported as a
different send, with the approved run named. It is never presented as the approved campaign's
result, and the earlier run's evidence is preserved.

Show the report link from the CLI's `report_url` when it has one, and say it is private to the
user: it grants access to the report. If `report_url` is null, say there is no link and never
construct one. Show sender information, validity, provider counts, and the exact list
name. Distinguish ESP send evidence from first detection time. Avoid causal claims about
spam placement without evidence and guarantees about production-wide placement from the
small sample. State that the list remains, or that approved native-mail mode created none.
