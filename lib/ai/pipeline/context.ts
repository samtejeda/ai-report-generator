import type { ExtractAnswer } from "./schemas";

/**
 * RAG SEAM. Retrieval plugs in here later (CLAUDE.md, "RAG"): the methodology sections for the
 * report type, similar examples, the client's prior sessions and reports, regulation snippets.
 * Nothing is retrieved today: no embedding model, no pgvector query, no migration.
 *
 * What the later implementation must keep: it receives the organization id and returns only that
 * practice's chunks (audit 14 item 9), and what it returns is the per-request context, so it is
 * rendered apart from the methodology block and never merged into it.
 */
export type RetrievedChunk = {
  source: "methodology" | "example" | "client_history" | "regulation";
  text: string;
};

export type ContextRequest = {
  organizationId: string;
  sectionKey: string;
  extracted: ExtractAnswer;
};

export type ContextProvider = (request: ContextRequest) => Promise<RetrievedChunk[]>;

/** The only provider today: nothing retrieved. */
export const noContext: ContextProvider = async () => [];

/** Small models degrade on long context: only a few short chunks are ever injected. */
export const MAX_CONTEXT_CHUNKS = 8;
export const MAX_CONTEXT_CHUNK_CHARS = 2000;

export function boundContext(chunks: RetrievedChunk[]): RetrievedChunk[] {
  return chunks.slice(0, MAX_CONTEXT_CHUNKS).map((c) => ({ source: c.source, text: c.text.slice(0, MAX_CONTEXT_CHUNK_CHARS) }));
}
