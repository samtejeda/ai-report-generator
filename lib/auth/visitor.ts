import { redirect } from "next/navigation";
import { authPageRedirect, type Visitor } from "./landing";
import { getEnrollingSessionOrNull, getSessionOrNull } from "./server";

/**
 * Who is asking, for the public sign-in pages and `/`. Server only. It reads no tenant data and
 * enforces nothing: these pages are public on purpose (lib/auth/public-surface.ts), the check
 * only decides where a signed-in person is better sent. Anything protected still calls
 * requireSession / requireRole itself.
 */
export async function currentVisitor(): Promise<Visitor> {
  if (await getSessionOrNull()) return "signed_in";
  if (await getEnrollingSessionOrNull()) return "enrolling";
  return "signed_out";
}

/** Call at the top of a sign-in page's async component: sends a signed-in person home, else returns. */
export async function leaveIfSignedIn(options: { resetLink?: boolean } = {}): Promise<void> {
  const target = authPageRedirect(await currentVisitor(), options);
  if (target) redirect(target);
}
