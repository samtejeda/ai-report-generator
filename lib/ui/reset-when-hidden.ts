"use client";

import { useLayoutEffect, useRef } from "react";

/**
 * Next 16 with Cache Components keeps a page you leave alive and hidden (React <Activity>) and
 * restores its React state and DOM values when you come back. That is right for a draft, wrong for
 * a status message ("Saved.", "Your password was changed."), a secret held in state (backup codes,
 * a setup key) or a typed password. These two helpers are the documented way to let go of such
 * things when the page is hidden (node_modules/next/dist/docs/01-app/02-guides/preserving-ui-state.md):
 * a layout-effect cleanup, and a callback ref that calls form.reset().
 *
 * Both also run on unmount, which is harmless. Neither can be exercised without a browser (there
 * is no component test tooling here), so each use is on the list of things to click through.
 */

/**
 * Calls `reset` whenever the component is hidden or unmounted. Put ONLY what must not survive
 * leaving the page in it: messages, revealed passwords, secrets. Do not reset a person's draft.
 */
export function useResetWhenHidden(reset: () => void): void {
  const latest = useRef(reset);
  useLayoutEffect(() => {
    latest.current = reset;
  });
  useLayoutEffect(() => () => latest.current(), []);
}

/**
 * `<form ref={resetFormWhenHidden}>`: clears every field to its default value when the page is
 * hidden. For forms whose fields hold passwords or codes; never for a draft the person may want back.
 */
export function resetFormWhenHidden(form: HTMLFormElement | null): () => void {
  return () => form?.reset();
}
