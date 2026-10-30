/**
 * The one place that knows "is anything unsaved". The section editors register here, and the page
 * summary, the leave dialog, the link guard and the Sign out button all read it, so they cannot
 * disagree. A plain module store with no React in it (components read it with useSyncExternalStore,
 * components/unsaved/use-unsaved.ts), which is why it can be unit-tested directly.
 *
 * It holds titles and section ids only, never the text of a draft. It is written from effects, so
 * on the server it is always empty. A page Next keeps hidden unregisters (effect cleanup) and
 * registers again when shown, so a page you left on purpose cannot warn you from elsewhere.
 */

export type UnsavedEntry = { key: string; title: string; /** Page order, so lists follow the report. */ position: number };

export type LeaveRequest = { sections: readonly UnsavedEntry[] };

export const NO_UNSAVED: readonly UnsavedEntry[] = Object.freeze([]);

/** How long the browser's own "leave site?" box stays out of the way after the person has chosen to leave. */
const LEAVE_GRACE_MS = 2000;

export function createUnsavedStore(now: () => number = () => Date.now()) {
  const entries = new Map<string, UnsavedEntry>();
  const listeners = new Set<() => void>();
  let snapshot: readonly UnsavedEntry[] = NO_UNSAVED;
  let pending: (LeaveRequest & { resolve: (leave: boolean) => void; promise: Promise<boolean> }) | null = null;
  let leavingUntil = 0;

  function emit() {
    for (const listener of [...listeners]) listener();
  }

  function rebuild() {
    snapshot = entries.size === 0 ? NO_UNSAVED : Object.freeze([...entries.values()].sort((a, b) => a.position - b.position || a.title.localeCompare(b.title) || a.key.localeCompare(b.key)));
  }

  return {
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },

    /** The unsaved sections in page order. The same array until something changes. */
    getSnapshot: (): readonly UnsavedEntry[] => snapshot,

    /** Marks a section unsaved (or updates its title or position). Returns the function that clears it. */
    register(entry: UnsavedEntry): () => void {
      const existing = entries.get(entry.key);
      if (!existing || existing.title !== entry.title || existing.position !== entry.position) {
        entries.set(entry.key, { ...entry });
        rebuild();
        emit();
      }
      return () => {
        if (entries.delete(entry.key)) {
          rebuild();
          emit();
        }
      };
    },

    /** The question on screen, if any. The same object until it is answered. */
    getPending: (): LeaveRequest | null => pending,

    /**
     * Asks whether it is all right to leave. Resolves true at once when nothing is unsaved;
     * otherwise opens the dialog (the guard component renders getPending) and resolves with the
     * answer. A second ask while one is open gets the same answer, not a second dialog.
     */
    askBeforeLeaving(): Promise<boolean> {
      if (pending) return pending.promise;
      if (snapshot.length === 0) return Promise.resolve(true);
      let resolve!: (leave: boolean) => void;
      const promise = new Promise<boolean>((r) => (resolve = r));
      pending = { sections: snapshot, resolve, promise };
      emit();
      return promise;
    },

    /** The person's answer: true = "Leave without saving", false = "Stay and save". */
    answer(leave: boolean): void {
      const current = pending;
      if (!current) return;
      pending = null;
      if (leave) leavingUntil = now() + LEAVE_GRACE_MS;
      current.resolve(leave);
      emit();
    },

    /** Call right before a full page load the person has already agreed to, so the browser's box does not ask twice. */
    allowUnload(): void {
      leavingUntil = now() + LEAVE_GRACE_MS;
    },

    unloadAllowed: (): boolean => now() < leavingUntil,
  };
}

export const unsavedStore = createUnsavedStore();
