export function resetMfa(
  pool: { connect(): Promise<{ query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>; release(): void }> },
  email: string,
  options: { apply: boolean },
): Promise<{ status: "not_found" } | { status: "dry_run" | "reset"; userId: string; organizationId: string; role: string; mfaWasEnabled: boolean }>;
