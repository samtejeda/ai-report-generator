export function generateTemporaryPassword(): string;
export function bootstrapOwner(
  pool: unknown,
  input: { org?: string; email?: string; name?: string; state?: string },
  options: { apply: boolean },
): Promise<
  | { status: "invalid_org" | "invalid_email" | "invalid_name" | "invalid_state" | "email_exists" | "org_exists" }
  | { status: "dry_run"; wouldCreate: { organization: string; state: string | null; ownerEmail: string; ownerName: string }; existing: { organizations: number; users: number } }
  | { status: "created"; organizationId: string; userId: string; email: string; temporaryPassword: string }
>;
