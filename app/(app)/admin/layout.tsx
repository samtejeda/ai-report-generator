import { Suspense, type ReactNode } from "react";
import { requireRole } from "@/lib/auth/guard";

// Layer 2 for practice administration: owner only. Anyone else gets the 404 page (and an audited
// denial). Every page below re-checks, because this layout is not re-run on every navigation.
async function OwnerOnly({ children }: { children: ReactNode }) {
  await requireRole("owner");
  return <>{children}</>;
}

export default function AdminLayout({ children }: { children: ReactNode }) {
  return (
    <Suspense fallback={<p className="p-3 text-sm">Loading…</p>}>
      <OwnerOnly>{children}</OwnerOnly>
    </Suspense>
  );
}
