import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  unique,
  uuid,
  vector,
} from "drizzle-orm/pg-core";
import { clients } from "./clients";
import { createdAt, deletedAt, organizationId, pk, updatedAt } from "./_shared";

export const RAG_SOURCE_TYPES = ["methodology", "example", "client_note", "client_report", "regulation"] as const;

// 768 dimensions = nomic-embed-text (the planned local embedding model). Changing the
// embedding model to a different size means a new column or table via a migration.
export const EMBEDDING_DIMENSIONS = 768;

// Scoped by organization; there are no shared (NULL-org) rows. Methodology and example
// content live here, in the database only, never in the repo.
export const ragDocuments = pgTable(
  "rag_documents",
  {
    id: pk(),
    organizationId: organizationId(),
    // Set for per-client prior notes and reports. Cascades on client purge, so derived
    // chunks and embeddings of that client's content are hard-deleted with it.
    clientId: uuid("client_id"),
    sourceType: text("source_type", { enum: RAG_SOURCE_TYPES }).notNull(),
    title: text("title").notNull(),
    // Pointer back to the origin (e.g. a report id), never the content itself.
    sourceRef: text("source_ref"),
    contentHash: text("content_hash"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [
    unique("rag_documents_org_id_uq").on(t.organizationId, t.id),
    foreignKey({
      name: "rag_documents_client_fk",
      columns: [t.organizationId, t.clientId],
      foreignColumns: [clients.organizationId, clients.id],
    }).onDelete("cascade"),
    index("rag_documents_org_source_type_idx").on(t.organizationId, t.sourceType),
    index("rag_documents_org_client_idx").on(t.organizationId, t.clientId),
    check(
      "rag_documents_source_type_valid",
      sql`${t.sourceType} in ('methodology','example','client_note','client_report','regulation')`,
    ),
    // Client-derived content must be attached to a client so a purge can find it.
    check(
      "rag_documents_client_sources_have_client",
      sql`${t.sourceType} not in ('client_note','client_report') or ${t.clientId} is not null`,
    ),
  ],
);

// Re-indexing replaces chunks (delete + insert), so these rows are not versioned.
export const ragChunks = pgTable(
  "rag_chunks",
  {
    id: pk(),
    organizationId: organizationId(),
    documentId: uuid("document_id").notNull(),
    chunkIndex: integer("chunk_index").notNull(),
    content: text("content").notNull(),
    tokenCount: integer("token_count"),
    createdAt: createdAt(),
  },
  (t) => [
    unique("rag_chunks_org_id_uq").on(t.organizationId, t.id),
    unique("rag_chunks_document_index_uq").on(t.documentId, t.chunkIndex),
    foreignKey({
      name: "rag_chunks_document_fk",
      columns: [t.organizationId, t.documentId],
      foreignColumns: [ragDocuments.organizationId, ragDocuments.id],
    }).onDelete("cascade"),
    index("rag_chunks_org_document_idx").on(t.organizationId, t.documentId),
  ],
);

export const ragEmbeddings = pgTable(
  "rag_embeddings",
  {
    id: pk(),
    organizationId: organizationId(),
    chunkId: uuid("chunk_id").notNull(),
    // Embedding model that produced the vector, so a re-embed can run side by side.
    model: text("model").notNull(),
    embedding: vector("embedding", { dimensions: EMBEDDING_DIMENSIONS }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique("rag_embeddings_chunk_model_uq").on(t.chunkId, t.model),
    foreignKey({
      name: "rag_embeddings_chunk_fk",
      columns: [t.organizationId, t.chunkId],
      foreignColumns: [ragChunks.organizationId, ragChunks.id],
    }).onDelete("cascade"),
    index("rag_embeddings_org_model_idx").on(t.organizationId, t.model),
    // Cosine distance. Retrieval always filters by organization_id: the retrieval helper
    // sets hnsw.iterative_scan so the tenant filter does not under-return results.
    index("rag_embeddings_embedding_hnsw_idx").using("hnsw", t.embedding.op("vector_cosine_ops")),
  ],
);
