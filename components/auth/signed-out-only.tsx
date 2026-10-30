import type { ReactNode } from "react";
import { leaveIfSignedIn } from "@/lib/auth/visitor";

// For the public sign-in pages: a person who is already signed in is sent to the working home
// instead of being shown a sign-in form. Server side, in the page (proxy.ts stays a cookie-presence
// check). It reads no tenant data and gates nothing: these pages stay public.
export async function SignedOutOnly({ children }: { children: ReactNode }) {
  await leaveIfSignedIn();
  return children;
}
