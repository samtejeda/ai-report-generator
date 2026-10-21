import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { AssignClientForm } from "@/components/admin/assign-client-form";
import { EndAssignmentButton } from "@/components/admin/end-assignment-button";
import { collectPages } from "@/lib/admin/collect-pages";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/guard";
import { listAssignments } from "@/lib/db/assignment-admin";
import { listClients } from "@/lib/db/client-access";
import { listUsers } from "@/lib/db/user-admin";

export const metadata: Metadata = { title: "Client assignments", robots: { index: false } };

// Plain, unstyled (two-pass UI). Layer 3: the page checks the role itself. The assignments API
// returns ids only, so names are joined in here on the server from the owner's own views of
// clients and people. Showing client names is a client read, audited like /clients (role only).
async function Assignments() {
  const session = await requireRole("owner");
  const [people, clients, assignments] = await Promise.all([
    collectPages((offset, limit) => listUsers(session, { offset, limit })),
    collectPages((offset, limit) => listClients(session, { offset, limit })),
    collectPages((offset, limit) => listAssignments(session, { offset, limit })),
  ]);
  await audit(
    { organizationId: session.organizationId, actorUserId: session.userId },
    { action: "client.listed", resourceType: "client", metadata: { role: session.role } },
  );
  const personById = new Map(people.items.map((u) => [u.id, u]));
  const clientById = new Map(clients.items.map((c) => [c.id, c]));
  // Owners see every client and the server refuses to assign one; deactivated people cannot sign in.
  const assignable = people.items.filter((u) => u.active && u.role !== "owner");
  const truncated = people.truncated || clients.truncated || assignments.truncated;

  return (
    <>
      <section className="flex flex-col gap-2 text-sm">
        <h2 className="text-base font-semibold">Current assignments</h2>
        {assignments.items.length === 0 ? <p>No assignments yet. Associates and admins see no clients until you assign them.</p> : null}
        <ul className="flex flex-col gap-3">
          {assignments.items.map((a) => {
            const person = personById.get(a.userId);
            const client = clientById.get(a.clientId);
            const personText = person ? `${person.displayName} (${person.role}${person.active ? "" : ", deactivated"})` : "Unknown person";
            const clientText = client ? client.displayName : "Deleted client";
            return (
              <li key={a.id} className="flex flex-col gap-2 border-b border-zinc-200 pb-3">
                <p>
                  <span className="font-medium">{clientText}</span> assigned to {personText}
                </p>
                <p>Since {new Date(a.createdAt).toLocaleDateString()}</p>
                <EndAssignmentButton assignmentId={a.id} description={`${clientText}, ${person?.displayName ?? "unknown person"}`} />
              </li>
            );
          })}
        </ul>
      </section>
      <section className="flex flex-col gap-2 text-sm">
        <h2 className="text-base font-semibold">Assign a client</h2>
        {assignable.length === 0 ? <p>There is no active associate or admin to assign. Owners already see every client.</p> : null}
        {clients.items.length === 0 ? <p>There are no clients yet.</p> : null}
        {assignable.length > 0 && clients.items.length > 0 ? (
          <AssignClientForm
            people={assignable.map((u) => ({ id: u.id, label: `${u.displayName} (${u.role})` }))}
            clients={clients.items.map((c) => ({ id: c.id, label: c.displayName }))}
          />
        ) : null}
      </section>
      {truncated ? <p className="text-sm">A list was cut at 500 entries; the rest are not shown here.</p> : null}
    </>
  );
}

export default function AssignmentsPage() {
  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-4 p-6">
      <Link href="/admin" className="text-sm underline">
        Back to practice
      </Link>
      <h1 className="text-xl font-semibold">Client assignments</h1>
      <Suspense fallback={<p className="text-sm">Loading…</p>}>
        <Assignments />
      </Suspense>
    </main>
  );
}
