import { Suspense, type ReactNode } from "react";
import { requireRole } from "@/lib/auth/guard";

// Layer 2 for clinical content: renders nothing for a role that may not be here (an admin gets
// the 404 page). The page below re-checks, because this layout is not re-run on every navigation.
async function ClinicalOnly({ children }: { children: ReactNode }) {
  await requireRole("owner", "associate");
  return <>{children}</>;
}

export default function ClientsLayout({ children }: { children: ReactNode }) {
  return (
    <Suspense fallback={<p className="p-3 text-sm">Loading…</p>}>
      <ClinicalOnly>{children}</ClinicalOnly>
    </Suspense>
  );
}
