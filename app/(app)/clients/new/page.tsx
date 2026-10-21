import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { ClientForm } from "@/components/clients/client-form";
import { requireRole } from "@/lib/auth/guard";

export const metadata: Metadata = { title: "New client", robots: { index: false } };

// Owner or associate only (an admin gets the 404 page). The page re-checks the role itself.
async function NewClient() {
  await requireRole("owner", "associate");
  return <ClientForm />;
}

export default function NewClientPage() {
  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-3 p-6">
      <Link href="/clients" className="text-sm underline">
        Back to clients
      </Link>
      <h1 className="text-xl font-semibold">New client</h1>
      <Suspense fallback={<p className="text-sm">Loading…</p>}>
        <NewClient />
      </Suspense>
    </main>
  );
}
