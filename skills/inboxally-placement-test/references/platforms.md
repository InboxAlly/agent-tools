# Platform checks — draft, no workflows certified

These are requirements for verification, not verified provider UI instructions. No platform
reference currently establishes subscription support, exact screens, or automated-send
compatibility. Before certification, create focused provider references with current official
sources, a last-verified date, restrictions, recovery steps, and recorded test evidence.

## Marketing platforms

For Mailchimp, Klaviyo, HubSpot, SendGrid Marketing Campaigns, Brevo, ActiveCampaign, or
MailerLite, establish whether an isolated static audience/list can represent the exact
supplied name without affecting production contacts or triggering unrelated automations.
Check actual subscription/sendability status, contact billing, and full recipient enumeration.
Account restrictions can require guided mode or a stop; neither justifies reusing a production
audience. In SendGrid, retain the user's real sending route rather than substituting a
transactional API call for a marketing campaign.

## Outreach platforms

For Instantly, Smartlead, Lemlist, Apollo, or similar tools, verify a single approved step,
one pinned sender, one message variant, no mailbox rotation, and feasible timing. Do not
alter an existing production sequence or disable global throttles. No follow-ups to testers.

## Native Google Workspace / Microsoft 365 mail

Use only when native mail is the user's actual production sending method, and keep their normal
pattern: one message with the testers in BCC, or mail merge if that is how they send. If they
send to a named isolated group, treat the group as a list and follow the list steps in `SKILL.md`
with the exact supplied name. This flow is for sends that create no group: no list or contact is
created, and the supplied name is only the run's label. Never put testers in To or CC for convenience.
The message goes to exactly the 16 addresses, all in BCC, with To and CC empty: 16 envelope
recipients, no more. The sender is not a recipient. If you send it yourself (for example over SMTP)
and a To header is required, set it to `undisclosed-recipients:;`, which adds no recipient; never
fill it with the sender's or anyone else's address. Only if the user tells you they normally
address such mail to themselves may you add them, and then name them in the send-approval summary
as an extra recipient outside the test. Before sending, count the envelope recipients: 16.
Keep each turn short, one action each:

1. **Before creating the test**, confirm the sender and draft, and say the send deadline starts
   when the test is created, so create it only when the user can send straight away.
2. **After creating it**, give the 16 addresses in one block and ask the user to add them to the
   message without sending, then paste the recipient field back, or reply "skip". Say in one
   line why: a cut-off or mistyped address silently loses a recipient.
3. **On their reply**, compare what they pasted with `placement verify` (save it to a file
   first). On a mismatch, name the wrong address and ask them to fix it and paste again. On a
   match, record `import_verified` (`tool_observed`); if they skip, record it `user_reported`
   with a note that no comparison was made, and say the audience is not verified. Then recheck
   the From, subject, count and time left, record `awaiting_send_approval`, and ask in one line
   for explicit send approval ("Reply 'send' to approve"). Stop if the deadline cannot be met.
4. **On their approval**, record `send_approved` (`user_reported`, with the From, subject, the
   run's label as list name, and 16), and tell them to send now and say when it has gone.

Record `send_confirmed` as `user_reported` with the time they give. If they cannot say whether it
went, it is `send_outcome_unknown`: never tell them to send again. Compare only what the user
pasted, never the CLI's own export or addresses you supplied. After a skipped check, never call
the audience verified, and describe a recipient that was never seen as not sent or not delivered,
which cannot be told apart, never as a confirmed miss. The skip exists only here; a platform list
is always enumerated and compared.

## Recovery and guided operation

Inspect remote object IDs, membership, and send history after timeouts. Do not retry an
ambiguous send. Existing list names trigger the stop rule even after restarting the session.
When the user performs steps manually, record what they report without claiming tool
verification. If capabilities or isolation cannot be established, stop and explain why.
