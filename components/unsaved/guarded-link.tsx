"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ComponentProps } from "react";
import { unsavedStore } from "@/lib/ui/unsaved-store";

// next/link that asks before leaving while something is unsaved, using the documented onNavigate
// (node_modules/next/dist/docs/01-app/03-api-reference/02-components/link.md): it runs only for
// client-side navigations, not for modifier-key clicks or other sites, and preventDefault cancels
// it. If the person chooses to leave, the same destination is opened with the router. The
// data-nav-guard marker tells the guard's click handler (unsaved-guard.tsx) that this link is
// already handled, so exactly one dialog opens. Used for the (app) nav and the report page's back link.
export function GuardedLink({ href, replace, ...props }: Omit<ComponentProps<typeof Link>, "href" | "onNavigate"> & { href: string }) {
  const router = useRouter();
  return (
    <Link
      {...props}
      href={href}
      replace={replace}
      data-nav-guard=""
      onNavigate={(event) => {
        if (unsavedStore.getSnapshot().length === 0) return;
        event.preventDefault();
        void unsavedStore.askBeforeLeaving().then((leave) => {
          if (!leave) return;
          if (replace) router.replace(href);
          else router.push(href);
        });
      }}
    />
  );
}
