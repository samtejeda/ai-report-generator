/**
 * The wait time on a rate-limited auth form. Better Auth refuses with 429 and an `X-Retry-After`
 * header: whole seconds until this address may try again (at most the 15 minute window). The header
 * is same-origin, so the page can read it (proven in PR #67, API.md "Auth rate limits"). The client's
 * `error` object has no headers, so each call passes `captureWait().fetchOptions` as its second
 * argument and reads `seconds()` afterwards.
 *
 * Fixed sentences only: nothing the server said is shown, and the wait is the same for a real and
 * a made-up account (it is per address and path, never per account).
 */

export const TOO_MANY_ATTEMPTS = "Too many attempts. Wait a few minutes and try again.";

/** The longest wait ever quoted: the rate-limit window. A larger header cannot make a longer sentence. */
export const MAX_WAIT_MINUTES = 15;

/** Whole seconds from the header, or null when it is missing or not a run of digits. */
export function waitSecondsFromHeader(value: string | null | undefined): number | null {
  if (value == null) return null;
  const trimmed = value.trim();
  if (!/^\d{1,9}$/.test(trimmed)) return null;
  return Number(trimmed);
}

/** "Too many attempts. Try again in about N minutes." with N rounded up, at least 1, at most 15. */
export function tooManyAttemptsMessage(seconds: number | null, fallback: string = TOO_MANY_ATTEMPTS): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return fallback;
  const minutes = Math.min(MAX_WAIT_MINUTES, Math.max(1, Math.ceil(seconds / 60)));
  return `Too many attempts. Try again in about ${minutes} ${minutes === 1 ? "minute" : "minutes"}.`;
}

type HeaderSource = { response: { headers: { get(name: string): string | null } } };

/**
 * One per call. `fetchOptions` goes in the client call's second argument; `seconds()` is the wait
 * once the call has failed with a 429 (null for any other failure or when the header is missing).
 */
export function captureWait(): { fetchOptions: { onError: (context: HeaderSource) => void }; seconds: () => number | null } {
  let seconds: number | null = null;
  return {
    fetchOptions: {
      onError: (context) => {
        seconds = waitSecondsFromHeader(context.response.headers.get("x-retry-after"));
      },
    },
    seconds: () => seconds,
  };
}
