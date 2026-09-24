import { open } from "node:fs/promises";
import { CliError } from "./errors.js";

// Read a regular UTF-8 file with a hard byte limit. Every failure becomes the caller's safe error.
export async function readBoundedUtf8(path: string, limit: number, error: (detail: string) => CliError): Promise<string> {
  let file;
  try { file = await open(path, "r"); } catch { throw error("cannot be opened"); }
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > limit) throw error(`must be a regular file no larger than ${limit} bytes`);
    const bytes = Buffer.alloc(limit + 1);
    let size = 0;
    while (size < bytes.length) {
      const { bytesRead } = await file.read(bytes, size, bytes.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > limit) throw error(`exceeds ${limit} bytes`);
    try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size)); }
    catch { throw error("must contain valid UTF-8 text"); }
  } catch (e) {
    if (e instanceof CliError) throw e;
    throw error("cannot be read");
  } finally { await file.close(); }
}
