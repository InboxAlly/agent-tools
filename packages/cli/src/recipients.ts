import { parse } from "csv-parse/sync";
import { CliError } from "./errors.js";
import { readBoundedUtf8 } from "./input.js";
import { mailbox, mailboxKey, requireSendWindow, type Manifest } from "./manifest.js";

export function readRecipientFile(path: string): Promise<string> {
  return readBoundedUtf8(path, 1024 * 1024, detail => new CliError("INVALID_RECIPIENT_FILE", `Recipient input ${detail}.`, 5));
}


export function parseRecipients(input: string): string[] {
  try {
    const rows = parse(input, { bom: true, skip_empty_lines: true }) as string[][];
    let addresses: string[];
    const header = rows[0] ?? [];
    if (header.includes("email")) {
      if (header.filter(v => v === "email").length !== 1) throw new Error();
      const index = header.indexOf("email");
      addresses = rows.slice(1).map(row => row[index]!);
    } else {
      if (rows.some(row => row.length !== 1)) throw new Error();
      addresses = rows.map(row => row[0]!);
    }
    if (addresses.some(a => !mailbox.safeParse(a).success)) throw new Error();
    return addresses;
  } catch { throw new CliError("INVALID_RECIPIENT_FILE", "Recipient input contains malformed records or lacks an email column.", 5); }
}

export function verifyRecipients(manifest: Manifest, actual: string[]) {
  const expected = new Map(manifest.recipients.map(r => [mailboxKey(r.email), r.email]));
  const seen = new Set<string>();
  const duplicates: string[] = [];
  const unexpected: string[] = [];
  for (const address of actual) {
    const key = mailboxKey(address);
    if (seen.has(key)) duplicates.push(address);
    if (!expected.has(key)) unexpected.push(address);
    seen.add(key);
  }
  const missing = [...expected].filter(([key]) => !seen.has(key)).map(([, email]) => email);
  return { matches: missing.length === 0 && unexpected.length === 0 && duplicates.length === 0 && actual.length === 16,
    expected_count: 16, actual_count: actual.length, missing, unexpected, duplicates };
}

export function exportRecipients(manifest: Manifest, format: string): string {
  requireSendWindow(manifest);
  const addresses = manifest.recipients.map(r => r.email);
  if (format === "json") return JSON.stringify(addresses) + "\n";
  if (format === "text") return addresses.join("\n") + "\n";
  if (format === "csv") return "email\r\n" + addresses.map(a => `"${a.replaceAll('"', '""')}"`).join("\r\n") + "\r\n";
  throw new CliError("INVALID_ARGUMENTS", "Export format must be text, csv, or json.");
}
