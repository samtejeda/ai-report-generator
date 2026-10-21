import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { UserRow } from "@/components/admin/user-row";
import { collectPages } from "@/lib/admin/collect-pages";
import { requireRole } from "@/lib/auth/guard";
import { listUsers } from "@/lib/db/user-admin";

export const metadata: Metadata = { title: "People", robots: { index: false } };

// Plain, unstyled (two-pass UI). Layer 3: the page checks the role itself, then reads only this
// practice's people (tenantDb). Deactivated people are listed so they can be reactivated.
async function People() {
  const session = await requireRole("owner");
  const { items, truncated } = await collectPages((offset, limit) => listUsers(session, { offset, limit }));
  return (
    <>
      <ul className="flex flex-col gap-3">
        {items.map((u) => (
          <UserRow key={u.id} actor={session} user={u} />
        ))}
      </ul>
      {truncated ? <p className="text-sm">Showing the first {items.length} people.</p> : null}
    </>
  );
}

export default function UsersPage() {
  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-3 p-6">
      <Link href="/admin" className="text-sm underline">
        Back to practice
      </Link>
      <h1 className="text-xl font-semibold">People</h1>
      <Suspense fallback={<p className="text-sm">Loading…</p>}>
        <People />
      </Suspense>
    </main>
  );
}
