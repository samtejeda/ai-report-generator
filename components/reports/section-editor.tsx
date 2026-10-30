"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { fieldClass } from "@/components/auth/auth-card";
import { GenerateSectionButton } from "@/components/reports/generate-section-button";
import { LocalTime } from "@/components/reports/local-time";
import { TEST_TEXT_MARKER } from "@/lib/reports/generate-messages";
import { versionAttribution } from "@/lib/reports/version-label";
import { useResetWhenHidden } from "@/lib/ui/reset-when-hidden";

type Version = { id: string; version: number; editType: string; text: string; createdAt: string; authorName: string | null };

// One section of a report: a text box, Save, and the section's history. Save sends the version the
// text was loaded from; if somebody saved first the server answers 409 and nothing is overwritten.
export function SectionEditor({
  reportId,
  sectionId,
  title,
  initialText,
  initialVersion,
  editable,
  canGenerate,
  isTestText,
  editType,
  authorName,
  editedAt,
}: {
  reportId: string;
  sectionId: string;
  title: string;
  initialText: string;
  initialVersion: number;
  editable: boolean;
  /** Decided on the server (lib/reports/generate-control.ts); the route re-checks it. */
  canGenerate: boolean;
  /** The current version is the test model's and nobody has edited it since. */
  isTestText: boolean;
  /** Who wrote the current version and when (null for a section nobody has written). Display name only. */
  editType: string | null;
  authorName: string | null;
  editedAt: string | null;
}) {
  const router = useRouter();
  const [version, setVersion] = useState(initialVersion);
  const [message, setMessage] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, setPending] = useState(false);
  const [history, setHistory] = useState<Version[] | null>(null);
  // Next keeps this page alive and hidden and restores it: drop stale "Saved as version N." and error
  // lines. The text in the box is a draft and stays.
  useResetWhenHidden(() => {
    setMessage(null);
    setSaved(false);
  });
  const [boxHasText, setBoxHasText] = useState(initialText.trim().length > 0);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = String(new FormData(event.currentTarget).get("text") ?? "");
    setPending(true);
    setMessage(null);
    setSaved(false);
    const res = await fetch(`/api/reports/${reportId}/sections/${sectionId}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, baseVersion: version }),
    }).catch(() => null);
    setPending(false);
    if (res?.ok) {
      const body = (await res.json()) as { data: { version: number } };
      setVersion(body.data.version);
      setSaved(true);
      setHistory(null);
      return router.refresh();
    }
    if (res?.status === 409) return setMessage("This section changed (or the report is closed). Reload the page to see the latest.");
    if (res?.status === 400) return setMessage("This text cannot be saved. It may be too long or contain unsupported characters.");
    setMessage("This could not be saved.");
  }

  async function showHistory() {
    const res = await fetch(`/api/reports/${reportId}/sections/${sectionId}/versions`).catch(() => null);
    if (!res?.ok) return setMessage("The history could not be loaded.");
    setHistory(((await res.json()) as { data: Version[] }).data);
  }

  return (
    <section className="flex flex-col gap-2 text-sm">
      <h2 className="text-base font-semibold">{title}</h2>
      {isTestText ? <p>{TEST_TEXT_MARKER}</p> : null}
      {editable ? (
        <form onSubmit={onSubmit} className="flex flex-col gap-2">
          <textarea name="text" defaultValue={initialText} rows={8} maxLength={20000} className={`${fieldClass} h-auto py-2`} aria-label={title} onChange={(e) => setBoxHasText(e.target.value.trim().length > 0)} />
          <Button type="submit" disabled={pending}>
            Save section
          </Button>
        </form>
      ) : (
        <p className="whitespace-pre-wrap">{initialText || "—"}</p>
      )}
      {editedAt ? (
        <p>
          {versionAttribution({ editType, authorName })} · <LocalTime iso={editedAt} />
        </p>
      ) : null}
      {editable && canGenerate ? <GenerateSectionButton reportId={reportId} sectionId={sectionId} boxHasText={boxHasText} /> : null}
      {message ? <p role="alert">{message}</p> : null}
      {saved ? <p role="status">Saved as version {version}.</p> : null}
      <button type="button" className="text-left underline" onClick={showHistory}>
        Show history ({version} {version === 1 ? "version" : "versions"})
      </button>
      {history ? (
        <ol className="flex flex-col gap-2">
          {history.map((v) => (
            <li key={v.id}>
              <span className="font-medium">Version {v.version}</span> · {versionAttribution(v)} · <LocalTime iso={v.createdAt} />
              <p className="whitespace-pre-wrap">{v.text || "—"}</p>
            </li>
          ))}
        </ol>
      ) : null}
    </section>
  );
}
