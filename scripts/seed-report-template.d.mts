export const TEMPLATE_SLUG: string;
export const TEMPLATE_NAME: string;
export const TEMPLATE_STRUCTURE: { sections: { key: string; title: string; type: string }[] };
export const PLACEHOLDER_CONTENT: { placeholder: true };
export const PLACEHOLDER_NOTES: string;
export function seedReportTemplate(
  pool: unknown,
  input: { org?: string },
  options: { apply: boolean },
): Promise<
  | { status: "invalid_org" | "org_not_found" | "org_ambiguous" | "owner_not_found" | "template_exists" }
  | { status: "dry_run"; wouldCreate: { organizationId: string; template: string; sections: string[]; promptVersion: number; promptContent: { placeholder: true } } }
  | { status: "created"; organizationId: string; templateId: string; promptId: string }
>;
