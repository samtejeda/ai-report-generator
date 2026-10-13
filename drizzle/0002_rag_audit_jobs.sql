CREATE TABLE "rag_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"chunk_index" integer NOT NULL,
	"content" text NOT NULL,
	"token_count" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rag_chunks_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "rag_chunks_document_index_uq" UNIQUE("document_id","chunk_index")
);
--> statement-breakpoint
CREATE TABLE "rag_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"client_id" uuid,
	"source_type" text NOT NULL,
	"title" text NOT NULL,
	"source_ref" text,
	"content_hash" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "rag_documents_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "rag_documents_source_type_valid" CHECK ("rag_documents"."source_type" in ('methodology','example','client_note','client_report','regulation')),
	CONSTRAINT "rag_documents_client_sources_have_client" CHECK ("rag_documents"."source_type" not in ('client_note','client_report') or "rag_documents"."client_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "rag_embeddings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"chunk_id" uuid NOT NULL,
	"model" text NOT NULL,
	"embedding" vector(768) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rag_embeddings_chunk_model_uq" UNIQUE("chunk_id","model")
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"actor_user_id" uuid,
	"action" text NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" uuid,
	"outcome" text DEFAULT 'success' NOT NULL,
	"request_id" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_log_outcome_valid" CHECK ("audit_log"."outcome" in ('success','failure','denied'))
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"type" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"resource_type" text,
	"resource_id" uuid,
	"attempts" integer DEFAULT 0 NOT NULL,
	"run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "jobs_status_valid" CHECK ("jobs"."status" in ('queued','running','succeeded','failed')),
	CONSTRAINT "jobs_attempts_nonneg" CHECK ("jobs"."attempts" >= 0)
);
--> statement-breakpoint
ALTER TABLE "rag_chunks" ADD CONSTRAINT "rag_chunks_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rag_chunks" ADD CONSTRAINT "rag_chunks_document_fk" FOREIGN KEY ("organization_id","document_id") REFERENCES "public"."rag_documents"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rag_documents" ADD CONSTRAINT "rag_documents_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rag_documents" ADD CONSTRAINT "rag_documents_client_fk" FOREIGN KEY ("organization_id","client_id") REFERENCES "public"."clients"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rag_embeddings" ADD CONSTRAINT "rag_embeddings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rag_embeddings" ADD CONSTRAINT "rag_embeddings_chunk_fk" FOREIGN KEY ("organization_id","chunk_id") REFERENCES "public"."rag_chunks"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "rag_chunks_org_document_idx" ON "rag_chunks" USING btree ("organization_id","document_id");--> statement-breakpoint
CREATE INDEX "rag_documents_org_source_type_idx" ON "rag_documents" USING btree ("organization_id","source_type");--> statement-breakpoint
CREATE INDEX "rag_documents_org_client_idx" ON "rag_documents" USING btree ("organization_id","client_id");--> statement-breakpoint
CREATE INDEX "rag_embeddings_org_model_idx" ON "rag_embeddings" USING btree ("organization_id","model");--> statement-breakpoint
CREATE INDEX "rag_embeddings_embedding_hnsw_idx" ON "rag_embeddings" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "audit_log_org_resource_idx" ON "audit_log" USING btree ("organization_id","resource_type","resource_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_log_org_created_idx" ON "audit_log" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_log_org_actor_created_idx" ON "audit_log" USING btree ("organization_id","actor_user_id","created_at");--> statement-breakpoint
CREATE INDEX "jobs_queue_idx" ON "jobs" USING btree ("status","run_at") WHERE "jobs"."status" = 'queued';--> statement-breakpoint
CREATE INDEX "jobs_org_status_idx" ON "jobs" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "jobs_org_resource_idx" ON "jobs" USING btree ("organization_id","resource_type","resource_id");