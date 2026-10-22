import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { requireRole } from "@/lib/auth/guard";

export const metadata: Metadata = { title: "Practice", robots: { index: false } };

// Plain, unstyled (two-pass UI). Layer 3: the page checks the role itself.
async function AdminLinks() {
  await requireRole("owner");
  return (
    <ul className="flex flex-col gap-2 text-sm">
      <li>
        <Link href="/admin/users" className="underline">
          People
        </Link>
      </li>
      <li>
        <Link href="/admin/assignments" className="underline">
          Client assignments
        </Link>
      </li>
      <li>
        <Link href="/admin/inference-endpoint" className="underline">
          Inference endpoint
        </Link>
      </li>
    </ul>
  );
}

export default function AdminPage() {
  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-3 p-6">
      <h1 className="text-xl font-semibold">Practice</h1>
      <Suspense fallback={<p className="text-sm">Loading…</p>}>
        <AdminLinks />
      </Suspense>
    </main>
  );
}
