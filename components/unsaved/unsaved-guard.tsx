"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { classifyLink, isPlainLeftClick } from "@/lib/ui/link-guard";
import { LEAVE_BUTTON, LEAVE_DIALOG_HEADING, LEAVE_DIALOG_WARNING, leaveDialogIntro, STAY_BUTTON, unsavedTitles } from "@/lib/reports/unsaved";
import { unsavedStore } from "@/lib/ui/unsaved-store";
import { focusSectionBox } from "./focus-section-box";
import { useUnsavedSections } from "./use-unsaved";

// Mounted once, in the (app) layout. While any section has changes that are not saved it:
//  (a) asks the browser to confirm closing the tab, refreshing, typing an address or following a
//      link to another site (`beforeunload`). The browser draws that box itself: it is generic, it
//      cannot be styled and it cannot name a section; some browsers skip it for a page the person
//      has not interacted with.
//  (b) stops a click on any other link to a page of this site and asks with its own dialog. Links
//      made with GuardedLink do this through next/link's onNavigate and are skipped here (they carry
//      data-nav-guard); every other link is handled here and, if the person leaves, loads the page
//      normally. It also answers the Sign out button (askBeforeLeaving in the store).
// Nothing here is a gate; it only protects the person's own typing.
export function UnsavedGuard() {
  const sections = useUnsavedSections();
  const pending = useSyncExternalStore(unsavedStore.subscribe, unsavedStore.getPending, () => null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const stayRef = useRef<HTMLButtonElement>(null);
  const focusAfterClose = useRef<string | null>(null);
  const anyUnsaved = sections.length > 0;

  // (a) the browser's own box, only while something is unsaved.
  useEffect(() => {
    if (!anyUnsaved) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      // Not when the person has just chosen "Leave without saving" or signed out on purpose.
      if (unsavedStore.unloadAllowed()) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [anyUnsaved]);

  // (b) links that are not GuardedLink. Capture phase, so it runs before next/link's own handler.
  useEffect(() => {
    if (!anyUnsaved) return;
    const onClick = (event: MouseEvent) => {
      if (!isPlainLeftClick(event)) return;
      const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (!(anchor instanceof HTMLAnchorElement) || anchor.hasAttribute("data-nav-guard")) return;
      if (classifyLink(anchor.href, window.location.href, { target: anchor.getAttribute("target"), download: anchor.hasAttribute("download") }) !== "in-site") return;
      event.preventDefault();
      event.stopPropagation();
      const destination = anchor.href;
      void unsavedStore.askBeforeLeaving().then((leave) => {
        if (!leave) return;
        unsavedStore.allowUnload();
        window.location.assign(destination);
      });
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [anyUnsaved]);

  // The native dialog follows the store's pending question.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (pending && !dialog.open) {
      dialog.showModal();
      stayRef.current?.focus();
    } else if (!pending && dialog.open) {
      dialog.close();
      // After a "stay", put the cursor in the first unsaved box (closing first, or the browser's
      // focus restoration would win).
      const key = focusAfterClose.current;
      focusAfterClose.current = null;
      if (key) focusSectionBox(key);
    }
  }, [pending]);

  function stay() {
    focusAfterClose.current = pending?.sections[0]?.key ?? null;
    unsavedStore.answer(false);
  }

  const titles = pending ? unsavedTitles(pending.sections) : [];

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="unsaved-dialog-heading"
      onCancel={(event) => {
        // Esc is "stay".
        event.preventDefault();
        stay();
      }}
      className="m-auto w-[calc(100%-2rem)] max-w-md rounded-md border border-zinc-400 p-4 backdrop:bg-black/40"
    >
      {pending ? (
        <div className="flex flex-col gap-3 text-sm">
          <h2 id="unsaved-dialog-heading" className="text-base font-semibold">
            {LEAVE_DIALOG_HEADING}
          </h2>
          <p>{leaveDialogIntro(titles.length)}</p>
          <ul className="list-inside list-disc text-red-700">
            {titles.map((title, i) => (
              <li key={i}>{title}</li>
            ))}
          </ul>
          <p>{LEAVE_DIALOG_WARNING}</p>
          <div className="flex flex-col gap-2">
            <Button ref={stayRef} type="button" onClick={stay}>
              {STAY_BUTTON}
            </Button>
            <Button type="button" variant="outline" onClick={() => unsavedStore.answer(true)}>
              {LEAVE_BUTTON}
            </Button>
          </div>
        </div>
      ) : null}
    </dialog>
  );
}
