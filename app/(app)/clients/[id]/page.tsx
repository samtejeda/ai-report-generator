import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { ClientForm } from "@/components/clients/client-form";
import { DeleteClientButton } from "@/components/clients/delete-client-button";
import { NewReportButton } from "@/components/reports/new-report-button";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/guard";
import { canWriteClients, REPORT_WRITE_ROLES } from "@/lib/auth/permissions";
import { getClient } from "@/lib/db/client-access";
import { listReports } from "@/lib/db/report-access";

export const metadata: Metadata = { title: "Client", robots: { index: false } };

// One client, if this caller may see it (the query decides; anything else is the 404 page, the same
// for a client in another practice, one not assigned, and one that does not exist). The owner and
// an associate with the client assigned get the edit form; an admin with a grant reads only.
async function ClientDetail({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireRole("owner", "associate", "admin");
  const { id } = await params;
  const client = await getClient(session, id);
  if (!client) notFound();
  const canWriteReports = (REPORT_WRITE_ROLES as readonly string[]).includes(session.role);
  await audit(
    { organizationId: session.organizationId, actorUserId: session.userId },
    { action: "client.viewed", resourceType: "client", resourceId: client.id, metadata: { role: session.role } },
  );
  const reports = await listReports(session, { clientId: client.id, limit: 100 });
  await audit(
    { organizationId: session.organizationId, actorUserId: session.userId },
    { action: "report.listed", resourceType: "report", metadata: { role: session.role } },
  );
  const reportsBlock = (
    <section className="flex flex-col gap-2 text-sm">
      <h2 className="text-base font-semibold">Reports</h2>
      {reports.length === 0 ? <p>No reports yet.</p> : null}
      <ul className="flex flex-col gap-1">
        {reports.map((r) => (
          <li key={r.id}>
            <Link href={`/reports/${r.id}`} className="underline">
              {new Date(r.createdAt).toLocaleDateString()}
            </Link>{" "}
            ({r.status})
          </li>
        ))}
      </ul>
      {canWriteReports ? <NewReportButton clientId={client.id} /> : null}
    </section>
  );
  if (!canWriteClients(session.role)) {
    return (
      <>
        <dl className="flex flex-col gap-1 text-sm">
          <dt className="font-medium">Display name</dt>
          <dd>{client.displayName}</dd>
          <dt className="font-medium">Date of birth</dt>
          <dd>{client.dateOfBirth ?? "—"}</dd>
          <dt className="font-medium">Grade level</dt>
          <dd>{client.gradeLevel ?? "—"}</dd>
          <dt className="font-medium">External ID</dt>
          <dd>{client.externalId ?? "—"}</dd>
        </dl>
        {reportsBlock}
      </>
    );
  }
  return (
    <>
      <ClientForm
        clientId={client.id}
        initial={{
          displayName: client.displayName,
          dateOfBirth: client.dateOfBirth ?? "",
          gradeLevel: client.gradeLevel ?? "",
          externalId: client.externalId ?? "",
        }}
      />
      {reportsBlock}
      {session.role === "owner" ? <DeleteClientButton clientId={client.id} /> : null}
    </>
  );
}

export default function ClientPage({ params }: PageProps<"/clients/[id]">) {
  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-3 p-6">
      <Link href="/clients" className="text-sm underline">
        Back to clients
      </Link>
      <h1 className="text-xl font-semibold">Client</h1>
      <Suspense fallback={<p className="text-sm">Loading…</p>}>
        <ClientDetail params={params} />
      </Suspense>
    </main>
  );
}
