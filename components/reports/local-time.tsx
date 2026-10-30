"use client";

import { useSyncExternalStore } from "react";
import { formatLocal, formatUtc } from "@/lib/ui/format-time";

const subscribe = () => () => {};

// A time in the viewer's own zone. The server and the first browser paint print UTC (they cannot
// know the zone); React then switches to local time without a hydration mismatch, because the
// server snapshot is what hydration compares against. Plain text inside a <time> element.
export function LocalTime({ iso }: { iso: string }) {
  const text = useSyncExternalStore(
    subscribe,
    () => formatLocal(iso),
    () => formatUtc(iso),
  );
  return <time dateTime={iso}>{text}</time>;
}
