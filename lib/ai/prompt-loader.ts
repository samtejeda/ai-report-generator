import { z } from "zod";
import { tenantDb, type TenantContext } from "@/lib/db/tenant";
import { methodologyPrompts, reportTemplates } from "@/lib/db/schema";
import { PipelineError } from "./errors";
import { parseMethodologyContent, type LoadedMethodology } from "./pipeline/methodology";

/**
 * Reads the active methodology prompt for a template, from `methodology_prompts`, through the
 * tenant data layer. The template's `active_methodology_prompt_id` says which version is active
 * (a composite foreign key pins it to a prompt of the same template and practice). Both reads
 * happen in one transaction bound to the caller's practice, so another practice's template or
 * prompt is simply not there: the same refusal as one that does not exist.
 *
 * The prompt text is never in this repository; this file only knows how to read it. It refuses
 * (PipelineError "methodology_unavailable", no detail) when there is no template, no active prompt,
 * a placeholder row (`{"placeholder": true}`, which the seed script says generation must refuse), or
 * content that does not parse. The caller records `promptId` with the generation.
 */

type Db = Parameters<typeof tenantDb>[1];

const unavailable = () => new PipelineError("methodology_unavailable");

export async function loadActivePrompt(ctx: TenantContext, templateId: string, db?: Db): Promise<LoadedMethodology> {
  if (!z.uuid().safeParse(templateId).success) throw unavailable();

  const found = await tenantDb(ctx, db).transaction(async (t) => {
    const template = await t.get(reportTemplates, templateId);
    if (!template || template.activeMethodologyPromptId === null) return null;
    const prompt = await t.get(methodologyPrompts, template.activeMethodologyPromptId);
    // The foreign key already guarantees this; checked again because a wrong prompt is worse than none.
    if (!prompt || prompt.templateId !== template.id) return null;
    return { promptId: prompt.id, versionNumber: prompt.versionNumber, content: prompt.content };
  });
  if (!found) throw unavailable();

  const methodology = parseMethodologyContent(found.content);
  if (!methodology) throw unavailable();
  return { promptId: found.promptId, versionNumber: found.versionNumber, methodology };
}
