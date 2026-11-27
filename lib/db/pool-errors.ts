// An idle client in a connection pool can fail while nobody is using it (Neon restarts or
// suspends the compute, the network drops, the server ends the session). The pool re-emits that
// as an "error" event on itself, and a Node EventEmitter with no "error" listener THROWS, which
// in a long-lived container takes the process down. On Vercel the function simply ended first,
// so this never mattered; on a container it can. The pool already discards the failed client,
// so the next query gets a fresh connection: the right response is to note it and carry on.
//
// What is logged is one fixed event: which pool, and a code only if it has a known harmless
// shape. Never the message, stack, `cause`, query text, parameters or connection string: any of
// those can hold a password, a host, or client data.

/** Postgres SQLSTATE: exactly five digits or capital letters (for example 57P01, 08006). */
const SQLSTATE = /^[0-9A-Z]{5}$/;
/** Network error codes Node reports for a dropped idle connection. A closed list, so nothing else gets through. */
const NETWORK_CODES: ReadonlySet<string> = new Set(["ECONNRESET", "ETIMEDOUT", "EPIPE"]);

export type PoolName = "app" | "auth";

type ErrorSource = { on(event: "error", listener: (error: unknown) => void): unknown };

export function safePoolErrorCode(error: unknown): string {
  const read = (value: unknown): unknown =>
    typeof value === "object" && value !== null ? (value as { code?: unknown }).code : undefined;
  const code = read(error) ?? read((error as { cause?: unknown } | null)?.cause);
  if (typeof code === "string" && (SQLSTATE.test(code) || NETWORK_CODES.has(code))) return code;
  return "unknown";
}

/** Call once, right after creating a pool. `name` is a fixed literal, never taken from input. */
export function attachPoolErrorHandler(pool: ErrorSource, name: PoolName): void {
  pool.on("error", (error: unknown) => {
    try {
      console.error(JSON.stringify({ event: "db_pool_error", pool: name, code: safePoolErrorCode(error) }));
    } catch {
      // Logging must never be the thing that throws out of an event handler.
    }
  });
}
