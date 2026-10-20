import Link from "next/link";
import { Suspense, type ReactNode } from "react";
import { requireSession } from "@/lib/auth/server";
import { canReachClinicalContent } from "@/lib/auth/permissions";

// Layer 2 of the authorization chain: everything under (app) needs a session. A layout is not
// re-run on every client-side navigation, so it is never the only check: each page and route
// handler under here calls requireSession / requireRole itself. The nav hides links the role
// cannot use, for convenience only; the server refuses them anyway.
async function SignedIn({ children }: { children: ReactNode }) {
  const { role } = await requireSession();
  return (
    <>
      <nav className="flex gap-4 border-b border-zinc-200 p-3 text-sm">
        {canReachClinicalContent(role) ? <Link href="/clients">Clients</Link> : null}
        <Link href="/account">Account</Link>
      </nav>
      {children}
    </>
  );
}

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <Suspense fallback={<p className="p-3 text-sm">Loading…</p>}>
      <SignedIn>{children}</SignedIn>
    </Suspense>
  );
}
