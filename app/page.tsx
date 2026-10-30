import { redirect } from "next/navigation";
import { Suspense } from "react";
import { rootRedirect } from "@/lib/auth/landing";
import { currentVisitor } from "@/lib/auth/visitor";

// `/` has no content of its own: a signed-in person goes to the working home, a person who has not
// finished setting up the authenticator app goes to finish it, everyone else to sign in. The check
// is server side, here; it reads no tenant data (the page stays on the public list).
async function Landing() {
  redirect(rootRedirect(await currentVisitor()));
  return null;
}

export default function Home() {
  return (
    <Suspense fallback={<p className="p-6 text-sm">Loading…</p>}>
      <Landing />
    </Suspense>
  );
}
