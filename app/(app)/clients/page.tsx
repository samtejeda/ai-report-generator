import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/guard";
import { canWriteClients } from "@/lib/auth/permissions";
import { listClients } from "@/lib/db/client-access";

export const metadata: Metadata = { title: "Clients", robots: { index: false } };

// Plain, unstyled list (two-pass UI: restyling is a separate pass). Layer 3: the page checks the
// role itself, then reads through the query that only returns clients this caller may see.
async function ClientList() {
  const session = await requireRole("owner", "associate", "admin");
  const clients = await listClients(session);
  await audit(
    { organizationId: session.organizationId, actorUserId: session.userId },
    { action: "client.listed", resourceType: "client", metadata: { role: session.role } },
  );
  // The link is a convenience for roles that may create; the route and the page refuse everyone else.
  const newLink = canWriteClients(session.role) ? (
    <Link href="/clients/new" className="text-sm underline">
      New client
    </Link>
  ) : null;
  if (clients.length === 0) {
    return (
      <>
        {newLink}
        <p className="text-sm">No clients to show.</p>
      </>
    );
  }
  return (
    <>
      {newLink}
      <ul className="flex flex-col gap-1 text-sm">
        {clients.map((c) => (
          <li key={c.id}>
            <Link href={`/clients/${c.id}`} className="underline">
              {c.displayName}
            </Link>
            {c.gradeLevel ? `, grade ${c.gradeLevel}` : ""}
          </li>
        ))}
      </ul>
    </>
  );
}

export default function ClientsPage() {
  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-3 p-6">
      <h1 className="text-xl font-semibold">Clients</h1>
      <Suspense fallback={<p className="text-sm">Loading…</p>}>
        <ClientList />
      </Suspense>
    </main>
  );
}
