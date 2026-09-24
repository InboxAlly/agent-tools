import { z } from "zod";
import { CliError } from "./errors.js";

export const safeString = (max: number) => z.string().min(1).max(max).refine(s => s.trim().length > 0 && !/[\u0000-\u001f\u007f-\u009f]/.test(s));
export const text = safeString(512);
// The InboxAlly app's guest report page. Saved production runs carry links on this origin, so it
// is approved whether or not live transport is enabled: offline commands still validate them.
export const PRODUCTION_REPORT_ORIGIN = "https://app.inboxally.com";
export const mailbox = z.email().max(254);
export const platforms = ["mailchimp", "klaviyo", "hubspot", "sendgrid", "brevo", "activecampaign", "mailerlite", "instantly", "smartlead", "lemlist", "apollo", "google-workspace", "microsoft-365", "other"] as const;
export const createBodySchema = z.object({ expected_from: mailbox, sending_platform: z.enum(platforms) });
export type CreateBody = z.infer<typeof createBodySchema>;

// Provisional logical client schema. This is not an approved backend wire contract.
export const manifestSchema = z.object({
  contract_version: z.literal("placement.v1"),
  test_id: text,
  created_at: z.iso.datetime(),
  expected_from: mailbox,
  sending_platform: z.enum(platforms),
  list_name: text,
  recipient_count: z.literal(16),
  recipients: z.array(z.object({ id: text, email: mailbox, role: z.enum(["placement", "correlation"]), provider: text })).length(16),
  expected_observation_count: z.number().int().min(1).max(16),
  expected_placement_count: z.number().int().min(1).max(16),
  // The service provides no report link for an anonymous test; a link is shown only when one exists.
  report_url: z.url().nullable(),
  send_before: z.iso.datetime(),
  results_deadline: z.iso.datetime(),
  report_expires_at: z.iso.datetime().nullable(),
  poll_after_seconds: z.number().int().positive().max(86400),
  // The service reports no allowance at creation; the limit shows only as a refusal on arrival.
  quota: z.discriminatedUnion("mode", [
    z.object({ mode: z.literal("free"), limit: z.literal(1), remaining: z.number().int().min(0).max(1), reset_at: z.iso.datetime() }),
    z.object({ mode: z.literal("paid"), limit: z.null(), remaining: z.null(), reset_at: z.iso.datetime().nullable() }),
  ]).nullable(),
  // Capabilities must be removed and securely stored by an approved wire adapter.
  access: z.object({ mode: z.enum(["anonymous", "paid"]) }).strict(),
  // Minted by the placement service. The client persists it and never invents one.
  run_uuid: z.uuid(),
});
export type Manifest = z.infer<typeof manifestSchema>;

export function mailboxKey(address: string): string {
  const at = address.lastIndexOf("@");
  return address.slice(0, at) + "@" + address.slice(at + 1).toLowerCase();
}

// The single correlation recipient is the test's own address: it receives the campaign and
// carries the test code, which is how the service correlates a send to a run.
export function correlationAddress(m: Manifest): string {
  const found = m.recipients.find(r => r.role === "correlation");
  if (!found) throw new CliError("INVALID_MANIFEST", "The manifest has no correlation address.", 5);
  return found.email;
}

// The sending domain is what a human selects a run by, and what the service keys its daily
// limit on. Derived, never stored, so it cannot drift from the sender it came from.
export function senderDomain(mailbox: string): string {
  const at = mailbox.lastIndexOf("@");
  if (at < 0) throw new CliError("INVALID_ARGUMENTS", "A From mailbox is required.");
  return mailbox.slice(at + 1).toLowerCase();
}

export function validateManifest(raw: unknown, origins: readonly string[], expected?: CreateBody, testId?: string): Manifest {
  const parsed = manifestSchema.safeParse(raw);
  const fail = (): never => { throw new CliError("INVALID_MANIFEST", "The test manifest failed validation; preserve the request and stop.", 5); };
  if (!parsed.success) return fail();
  const m = parsed.data;
  if (m.report_url !== null) {
    const url = new URL(m.report_url);
    if (url.protocol !== "https:" || url.username || url.password || !origins.includes(url.origin) || /[\u0000-\u0020\u007f]/.test(m.report_url)) return fail();
  }
  if (new Set(m.recipients.map(r => r.id)).size !== 16 || new Set(m.recipients.map(r => mailboxKey(r.email))).size !== 16) return fail();
  if (m.recipients.filter(r => r.role === "placement").length !== m.expected_placement_count || m.expected_observation_count < m.expected_placement_count) return fail();
  if (m.recipients.filter(r => r.role === "correlation").length !== 1) return fail();
  if (!(Date.parse(m.created_at) < Date.parse(m.send_before) && Date.parse(m.send_before) < Date.parse(m.results_deadline))) return fail();
  if (m.report_expires_at !== null && Date.parse(m.report_expires_at) < Date.parse(m.results_deadline)) return fail();
  if (expected && (mailboxKey(m.expected_from) !== mailboxKey(expected.expected_from) || m.sending_platform !== expected.sending_platform)) return fail();
  if (testId !== undefined && m.test_id !== testId) return fail();
  return m;
}

// Proposed client minimum before a final send (specification 11.5); the API may require a stricter value.
export const MIN_SEND_WINDOW_SECONDS = 120;

export function requireSendWindow(m: Manifest, now = Date.now(), minRemainingSeconds = 0): void {
  const remaining = Date.parse(m.send_before) - now;
  if (remaining <= 0) throw new CliError("SEND_WINDOW_EXPIRED", "The send window has expired. Read the existing results; do not create a replacement automatically.", 8);
  if (remaining < minRemainingSeconds * 1000) throw new CliError("SEND_WINDOW_INSUFFICIENT", `Fewer than ${minRemainingSeconds} seconds remain before the send cutoff; there is not enough time to complete the send. Do not create a replacement automatically.`, 8);
}
