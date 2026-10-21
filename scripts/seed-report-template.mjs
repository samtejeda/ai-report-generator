// Creates a practice's first report template and a PLACEHOLDER methodology prompt, so reports can
// exist before the practice owner's methodology has been written. Run by Sam (the person holding the
// database owner credential), once per practice. It is the same kind of approved, local-only
// exception as bootstrap-owner.mjs: it reads DATABASE_URL_UNPOOLED on purpose.
//
//   node scripts/seed-report-template.mjs --org "Practice name"            dry run: host, what exists, what it would create
//   node scripts/seed-report-template.mjs --org "Practice name" --apply    does it
//
// What it creates, in ONE transaction:
//   * a report template `psychoeducational-evaluation` whose structure is LAYOUT ONLY: six section
//     keys and titles (the list already in CLAUDE.md), all prose;
//   * methodology prompt version 1 with content {"placeholder": true} and a note saying so. It holds
//     NO methodology text and NO clinical wording: that is the practice owner's content and is
//     written later as version 2 (prompt rows are immutable; the template's pointer then moves).
//     Reports started before then pin version 1 and are test data. Whatever generates text MUST
//     refuse a prompt whose content has placeholder: true;
//   * the template's active-prompt pointer, and two audit rows (`template.created`,
//     `methodology_prompt.created`, method `seed_script`).
// It refuses (and changes nothing) if the practice does not exist or is ambiguous, has no active
// owner, or already has a template with that slug. SYNTHETIC DATA ONLY until Phase C.

export const TEMPLATE_SLUG = "psychoeducational-evaluation";
export const TEMPLATE_NAME = "Psychoeducational Evaluation";
export const TEMPLATE_STRUCTURE = {
  sections: [
    { key: "reason_for_referral", title: "Reason for Referral", type: "prose" },
    { key: "background_information", title: "Background Information", type: "prose" },
    { key: "behavioral_observations", title: "Behavioral Observations", type: "prose" },
    { key: "assessment_results", title: "Assessment Results", type: "prose" },
    { key: "summary_and_impressions", title: "Summary and Impressions", type: "prose" },
    { key: "recommendations", title: "Recommendations", type: "prose" },
  ],
};
export const PLACEHOLDER_CONTENT = { placeholder: true };
export const PLACEHOLDER_NOTES =
  "Placeholder so reports can exist before the methodology is written. Contains no methodology text; generation must refuse it.";

export async function seedReportTemplate(pool, input, { apply }) {
  const org = String(input.org ?? "").trim();
  if (!org || org.length > 200) return { status: "invalid_org" };
  const client = await pool.connect();
  try {
    await client.query("begin");
    const orgs = (await client.query("select id from organizations where lower(name) = lower($1) and deleted_at is null", [org])).rows;
    if (orgs.length === 0) {
      await client.query("rollback");
      return { status: "org_not_found" };
    }
    if (orgs.length > 1) {
      await client.query("rollback");
      return { status: "org_ambiguous" };
    }
    const orgId = orgs[0].id;
    const owner = (
      await client.query("select id from users where organization_id = $1 and role = 'owner' and deleted_at is null order by created_at, id limit 1", [orgId])
    ).rows[0];
    if (!owner) {
      await client.query("rollback");
      return { status: "owner_not_found" };
    }
    const dup = await client.query("select 1 from report_templates where organization_id = $1 and slug = $2 and deleted_at is null", [orgId, TEMPLATE_SLUG]);
    if (dup.rows.length) {
      await client.query("rollback");
      return { status: "template_exists" };
    }
    if (!apply) {
      await client.query("rollback");
      return {
        status: "dry_run",
        wouldCreate: { organizationId: orgId, template: TEMPLATE_SLUG, sections: TEMPLATE_STRUCTURE.sections.map((s) => s.key), promptVersion: 1, promptContent: PLACEHOLDER_CONTENT },
      };
    }

    const template = (
      await client.query("insert into report_templates (organization_id, slug, name, structure) values ($1, $2, $3, $4::jsonb) returning id", [
        orgId,
        TEMPLATE_SLUG,
        TEMPLATE_NAME,
        JSON.stringify(TEMPLATE_STRUCTURE),
      ])
    ).rows[0];
    const prompt = (
      await client.query(
        "insert into methodology_prompts (organization_id, template_id, version_number, content, notes, created_by_user_id) values ($1, $2, 1, $3::jsonb, $4, $5) returning id",
        [orgId, template.id, JSON.stringify(PLACEHOLDER_CONTENT), PLACEHOLDER_NOTES, owner.id],
      )
    ).rows[0];
    await client.query("update report_templates set active_methodology_prompt_id = $1 where id = $2 and organization_id = $3", [prompt.id, template.id, orgId]);
    const meta = JSON.stringify({ method: "seed_script" });
    await client.query(
      `insert into audit_log (organization_id, actor_user_id, action, resource_type, resource_id, outcome, metadata)
       values ($1, null, 'template.created', 'report_template', $2, 'success', $4::jsonb),
              ($1, null, 'methodology_prompt.created', 'methodology_prompt', $3, 'success', $4::jsonb)`,
      [orgId, template.id, prompt.id, meta],
    );
    await client.query("commit");
    return { status: "created", organizationId: orgId, templateId: template.id, promptId: prompt.id };
  } catch (error) {
    await client.query("rollback").catch(() => {});
    if (error && typeof error === "object" && error.code === "23505") return { status: "template_exists" };
    throw error;
  } finally {
    client.release();
  }
}

function parseArgs(argv) {
  const out = { apply: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") out.apply = true;
    else if (a === "--org") out.org = argv[++i];
    else return null;
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args || args.org === undefined) {
    console.error('usage: node scripts/seed-report-template.mjs --org "Practice name" [--apply]');
    process.exit(2);
  }
  try {
    process.loadEnvFile(".env.local");
  } catch {
    // Variables may already be set in the shell.
  }
  const url = process.env.DATABASE_URL_UNPOOLED;
  if (!url) {
    console.error("DATABASE_URL_UNPOOLED is not set (the owner credential in .env.local).");
    process.exit(2);
  }
  const { Pool } = await import("@neondatabase/serverless");
  console.log(`Database host: ${new URL(url).hostname}`);
  const pool = new Pool({ connectionString: url });
  try {
    const result = await seedReportTemplate(pool, args, { apply: args.apply });
    console.log(JSON.stringify(result, null, 2));
    if (result.status === "dry_run") console.log("Nothing changed. Add --apply to create the template and the placeholder prompt.");
    else if (result.status !== "created") process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

import { fileURLToPath } from "node:url";
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
