import { and, eq, isNull, sql, type SQL } from "drizzle-orm";
import type { NeonDatabase } from "drizzle-orm/neon-serverless";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import { z } from "zod";
import { getDb } from "./index";
import * as s from "./schema";

/**
 * Tenant-scoped data access. Feature code gets its data ONLY through `tenantDb(ctx)`;
 * a lint rule forbids importing the raw `getDb()` outside lib/db and the health route.
 *
 * Two independent layers keep tenants apart (audit 04 item 1):
 *
 * 1. Query guard (this file). What makes it impossible to omit organization_id:
 *    - every read and write adds `organization_id = ctx.organizationId` itself;
 *    - inserts inject the org id and reject a caller-supplied one;
 *    - updates cannot touch id / organization_id / created_at;
 *    - tables without an organization_id column are not accepted by the types;
 *    - insert-only tables (methodology_prompts, report_versions, audit_log) have no
 *      update or delete method at all, and the database forbids them anyway (0003).
 *
 * 2. Row-level security (migration 0004). Every operation runs inside a transaction that
 *    first sets `app.organization_id` for that transaction only. Policies on every tenant
 *    table match organization_id against it, so even a query that forgot its filter, or
 *    raw SQL, sees and changes only this tenant's rows. With no setting, nothing matches.
 *
 * The context must come from the server-side session, never from request input.
 */

export type TenantContext = { organizationId: string };

const uuidSchema = z.uuid();
export const MAX_PAGE_SIZE = 200;

// ---- Table registries: the single source of truth, checked against the schema in tests.
export const SOFT_DELETE_TABLES = [s.users, s.clients, s.clientHistory, s.reportTemplates, s.reports, s.ragDocuments] as const;
export const UPDATABLE_TABLES = [...SOFT_DELETE_TABLES, s.reportSections, s.jobs] as const;
export const INSERT_ONLY_TABLES = [s.methodologyPrompts, s.reportVersions, s.auditLog] as const;
// Derived / regenerable data the app may hard-delete (re-indexing replaces chunks).
export const DERIVED_DELETABLE_TABLES = [s.ragDocuments, s.ragChunks, s.ragEmbeddings, s.jobs] as const;
export const TENANT_TABLES = [
  ...UPDATABLE_TABLES,
  ...INSERT_ONLY_TABLES,
  s.ragChunks,
  s.ragEmbeddings,
] as const;

type TenantTable = (typeof TENANT_TABLES)[number];
type UpdatableTable = (typeof UPDATABLE_TABLES)[number];
type SoftDeleteTable = (typeof SOFT_DELETE_TABLES)[number];
type DerivedDeletableTable = (typeof DERIVED_DELETABLE_TABLES)[number];

type Row<T extends { $inferSelect: unknown }> = T["$inferSelect"];
type NewRow<T extends { $inferInsert: object }> = Omit<T["$inferInsert"], "organizationId">;
type UpdateRow<T extends { $inferInsert: object }> = Partial<Omit<T["$inferInsert"], "id" | "organizationId" | "createdAt">>;

/** A query you can `await`, and (for tests) inspect with `toSQL()` without a database. */
export type TenantQuery<R> = PromiseLike<R> & { toSQL(): { sql: string; params: unknown[] } };

export type FindOptions = {
  where?: SQL;
  orderBy?: SQL | SQL[];
  /** Required: every list is paginated (max MAX_PAGE_SIZE). */
  limit: number;
  offset?: number;
  /** Soft-deleted rows are hidden unless asked for. */
  includeDeleted?: boolean;
};

// Structural type (no $client) so tests can pass drizzle.mock() without a connection.
type Db = NeonDatabase<typeof s>;

const FORBIDDEN_UPDATE_KEYS = ["id", "organizationId", "createdAt"];

const purgeResultSchema = z.object({
  clients: z.number(),
  client_history: z.number(),
  reports: z.number(),
  report_sections: z.number(),
  report_versions: z.number(),
  rag_documents: z.number(),
  rag_chunks: z.number(),
  rag_embeddings: z.number(),
  jobs: z.number(),
});
export type PurgeResult = z.infer<typeof purgeResultSchema>;

function cols(table: PgTable): Record<string, PgColumn> {
  return table as unknown as Record<string, PgColumn>;
}

function assertUuid(value: string, what: string): string {
  if (!uuidSchema.safeParse(value).success) throw new Error(`${what} must be a UUID`);
  return value;
}

export function tenantDb(ctx: TenantContext, db: Db = getDb()) {
  const orgId = assertUuid(ctx.organizationId, "organizationId");

  function scope(table: PgTable, extra: (SQL | undefined)[], includeDeleted = false): SQL {
    const c = cols(table);
    const predicates: (SQL | undefined)[] = [eq(c.organizationId, orgId)];
    if (!includeDeleted && c.deletedAt) predicates.push(isNull(c.deletedAt));
    predicates.push(...extra);
    return and(...predicates) as SQL;
  }

  /**
   * Tells Postgres which tenant this transaction is for. The third argument (true) makes
   * the setting local to the transaction, so it can never leak to the next request that
   * reuses the pooled connection. The id is bound as a parameter and was validated above.
   */
  async function bindTenant(tx: Db): Promise<void> {
    await tx.execute(sql`select set_config('app.organization_id', ${orgId}, true)`);
  }

  /** Runs `work` in its own transaction with the tenant bound before anything else. */
  function inTenantTransaction<R>(work: (tx: Db) => PromiseLike<R>): Promise<R> {
    return db.transaction(async (tx) => {
      const bound = tx as unknown as Db;
      await bindTenant(bound);
      return work(bound);
    });
  }

  /**
   * `standalone`: each operation opens its own tenant transaction when awaited.
   * Otherwise `exec` is already a tenant-bound transaction (from `transaction()`).
   */
  function core(exec: Db, standalone: boolean) {
    function run<R>(build: (e: Db) => TenantQuery<R>): TenantQuery<R> {
      if (!standalone) return build(exec);
      // Building a query sends nothing; it is only executed when awaited.
      const preview = build(exec);
      const query: TenantQuery<R> = {
        toSQL: () => preview.toSQL(),
        then: (onFulfilled, onRejected) => inTenantTransaction((tx) => build(tx)).then(onFulfilled, onRejected),
      };
      return query;
    }

    return {
      organizationId: orgId,

      find<T extends TenantTable>(table: T, opts: FindOptions): TenantQuery<Row<T>[]> {
        if (!Number.isInteger(opts.limit) || opts.limit < 1 || opts.limit > MAX_PAGE_SIZE) {
          throw new Error(`limit must be an integer between 1 and ${MAX_PAGE_SIZE}`);
        }
        return run((e) => {
          let q = e
            .select()
            .from(table as PgTable)
            .where(scope(table, [opts.where], opts.includeDeleted))
            .$dynamic()
            .limit(opts.limit);
          if (opts.offset) q = q.offset(opts.offset);
          if (opts.orderBy) q = q.orderBy(...(Array.isArray(opts.orderBy) ? opts.orderBy : [opts.orderBy]));
          return q as unknown as TenantQuery<Row<T>[]>;
        });
      },

      /** One row by id within this organization, or undefined (respond 404). */
      async get<T extends TenantTable>(table: T, id: string, includeDeleted = false): Promise<Row<T> | undefined> {
        assertUuid(id, "id");
        const rows = await this.find(table, {
          where: eq(cols(table).id, id),
          limit: 1,
          includeDeleted,
        });
        return rows[0];
      },

      insert<T extends TenantTable>(table: T, values: NewRow<T> | NewRow<T>[]): TenantQuery<Row<T>[]> {
        const list = Array.isArray(values) ? values : [values];
        const rows = list.map((v) => {
          if ("organizationId" in (v as object)) throw new Error("organizationId is set by the tenant helper, not the caller");
          return { ...v, organizationId: orgId };
        });
        return run(
          (e) => e.insert(table as PgTable).values(rows as never).returning() as unknown as TenantQuery<Row<T>[]>,
        );
      },

      /** Empty result means "not found in this organization" (respond 404). */
      update<T extends UpdatableTable>(table: T, id: string, patch: UpdateRow<T>): TenantQuery<Row<T>[]> {
        assertUuid(id, "id");
        for (const key of FORBIDDEN_UPDATE_KEYS) {
          if (key in (patch as object)) throw new Error(`${key} cannot be updated`);
        }
        return run(
          (e) =>
            e
              .update(table as PgTable)
              .set(patch as never)
              .where(scope(table, [eq(cols(table).id, id)]))
              .returning() as unknown as TenantQuery<Row<T>[]>,
        );
      },

      softDelete<T extends SoftDeleteTable>(table: T, id: string): TenantQuery<Row<T>[]> {
        assertUuid(id, "id");
        return run(
          (e) =>
            e
              .update(table as PgTable)
              .set({ deletedAt: new Date() } as never)
              .where(scope(table, [eq(cols(table).id, id)]))
              .returning() as unknown as TenantQuery<Row<T>[]>,
        );
      },

      /** Hard delete of derived/regenerable rows only (RAG index, jobs). `where` is required. */
      deleteDerived<T extends DerivedDeletableTable>(table: T, where: SQL): TenantQuery<Row<T>[]> {
        return run(
          (e) =>
            e
              .delete(table as PgTable)
              .where(scope(table, [where], true))
              .returning() as unknown as TenantQuery<Row<T>[]>,
        );
      },

      /** The caller's own organization row. */
      async organization() {
        const rows = await run(
          (e) =>
            e
              .select()
              .from(s.organizations)
              .where(eq(s.organizations.id, orgId))
              .limit(1) as unknown as TenantQuery<(typeof s.organizations.$inferSelect)[]>,
        );
        return rows[0];
      },

      /**
       * Deliberately narrow: inference_endpoint and model_config are NOT settable here.
       * They change only through a dedicated admin action that validates against the
       * allow-list (audit 04 item 8).
       */
      updateOrganization(patch: Partial<Pick<typeof s.organizations.$inferInsert, "name" | "type" | "state">>) {
        return run(
          (e) =>
            e
              .update(s.organizations)
              .set(patch)
              .where(eq(s.organizations.id, orgId))
              .returning() as unknown as TenantQuery<(typeof s.organizations.$inferSelect)[]>,
        );
      },

      /**
       * HARD DELETE of a client and everything derived from it, via the purge_client()
       * database function. Not wired to any route. Calling it on anything but synthetic
       * data needs Sam's explicit approval. Returns row counts only; the caller writes
       * the audit event. The function itself refuses an organization other than the one
       * this transaction is bound to (migration 0004).
       */
      async purgeClient(clientId: string): Promise<PurgeResult> {
        assertUuid(clientId, "clientId");
        const call = (e: Db) => e.execute(sql`select purge_client(${orgId}::uuid, ${clientId}::uuid) as result`);
        const result = standalone ? await inTenantTransaction(call) : await call(exec);
        return purgeResultSchema.parse((result.rows[0] as { result: unknown }).result);
      },
    };
  }

  return {
    ...core(db, true),
    /** Runs `fn` in one transaction; the handle passed in is tenant-bound the same way. */
    transaction<R>(fn: (t: ReturnType<typeof core>) => Promise<R>): Promise<R> {
      return inTenantTransaction((tx) => fn(core(tx, false)));
    },
  };
}

export type TenantDb = ReturnType<typeof tenantDb>;
