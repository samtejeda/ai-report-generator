"use client";

import { useRouter } from "next/navigation";
import { useCallback, useId, useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { fieldClass } from "@/components/auth/auth-card";
import { useRegisterUnsaved } from "@/components/unsaved/use-unsaved";
import { GenerateSectionButton } from "@/components/reports/generate-section-button";
import { LocalTime } from "@/components/reports/local-time";
import { SectionConflictNotice } from "@/components/reports/section-conflict-notice"; // REMOVABLE (see use-section-conflict.ts)
import { useSectionConflict } from "@/components/reports/use-section-conflict"; // REMOVABLE
import { TEST_TEXT_MARKER } from "@/lib/reports/generate-messages";
import { isUnsaved, reconcileDraft } from "@/lib/reports/draft";
import { HISTORY_UNAVAILABLE, SAVE_FAILED, SAVE_INVALID } from "@/lib/reports/save-messages";
import { saveSectionCall } from "@/lib/reports/save-section-call";
import { sectionBoxId, UNSAVED_LABEL } from "@/lib/reports/unsaved";
import { versionAttribution } from "@/lib/reports/version-label";
import { useResetWhenHidden } from "@/lib/ui/reset-when-hidden";

type Version = { id: string; version: number; editType: string; text: string; createdAt: string; authorName: string | null };

// One section of a report: a text box, Save, and the section's history.
//
// The box is a draft held in state. Save sends the version the draft was based on (`base`); if
// somebody saved first the server answers 409 and nothing is overwritten (what the page then shows
// is the REMOVABLE conflict notice). The draft is never replaced by a newer server copy unless the
// box is untouched (reconcileDraft), so another section's save, a refresh or a colleague's edit
// cannot wipe it, and it is not reset when Next hides the page. A section whose box differs from
// the last saved text is "unsaved": it is labelled, listed at the top of the page and guarded
// against leaving (components/unsaved). The server re-checks every save; none of this is a gate.
export function SectionEditor({
  reportId,
  sectionId,
  title,
  position,
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
  /** The section's place in the report, so the unsaved list follows page order. */
  position: number;
  /** The server's current text and version. When they change the box follows only if untouched. */
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
  const unsavedLabelId = useId();
  const boxRef = useRef<HTMLTextAreaElement>(null);

  // The draft in the box, and the version and text it was written against.
  const [draft, setDraft] = useState(initialText);
  const [base, setBase] = useState({ version: initialVersion, text: initialText });
  const [seen, setSeen] = useState({ initialText, initialVersion });
  const [message, setMessage] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, setPending] = useState(false);
  const [history, setHistory] = useState<Version[] | null>(null);

  // Next keeps this page alive and hidden and restores it: drop stale "Saved as version N." lines
  // and errors. The draft in the box stays; it is not a message.
  useResetWhenHidden(() => {
    setMessage(null);
    setNote(null);
    setSaved(false);
  });

  /** A save went through (here, or from the conflict notice). */
  function afterSaved(version: number, text: string) {
    setBase({ version, text });
    setDraft(text);
    setSaved(true);
    setHistory(null);
    router.refresh();
  }

  // REMOVABLE block 1 of 4: the conflict state and handlers.
  const focusBox = useCallback(() => boxRef.current?.focus(), []);
  const conflict = useSectionConflict({
    reportId,
    sectionId,
    getDraft: () => draft,
    onSaved: afterSaved,
    onTookTheirs: (theirs) => {
      setDraft(theirs.text);
      setBase({ version: theirs.version, text: theirs.text });
      setHistory(null);
      // Brings the section's line (author, time) and the page's other state up to date.
      router.refresh();
    },
    report: setMessage,
    note: setNote,
    setBusy: setPending,
    focusBox,
  });
  const conflictOpen = conflict.open; // REMOVABLE (without the feature this is `false`)

  // The server's copy changed (a refresh after this or another section's save, a generation, a
  // colleague). The box follows only if untouched. REMOVABLE block 2 of 4: while the conflict
  // notice is open nothing is adopted; it is settled when the notice closes.
  if (!conflictOpen && (seen.initialText !== initialText || seen.initialVersion !== initialVersion)) {
    setSeen({ initialText, initialVersion });
    if (seen.initialVersion !== initialVersion) setHistory(null);
    const next = reconcileDraft({ draft, base }, { version: initialVersion, text: initialText });
    setDraft(next.draft);
    setBase(next.base);
  }

  // A section is unsaved when its box differs from the last saved text. Cleared by a save, by "Use
  // theirs instead", and by putting the text back. Registered in an effect (see use-unsaved.ts).
  const unsaved = editable && isUnsaved(draft, base.text);
  useRegisterUnsaved({ key: sectionId, title, position }, unsaved);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setMessage(null);
    setNote(null);
    setSaved(false);
    const result = await saveSectionCall(reportId, sectionId, draft, base.version);
    if (result.ok) afterSaved(result.version, draft);
    // REMOVABLE block 3 of 4: a 409 is explained by the conflict notice. Without it: setMessage(SAVE_FAILED).
    else if (result.kind === "refused") await conflict.handleRefusal(base.version);
    else setMessage(result.kind === "invalid" ? SAVE_INVALID : SAVE_FAILED);
    setPending(false);
  }

  async function showHistory() {
    const res = await fetch(`/api/reports/${reportId}/sections/${sectionId}/versions`).catch(() => null);
    if (!res?.ok) return setMessage(HISTORY_UNAVAILABLE);
    setHistory(((await res.json()) as { data: Version[] }).data);
  }

  const shownVersion = Math.max(initialVersion, base.version);

  return (
    <section className="flex flex-col gap-2 text-sm">
      <div className="flex flex-wrap items-baseline gap-x-3">
        <h2 className="text-base font-semibold">{title}</h2>
        {unsaved ? (
          <span id={unsavedLabelId} className="font-medium text-red-700">
            {UNSAVED_LABEL}
          </span>
        ) : null}
      </div>
      {isTestText ? <p>{TEST_TEXT_MARKER}</p> : null}
      {editable ? (
        <form onSubmit={onSubmit} className="flex flex-col gap-2">
          <textarea
            ref={boxRef}
            id={sectionBoxId(sectionId)}
            aria-describedby={unsaved ? unsavedLabelId : undefined}
            name="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={8}
            maxLength={20000}
            className={`${fieldClass} h-auto py-2`}
            aria-label={title}
          />
          {/* REMOVABLE block 4 of 4: while the notice is open its two buttons replace Save. Without it: always the Save button. */}
          {conflictOpen && conflict.theirs ? (
            <SectionConflictNotice theirs={conflict.theirs} showTheirs={conflict.showTheirs} busy={pending} onToggle={conflict.toggleTheirs} onSaveMine={conflict.saveMine} onUseTheirs={conflict.useTheirs} />
          ) : (
            <Button type="submit" disabled={pending}>
              {pending ? "Saving…" : "Save section"}
            </Button>
          )}
        </form>
      ) : (
        <p className="whitespace-pre-wrap">{initialText || "—"}</p>
      )}
      {editedAt ? (
        <p>
          {versionAttribution({ editType, authorName })} · <LocalTime iso={editedAt} />
        </p>
      ) : null}
      {editable && canGenerate ? <GenerateSectionButton reportId={reportId} sectionId={sectionId} boxHasText={draft.trim().length > 0} /> : null}
      {message ? <p role="alert">{message}</p> : null}
      {note ? <p role="status">{note}</p> : null}
      {saved ? <p role="status">Saved as version {base.version}.</p> : null}
      <button type="button" className="text-left underline" onClick={showHistory}>
        Show history ({shownVersion} {shownVersion === 1 ? "version" : "versions"})
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
