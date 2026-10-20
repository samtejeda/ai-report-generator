/**
 * Reads a JSON request body with a hard size cap, for routes that take one. Returns a result, not
 * an exception, so the route answers its fixed 400 and nothing from the body is ever echoed.
 */
export async function readJsonBody(request: Request, maxChars = 2048): Promise<{ ok: true; value: unknown } | { ok: false }> {
  const text = await request.text();
  if (text.length > maxChars) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}
