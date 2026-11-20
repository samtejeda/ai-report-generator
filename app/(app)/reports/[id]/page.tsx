import type { Metadata } from "next";
import { GuardedLink } from "@/components/unsaved/guarded-link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { DownloadButton } from "@/components/reports/download-button";
import { GenerateNotesBox } from "@/components/reports/generate-notes-box";
import { GenerationProvider } from "@/components/reports/generation-context";
import { FinalizeButton } from "@/components/reports/finalize-button";
import { LocalTime } from "@/components/reports/local-time";
import { UnsavedSummary } from "@/components/unsaved/unsaved-summary";
import { SectionEditor } from "@/components/reports/section-editor";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/guard";
import { REPORT_WRITE_ROLES } from "@/lib/auth/permissions";
import { getReportDetail } from "@/lib/db/report-access";
import { getEnv } from "@/lib/env";
import { canOfferExport } from "@/lib/reports/export-download";
import { generateOffer, isModelText } from "@/lib/reports/generate-control";
import { reportErrorNote, reportGeneratingNote } from "@/lib/reports/generate-messages";
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
  // Only a plain boolean reaches the browser: which wording to use. Never the endpoint or a model name.
  const realMode = getEnv().INFERENCE_MODE === "real";
  const offers = report.sections.map((s) => generateOffer({ canWrite, status: report.status, type: s.type, version: s.version }));
  const anyOffer = offers.some((o) => o !== null);
  const body = (
    <>
      {realMode && anyOffer ? <GenerateNotesBox /> : null}
      {report.sections.map((s, i) => (
        <SectionEditor
          key={s.id}
          reportId={report.id}
          sectionId={s.id}
          title={s.title}
          position={s.position}
          initialText={s.text}
          initialVersion={s.version}
          editable={editable}
          offer={offers[i]}
          realMode={realMode}
          isModelText={isModelText(s.editType)}
          flags={s.flags}
          editType={s.editType}
          authorName={s.authorName}
          editedAt={s.editedAt}
        />
      ))}
      {canOfferExport(session.role) ? <DownloadButton reportId={report.id} status={report.status} /> : null}
      {canWrite && report.status === "generated" ? <FinalizeButton reportId={report.id} /> : null}
    </>
  );
  return (
    <>
      <UnsavedSummary />
      <p className="text-sm">
        Status: <strong>{report.status}</strong>
        {report.finalizedAt ? (
          <>
            {" "}
            (finalized <LocalTime iso={report.finalizedAt} />)
          </>
        ) : null}
      </p>
      {report.status === "generating" ? <p className="text-sm">{reportGeneratingNote(realMode)}</p> : null}
      {report.status === "error" && canWrite ? <p className="text-sm">{reportErrorNote(realMode)}</p> : null}
      <GuardedLink href={`/clients/${report.clientId}`} className="text-sm underline">
        Back to the client
      </GuardedLink>
      {/* The notes and the "a run is in flight" state exist only for a person who can write: an admin's page has no provider and no controls. */}
      {canWrite ? (
        <GenerationProvider realMode={realMode} anyOffer={anyOffer}>
          {body}
        </GenerationProvider>
      ) : (
        body
      )}
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
