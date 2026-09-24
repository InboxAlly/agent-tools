import { z } from "zod";
import { mailbox, platforms, safeString, text } from "./manifest.js";

// Local workflow states after allocation (specification section 14). The CLI owns the
// allocation states prepared/allocation_unknown/allocated; a note cannot claim them.
export const workflowStates = [
  "awaiting_import_approval", "import_outcome_unknown", "import_verified",
  "awaiting_send_approval", "send_outcome_unknown", "send_confirmed",
  "watching", "done", "stopped",
] as const;
export type WorkflowState = (typeof workflowStates)[number];

// Approvals are observations of a human response. They are journal events, not states.
export const journalEvents = [...workflowStates, "import_approved", "send_approved"] as const;
export type JournalEvent = (typeof journalEvents)[number];
export const evidenceTypes = ["tool_observed", "user_reported"] as const;

// The only keys a details file may contain. Anything else, including credentials or
// campaign bodies, is rejected rather than stored.
export const detailsSchema = z.object({
  platform: z.enum(platforms).optional(),
  workspace_label: text.optional(),
  from: mailbox.optional(),
  subject: text.optional(),
  list_name: text.optional(),
  recipient_count: z.number().int().min(0).max(100000).optional(),
  esp_object_id: text.optional(),
  observed_at: z.iso.datetime().optional(),
  note: safeString(1000).optional(),
}).strict();
export type NoteDetails = z.infer<typeof detailsSchema>;
export const DETAILS_FILE_LIMIT = 16 * 1024;

export const journalEntrySchema = z.object({
  sequence: z.number().int().positive(),
  recorded_at: z.iso.datetime(),
  event: z.enum(journalEvents),
  evidence: z.enum(evidenceTypes),
  details: detailsSchema,
  state: z.enum(workflowStates),
}).strict();
export type JournalEntry = z.infer<typeof journalEntrySchema>;
export const JOURNAL_LIMIT = 200;

// Once an approval is recorded, the platform action may happen at any moment. Until the
// agent verifies the outcome, the only safe recovery is to inspect before acting, so an
// approval moves the run into the matching outcome-unknown state.
export function stateAfter(event: JournalEvent): WorkflowState {
  if (event === "import_approved") return "import_outcome_unknown";
  if (event === "send_approved") return "send_outcome_unknown";
  return event;
}

// Events that only make sense while a send is still possible.
export const sendOrientedEvents: ReadonlySet<JournalEvent> = new Set<JournalEvent>([
  "awaiting_import_approval", "import_approved", "awaiting_send_approval", "send_approved",
]);

// What an approval must record, so recovery can compare it with the current state.
export const requiredApprovalDetails: Readonly<Partial<Record<JournalEvent, readonly (keyof NoteDetails)[]>>> = {
  import_approved: ["list_name", "recipient_count"],
  send_approved: ["from", "subject", "list_name", "recipient_count"],
};
