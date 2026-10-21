import { Suspense, type ReactNode } from "react";
import { requireRole } from "@/lib/auth/guard";

// Layer 2 for reports: clinical content. The page below re-checks, because this layout is not
// re-run on every navigation.
async function ClinicalOnly({ children }: { children: ReactNode }) {
  await requireRole("owner", "associate", "admin");
  return <>{children}</>;
}

export default function ReportsLayout({ children }: { children: ReactNode }) {
  return (
    <Suspense fallback={<p className="p-3 text-sm">Loading…</p>}>
      <ClinicalOnly>{children}</ClinicalOnly>
    </Suspense>
  );
}
