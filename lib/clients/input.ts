import { z } from "zod";

/**
 * What a request may say about a client (decision D6, 2026-10-13): display name, date of birth,
 * grade level and an optional external id. Nothing else is accepted, so a request cannot carry an
 * address, a guardian, a school or a diagnosis, and cannot name `organizationId`, `id` or
 * `deletedAt` (a strict object refuses unknown keys).
 *
 * Errors are reported as "invalid" only; the route answers its fixed 400 and never echoes a value.
 */

export const DISPLAY_NAME_MAX = 200;
export const GRADE_LEVEL_MAX = 20;
export const EXTERNAL_ID_MAX = 64;
export const EARLIEST_DATE_OF_BIRTH = "1900-01-01";

const CONTROL = /\p{Cc}/u;
const text = (max: number) =>
  z
    .string()
    .transform((v) => v.normalize("NFC").trim())
    .pipe(z.string().min(1).max(max).refine((v) => !CONTROL.test(v)));

const GRADE = /^[A-Za-z0-9][A-Za-z0-9 -]*$/;
const grade = text(GRADE_LEVEL_MAX).refine((v) => GRADE.test(v));

/** `YYYY-MM-DD`, a real calendar date, between 1900-01-01 and today (UTC). */
export function isPlausibleDateOfBirth(value: string, now: Date): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (d.getUTCFullYear() !== Number(m[1]) || d.getUTCMonth() !== Number(m[2]) - 1 || d.getUTCDate() !== Number(m[3])) return false;
  return value >= EARLIEST_DATE_OF_BIRTH && value <= now.toISOString().slice(0, 10);
}

const dob = (now: Date) => z.string().refine((v) => isPlausibleDateOfBirth(v, now));

export type ClientCreateInput = {
  displayName: string;
  dateOfBirth: string | null;
  gradeLevel: string | null;
  externalId: string | null;
};
export type ClientPatchInput = Partial<ClientCreateInput>;

/** Column name (snake_case) for each patch key, for the audit `fields` list. */
const AUDIT_FIELD: Record<keyof ClientCreateInput, string> = {
  displayName: "display_name",
  dateOfBirth: "date_of_birth",
  gradeLevel: "grade_level",
  externalId: "external_id",
};

export function auditFieldList(keys: (keyof ClientCreateInput)[]): string {
  return keys.map((k) => AUDIT_FIELD[k]).join(",");
}

function createSchema(now: Date) {
  return z.strictObject({
    displayName: text(DISPLAY_NAME_MAX),
    dateOfBirth: dob(now).nullish(),
    gradeLevel: grade.nullish(),
    externalId: text(EXTERNAL_ID_MAX).nullish(),
  });
}

function patchSchema(now: Date) {
  return z
    .strictObject({
      displayName: text(DISPLAY_NAME_MAX),
      dateOfBirth: dob(now).nullable(),
      gradeLevel: grade.nullable(),
      externalId: text(EXTERNAL_ID_MAX).nullable(),
    })
    .partial()
    .refine((v) => Object.values(v).some((x) => x !== undefined));
}

export function parseClientCreate(body: unknown, now = new Date()): { ok: true; value: ClientCreateInput } | { ok: false } {
  const r = createSchema(now).safeParse(body);
  if (!r.success) return { ok: false };
  return {
    ok: true,
    value: {
      displayName: r.data.displayName,
      dateOfBirth: r.data.dateOfBirth ?? null,
      gradeLevel: r.data.gradeLevel ?? null,
      externalId: r.data.externalId ?? null,
    },
  };
}

export function parseClientPatch(body: unknown, now = new Date()): { ok: true; value: ClientPatchInput } | { ok: false } {
  const r = patchSchema(now).safeParse(body);
  if (!r.success) return { ok: false };
  const value: ClientPatchInput = {};
  for (const key of Object.keys(AUDIT_FIELD) as (keyof ClientCreateInput)[]) {
    if (r.data[key] !== undefined) (value as Record<string, unknown>)[key] = r.data[key];
  }
  return { ok: true, value };
}
