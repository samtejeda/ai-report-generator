/** The five-character Postgres error code anywhere in an error's cause chain, if there is one. */
export function pgCode(error: unknown): string | undefined {
  let cur: unknown = error;
  for (let i = 0; i < 5 && cur && typeof cur === "object"; i++) {
    const rec = cur as { code?: unknown; cause?: unknown };
    if (typeof rec.code === "string" && /^[0-9A-Z]{5}$/.test(rec.code)) return rec.code;
    cur = rec.cause;
  }
  return undefined;
}

export const UNIQUE_VIOLATION = "23505";
export const RESTRICT_VIOLATION = "23001";
