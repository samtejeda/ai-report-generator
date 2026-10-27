import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { FinalizeButton } from "@/components/reports/finalize-button";
import { SectionEditor } from "@/components/reports/section-editor";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/guard";
import { REPORT_WRITE_ROLES } from "@/lib/auth/permissions";
import { getReportDetail } from "@/lib/db/report-access";
import { canOfferGenerate, isTestModelText } from "@/lib/reports/generate-control";
import { REPORT_ERROR_NOTE, REPORT_GENERATING_NOTE } from "@/lib/reports/generate-messages";
import { isEditable } from "@/lib/reports/status";

export const metadata: Metadata = { title: "Report", robots: { index: false } };

// One report, if the caller may see its client (the query decides; anything else is the 404 page,
// the same for another practice's report, one not assigned, and one that does not exist). Owner and
// associate can edit sections while the report is open; an admin with a grant reads only.
async function ReportDetail({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireRole("owner", "associate", "admin");
  const { id } = await params;
  const report = await getReportDetail(session, id);
  if (!report) notFound();
  await audit(
    { organizationId: session.organizationId, actorUserId: session.userId },
    { action: "report.viewed", resourceType: "report", resourceId: report.id, metadata: { role: session.role } },
  );
  const canWrite = (REPORT_WRITE_ROLES as readonly string[]).includes(session.role);
  const editable = canWrite && isEditable(report.status);
  return (
    <>
      <p className="text-sm">
        Status: <strong>{report.status}</strong>
        {report.finalizedAt ? ` (finalized ${new Date(report.finalizedAt).toLocaleString()})` : ""}
      </p>
      {report.status === "generating" ? <p className="text-sm">{REPORT_GENERATING_NOTE}</p> : null}
      {report.status === "error" && canWrite ? <p className="text-sm">{REPORT_ERROR_NOTE}</p> : null}
      <Link href={`/clients/${report.clientId}`} className="text-sm underline">
        Back to the client
      </Link>
      {report.sections.map((s) => (
        <SectionEditor
          key={`${s.id}:${s.version}`}
          reportId={report.id}
          sectionId={s.id}
          title={s.title}
          initialText={s.text}
          initialVersion={s.version}
          editable={editable}
          canGenerate={canOfferGenerate({ canWrite, status: report.status, type: s.type, version: s.version })}
          isTestText={isTestModelText(s.editType)}
        />
      ))}
      {canWrite && report.status === "generated" ? <FinalizeButton reportId={report.id} /> : null}
    </>
  );
}

export default function ReportPage({ params }: PageProps<"/reports/[id]">) {
  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-4 p-6">
      <h1 className="text-xl font-semibold">Report</h1>
      <Suspense fallback={<p className="text-sm">Loading…</p>}>
        <ReportDetail params={params} />
      </Suspense>
    </main>
  );
}
