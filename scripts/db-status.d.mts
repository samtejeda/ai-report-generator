export const WARN_TIMEOUT_MS: number;
export const STATUS_TIMEOUT_MS: number;
export type ExpectedMigration = { tag: string; hash: string; when: number };
export type AppliedMigration = { hash: string; createdAt: number };
export type StatusResult =
  | { kind: "ok" | "missing" | "blocked"; total: number; missing: ExpectedMigration[]; blocked: ExpectedMigration[]; ahead: number }
  | { kind: "unreadable"; reason: string };
export type StatusClient = { query: (sql: string) => Promise<{ rows: Record<string, unknown>[] }>; end?: () => unknown };
export function expectedMigrations(drizzleDir: string): ExpectedMigration[];
export function checkNeonUrl(rawUrl: string | undefined): { ok: true; endpoint: string } | { ok: false; reason: string };
export function readApplied(client: StatusClient): Promise<AppliedMigration[]>;
export function analyze(
  expected: ExpectedMigration[],
  applied: AppliedMigration[],
): { kind: "ok" | "missing" | "blocked"; total: number; missing: ExpectedMigration[]; blocked: ExpectedMigration[]; ahead: number };
export function classifyError(error: unknown): string;
export function report(result: StatusResult, endpoint?: string): { exitCode: number; lines: string[] };
export function checkStatus(options: {
  url?: string;
  drizzleDir?: string;
  makeClient: (url: string) => Promise<StatusClient>;
  timeoutMs?: number;
}): Promise<{ result: StatusResult; endpoint?: string }>;
export function warningLines(result: StatusResult, endpoint?: string): string[];
export function runCli(io: {
  argv: string[];
  env: Record<string, string | undefined>;
  makeClient: (url: string) => Promise<StatusClient>;
  log?: (s: string) => void;
  err?: (s: string) => void;
  drizzleDir?: string;
  timeoutMs?: number;
}): Promise<number>;
