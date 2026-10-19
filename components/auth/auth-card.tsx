import type { ReactNode } from "react";

// Plain placeholder styling: the design system is not chosen yet (see DESIGN.md).
export function AuthCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-4 p-6">
      <h1 className="text-xl font-semibold">{title}</h1>
      {children}
    </main>
  );
}

export const fieldClass = "h-9 w-full rounded-md border border-zinc-300 bg-transparent px-3 text-sm";
