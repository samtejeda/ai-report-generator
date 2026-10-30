"use client";

import { useEffect, useSyncExternalStore } from "react";
import { NO_UNSAVED, unsavedStore } from "@/lib/ui/unsaved-store";

/** The unsaved sections, in page order. Always empty on the server and in the first paint. */
export function useUnsavedSections() {
  return useSyncExternalStore(unsavedStore.subscribe, unsavedStore.getSnapshot, () => NO_UNSAVED);
}

/**
 * Tells the store this section is (or is no longer) unsaved. It lives in an effect on purpose:
 * Next keeps a page you leave alive and hidden, and a hidden page's effects are cleaned up, so a
 * page you left cannot warn you from somewhere else; they run again when it is shown. The draft
 * itself is NOT reset when hidden (lib/ui/reset-when-hidden.ts is for messages and secrets only).
 */
export function useRegisterUnsaved(entry: { key: string; title: string; position: number }, unsaved: boolean): void {
  const { key, title, position } = entry;
  useEffect(() => {
    if (!unsaved) return;
    return unsavedStore.register({ key, title, position });
  }, [unsaved, key, title, position]);
}
