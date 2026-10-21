import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { InferenceEndpointForm } from "@/components/admin/inference-endpoint-form";
import { requireRole } from "@/lib/auth/guard";
import { tenantDb } from "@/lib/db/tenant";

export const metadata: Metadata = { title: "Inference endpoint", robots: { index: false } };

// Plain, unstyled (two-pass UI). Layer 3: the page checks the role itself, then reads this
// practice's own row (the organization comes from the session, never from the address bar).
async function EndpointSetting() {
  const session = await requireRole("owner");
  const org = await tenantDb({ organizationId: session.organizationId }).organization();
  const current = org?.inferenceEndpoint ?? null;
  return (
    <>
      <p className="text-sm">
        Current: <span className="break-all">{current ?? "none set"}</span>
      </p>
      <InferenceEndpointForm current={current} />
      <p className="text-sm">Saving or clearing needs a sign-in from the last few minutes; if it is older you will be asked to sign in again.</p>
    </>
  );
}

export default function InferenceEndpointPage() {
  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-3 p-6">
      <Link href="/admin" className="text-sm underline">
        Back to practice
      </Link>
      <h1 className="text-xl font-semibold">Inference endpoint</h1>
      <Suspense fallback={<p className="text-sm">Loading…</p>}>
        <EndpointSetting />
      </Suspense>
    </main>
  );
}
