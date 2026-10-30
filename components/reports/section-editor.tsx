"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { fieldClass } from "@/components/auth/auth-card";
import { useRegisterUnsaved } from "@/components/unsaved/use-unsaved";
import { GenerateSectionButton } from "@/components/reports/generate-section-button";
import { LocalTime } from "@/components/reports/local-time";
import { TEST_TEXT_MARKER } from "@/lib/reports/generate-messages";
import { isUnsaved, reconcileDraft } from "@/lib/reports/draft";
import { HISTORY_UNAVAILABLE, SAVE_FAILED, SAVE_INVALID } from "@/lib/reports/save-messages";
import { saveSectionCall } from "@/lib/reports/save-section-call";
import {
  CANCELLED_NOTE,
  CANCEL_BUTTON,
  CONFLICT_AGAIN,
  CONFLICT_EXPLAIN,
  CONFLICT_HEADING,
  CONFLICT_MINE_LABEL,
  CONFLICT_THEIRS_LABEL,
  decideAfterRefusal,
  KEEP_MINE_BUTTON,
  readCurrentSection,
  SAVE_CLOSED,
  SAVE_GONE,
  SAVE_UNCHANGED,
  SAVE_UNREADABLE,
  TAKE_THEIRS_BUTTON,
  TOOK_THEIRS_NOTE,
  type CurrentSection,
} from "@/lib/reports/section-conflict";
import { sectionBoxId, UNSAVED_LABEL } from "@/lib/reports/unsaved";
import { versionAttribution } from "@/lib/reports/version-label";
import { useResetWhenHidden } from "@/lib/ui/reset-when-hidden";

type Version = { id: string; version: number; editType: string; text: string; createdAt: string; authorName: string | null };

/** A save the server refused because somebody saved first: their text, and the person's own. */
type Conflict = { theirs: CurrentSection; mine: string };

// One section of a report: a text box, Save, and the section's history.
//
// Save sends the version the text was loaded from (`base`). If somebody saved first the server
// answers 409 and nothing is overwritten; this component then reads the newer text and shows it
// beside the person's own with three buttons, and nothing is replaced without a click. The text in
// the box is a draft held in state: it is never replaced by a newer server copy unless the box is
// untouched (reconcileDraft), so another section's save, a refresh or a colleague's edit cannot
// wipe it (audit 01 item 7). The server re-checks every save; none of this is a gate.
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
  const headingId = useId();
  const unsavedLabelId = useId();
  const boxRef = useRef<HTMLTextAreaElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const hadConflict = useRef(false);

  // The draft in the box, and the version and text it was written against.
  const [draft, setDraft] = useState(initialText);
  const [base, setBase] = useState({ version: initialVersion, text: initialText });
  const [seen, setSeen] = useState({ initialText, initialVersion });
  const [message, setMessage] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, setPending] = useState(false);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [history, setHistory] = useState<Version[] | null>(null);

  // Next keeps this page alive and hidden and restores it: drop stale "Saved as version N." lines,
  // errors, and the other person's text. The draft in the box stays.
  useResetWhenHidden(() => {
    setMessage(null);
    setNote(null);
    setSaved(false);
    setConflict(null);
  });

  // The server's copy changed (a refresh after this or another section's save, a generation, a
  // colleague). While a conflict is on screen nothing is adopted; it is settled when it closes.
  if (!conflict && (seen.initialText !== initialText || seen.initialVersion !== initialVersion)) {
    setSeen({ initialText, initialVersion });
    if (seen.initialVersion !== initialVersion) setHistory(null);
    const next = reconcileDraft({ draft, base }, { version: initialVersion, text: initialText });
    setDraft(next.draft);
    setBase(next.base);
  }

  // A section is unsaved when its box differs from the last saved text. Cleared by a save, by taking
  // the other version, and by putting the text back. Registered in an effect (see use-unsaved.ts).
  const unsaved = editable && isUnsaved(draft, base.text);
  useRegisterUnsaved({ key: sectionId, title, position }, unsaved);

  // Move focus to the conflict when it appears and back to the box when it goes.
  useEffect(() => {
    if (conflict) {
      hadConflict.current = true;
      headingRef.current?.focus();
    } else if (hadConflict.current) {
      hadConflict.current = false;
      boxRef.current?.focus();
    }
  }, [conflict]);

  /** The server refused with 409: find out whether a colleague saved first or the report closed. */
  async function afterRefusal(mine: string, sentBase: number, again: boolean) {
    const outcome = decideAfterRefusal(await readCurrentSection(reportId, sectionId), sentBase);
    switch (outcome.kind) {
      case "newer":
        setConflict({ theirs: outcome.theirs, mine });
        return setMessage(again ? CONFLICT_AGAIN : null);
      case "closed":
        setConflict(null);
        return setMessage(SAVE_CLOSED);
      case "gone":
        setConflict(null);
        return setMessage(SAVE_GONE);
      case "unreadable":
        setConflict(null);
        return setMessage(SAVE_UNREADABLE);
      case "unchanged":
        setConflict(null);
        return setMessage(SAVE_UNCHANGED);
    }
  }

  function afterSaved(version: number, text: string) {
    setBase({ version, text });
    setDraft(text);
    setConflict(null);
    setSaved(true);
    setHistory(null);
    router.refresh();
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const mine = draft;
    setPending(true);
    setMessage(null);
    setNote(null);
    setSaved(false);
    const result = await saveSectionCall(reportId, sectionId, mine, base.version);
    if (result.ok) afterSaved(result.version, mine);
    else if (result.kind === "refused") await afterRefusal(mine, base.version, false);
    else setMessage(result.kind === "invalid" ? SAVE_INVALID : SAVE_FAILED);
    setPending(false);
  }

  async function keepMine() {
    if (!conflict) return;
    const { mine, theirs } = conflict;
    setPending(true);
    setMessage(null);
    const result = await saveSectionCall(reportId, sectionId, mine, theirs.version);
    if (result.ok) afterSaved(result.version, mine);
    else if (result.kind === "refused") await afterRefusal(mine, theirs.version, true);
    // Any other failure leaves the panel up so the choice is still there to make.
    else setMessage(result.kind === "invalid" ? SAVE_INVALID : SAVE_FAILED);
    setPending(false);
  }

  function takeTheirs() {
    if (!conflict) return;
    const { theirs } = conflict;
    setDraft(theirs.text);
    setBase({ version: theirs.version, text: theirs.text });
    setConflict(null);
    setMessage(null);
    setNote(TOOK_THEIRS_NOTE);
    setHistory(null);
    // Brings the section's line (author, time) and the page's other state up to date.
    router.refresh();
  }

  function cancelConflict() {
    setConflict(null);
    setMessage(null);
    setNote(CANCELLED_NOTE);
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
      {/* The form is hidden, not removed, while a conflict is on screen: the box keeps its text and is the focus target afterwards. */}
      {editable ? (
        <form onSubmit={onSubmit} className={conflict ? "hidden" : "flex flex-col gap-2"}>
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
          <Button type="submit" disabled={pending}>
            {pending ? "Saving…" : "Save section"}
          </Button>
        </form>
      ) : (
        <p className="whitespace-pre-wrap">{initialText || "—"}</p>
      )}
      {conflict ? (
        <div className="flex flex-col gap-3 rounded-md border border-zinc-400 p-3">
          <h3 ref={headingRef} id={headingId} tabIndex={-1} className="font-semibold">
            {CONFLICT_HEADING}
          </h3>
          <p>{CONFLICT_EXPLAIN}</p>
          <div className="flex flex-col gap-1">
            <h4 className="font-medium">{CONFLICT_MINE_LABEL}</h4>
            <p className="whitespace-pre-wrap rounded-md border border-zinc-300 p-2">{conflict.mine || "—"}</p>
          </div>
          <div className="flex flex-col gap-1">
            <h4 className="font-medium">{CONFLICT_THEIRS_LABEL}</h4>
            <p>
              {versionAttribution(conflict.theirs)}
              {conflict.theirs.editedAt ? (
                <>
                  {" "}
                  · <LocalTime iso={conflict.theirs.editedAt} />
                </>
              ) : null}{" "}
              (version {conflict.theirs.version})
            </p>
            <p className="whitespace-pre-wrap rounded-md border border-zinc-300 p-2">{conflict.theirs.text || "—"}</p>
          </div>
          <div className="flex flex-col gap-2">
            <Button type="button" onClick={keepMine} disabled={pending}>
              {pending ? "Saving…" : KEEP_MINE_BUTTON}
            </Button>
            <Button type="button" variant="outline" onClick={takeTheirs} disabled={pending}>
              {TAKE_THEIRS_BUTTON}
            </Button>
            <Button type="button" variant="outline" onClick={cancelConflict} disabled={pending}>
              {CANCEL_BUTTON}
            </Button>
          </div>
        </div>
      ) : null}
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
