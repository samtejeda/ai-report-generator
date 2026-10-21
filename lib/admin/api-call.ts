/**
 * The one way the admin screens call our own routes from the browser. It returns the HTTP status
 * and the error `code` (our fixed vocabulary from lib/api/respond.ts) and nothing else: never the
 * server's message text, never anything from the request. `failure: null` means the request did
 * not reach the server at all. Nothing here is a gate; the route re-checks everything.
 */

export type ApiFailure = { status: number; code: string | null };
export type ApiResult = { ok: true; status: number } | { ok: false; failure: ApiFailure | null };

export async function readErrorCode(res: Response): Promise<string | null> {
  try {
    const json: unknown = await res.json();
    const code = (json as { error?: { code?: unknown } } | null)?.error?.code;
    return typeof code === "string" ? code : null;
  } catch {
    return null;
  }
}

export async function callAdminApi(url: string, method: "POST" | "PATCH" | "PUT" | "DELETE", body?: unknown): Promise<ApiResult> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    });
  } catch {
    return { ok: false, failure: null };
  }
  if (res.ok) return { ok: true, status: res.status };
  return { ok: false, failure: { status: res.status, code: await readErrorCode(res) } };
}
