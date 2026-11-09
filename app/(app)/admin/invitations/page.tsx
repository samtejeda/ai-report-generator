import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { InvitationRow } from "@/components/admin/invitation-row";
import { InviteForm } from "@/components/admin/invite-form";
import { collectPages } from "@/lib/admin/collect-pages";
import { requireRole } from "@/lib/auth/guard";
import { listInvitations } from "@/lib/db/invitation-admin";

export const metadata: Metadata = { title: "Invitations", robots: { index: false } };

// Plain, unstyled (two-pass UI). Layer 3: the page checks the role itself, then reads only this
// practice's invitations (tenantDb). The list is ids, addresses, statuses and times: never a token.
async function Invitations() {
  const session = await requireRole("owner");
  const { items, truncated } = await collectPages((offset, limit) => listInvitations(session, { offset, limit }));
  return (
    <>
      <InviteForm />
      <h2 className="text-lg font-semibold">Invitations</h2>
      {items.length === 0 ? (
        <p className="text-sm">No invitations yet.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {items.map((invitation) => (
            <InvitationRow key={invitation.id} invitation={invitation} />
          ))}
        </ul>
      )}
      {truncated ? <p className="text-sm">Showing the newest {items.length} invitations.</p> : null}
    </>
  );
}

export default function InvitationsPage() {
  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-3 p-6">
      <Link href="/admin" className="text-sm underline">
        Back to practice
      </Link>
      <h1 className="text-xl font-semibold">Invite an associate</h1>
      <Suspense fallback={<p className="text-sm">Loading…</p>}>
        <Invitations />
      </Suspense>
    </main>
  );
}
