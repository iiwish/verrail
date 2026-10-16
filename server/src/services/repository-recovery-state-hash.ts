import { createHash } from "node:crypto";

/** Cross-language fingerprints for complete DB rows, including arbitrary JSON payloads. */
export function repositoryRecoveryStateSha256(value: unknown): string {
  const seen = new WeakSet<object>();
  const validateDates = (entry: unknown): void => {
    if (!entry || typeof entry !== "object" || seen.has(entry)) return;
    seen.add(entry);
    if (entry instanceof Date) {
      if (!Number.isFinite(entry.getTime())) throw new Error("REPOSITORY_RECOVERY_STATE_INVALID");
      return;
    }
    for (const item of Object.values(entry)) validateDates(item);
  };
  // Date.toJSON runs before a JSON replacer and otherwise turns invalid dates into null.
  validateDates(value);
  const hash = createHash("sha256").update("verrail.repository-recovery-db-state.v1\0");
  let size = 0;
  const write = (bytes: Buffer) => {
    size += bytes.length;
    if (size > 16 * 1024 * 1024) throw new Error("REPOSITORY_RECOVERY_STATE_TOO_LARGE");
    hash.update(bytes);
  };
  const tag = (value: string) => write(Buffer.from(value, "ascii"));
  const count = (value: number) => { const bytes = Buffer.alloc(4); bytes.writeUInt32BE(value); write(bytes); };
  const encode = (entry: unknown): void => {
    if (entry === null) { tag("n"); return; }
    if (typeof entry === "boolean") { tag(entry ? "t" : "f"); return; }
    if (typeof entry === "number") {
      if (!Number.isFinite(entry)) throw new Error("REPOSITORY_RECOVERY_STATE_INVALID");
      tag("d"); const bytes = Buffer.alloc(8); bytes.writeDoubleBE(entry === 0 ? 0 : entry); write(bytes); return;
    }
    if (typeof entry === "string") {
      tag("s"); const bytes = Buffer.from(entry, "utf8"); count(bytes.length); write(bytes); return;
    }
    if (Array.isArray(entry)) { tag("a"); count(entry.length); for (const item of entry) encode(item); return; }
    if (typeof entry === "object") {
      const object = entry as Record<string, unknown>, keys = Object.keys(object).sort();
      tag("o"); count(keys.length);
      for (const key of keys) { encode(key); encode(object[key]); }
      return;
    }
    throw new Error("REPOSITORY_RECOVERY_STATE_INVALID");
  };
  // Match the reader's existing JSON/Date projection before encoding values.
  encode(JSON.parse(JSON.stringify(value, (_key, entry: unknown) => {
    if (typeof entry === "number" && !Number.isFinite(entry)) throw new Error("REPOSITORY_RECOVERY_STATE_INVALID");
    return entry;
  })));
  return hash.digest("hex");
}
