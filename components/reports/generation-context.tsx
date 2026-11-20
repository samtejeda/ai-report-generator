"use client";

import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { useResetWhenHidden } from "@/lib/ui/reset-when-hidden";

// Report-level state for Generate and Regenerate, shared by every section on the page: the session
// notes (real mode) and "a run is in flight" (which pauses saving and finalizing). Only the page
// mounts it, and only for a person who can write; everywhere else the defaults below apply
// (no run, no notes), so an admin's page holds none of this.
//
// THE NOTES ARE NEVER STORED. They live in this component's state and nowhere else: no storage,
// no address, no cookie, no log (components/reports/generate-ui.test.ts scans for that). They are
// let go of when Next hides this page (a navigation away: useResetWhenHidden is a layout-effect
// cleanup that runs when React <Activity> hides the page or it unmounts), when the person presses
// Clear notes, when nothing on the page can be generated any more, and on a reload. Switching to
// another browser tab or window does NOT clear them (no visibility, blur or focus listener here):
// a psychologist copies notes in from another tab.

type Generation = {
  realMode: boolean;
  notes: string;
  setNotes: (notes: string) => void;
  clearNotes: () => void;
  running: boolean;
  /** False when a run is already in flight (one at a time per page). */
  startRun: () => boolean;
  endRun: () => void;
};

const NONE: Generation = {
  realMode: false,
  notes: "",
  setNotes: () => {},
  clearNotes: () => {},
  running: false,
  startRun: () => false,
  endRun: () => {},
};

const GenerationContext = createContext<Generation>(NONE);

/** True while a generation is running on this page; always false outside the provider. */
export function useGenerationRunning(): boolean {
  return useContext(GenerationContext).running;
}

export function useGeneration(): Generation {
  return useContext(GenerationContext);
}

export function GenerationProvider({ realMode, anyOffer, children }: { realMode: boolean; /** Some section can be generated or regenerated right now. */ anyOffer: boolean; children: ReactNode }) {
  const [notes, setNotes] = useState("");
  const [running, setRunning] = useState(false);
  const runningRef = useRef(false);

  useResetWhenHidden(() => setNotes(""));

  // Nothing left to generate (the report was finalized, say): let go of the notes.
  if (!anyOffer && notes !== "") setNotes("");

  const startRun = useCallback(() => {
    if (runningRef.current) return false;
    runningRef.current = true;
    setRunning(true);
    return true;
  }, []);
  const endRun = useCallback(() => {
    runningRef.current = false;
    setRunning(false);
  }, []);
  const clearNotes = useCallback(() => setNotes(""), []);

  const value = useMemo<Generation>(() => ({ realMode, notes, setNotes, clearNotes, running, startRun, endRun }), [realMode, notes, clearNotes, running, startRun, endRun]);
  return <GenerationContext.Provider value={value}>{children}</GenerationContext.Provider>;
}
