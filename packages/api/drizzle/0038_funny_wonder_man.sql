CREATE TYPE "public"."memory_edge_relation" AS ENUM('relates_to', 'refines', 'caused_by', 'contradicts', 'duplicate_of', 'depends_on', 'about');--> statement-breakpoint
CREATE TABLE "memory_edges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repo_id" uuid,
	"src_memory_id" uuid NOT NULL,
	"dst_kind" varchar(8) NOT NULL,
	"dst_memory_id" uuid,
	"dst_path" text,
	"relation" "memory_edge_relation" NOT NULL,
	"weight" integer DEFAULT 50 NOT NULL,
	"origin" varchar(8) DEFAULT 'agent' NOT NULL,
	"created_by_agent_id" uuid,
	"source_run_id" uuid,
	"valid_to" timestamp with time zone,
	"quarantined_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "memory_edges" ADD CONSTRAINT "memory_edges_repo_id_repositories_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_edges" ADD CONSTRAINT "memory_edges_src_memory_id_agent_memories_id_fk" FOREIGN KEY ("src_memory_id") REFERENCES "public"."agent_memories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_edges" ADD CONSTRAINT "memory_edges_dst_memory_id_agent_memories_id_fk" FOREIGN KEY ("dst_memory_id") REFERENCES "public"."agent_memories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_edges" ADD CONSTRAINT "memory_edges_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_edges" ADD CONSTRAINT "memory_edges_source_run_id_ci_runs_id_fk" FOREIGN KEY ("source_run_id") REFERENCES "public"."ci_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "memory_edges_src_idx" ON "memory_edges" USING btree ("src_memory_id") WHERE valid_to is null and quarantined_at is null;--> statement-breakpoint
CREATE INDEX "memory_edges_dst_idx" ON "memory_edges" USING btree ("dst_memory_id") WHERE valid_to is null and quarantined_at is null;--> statement-breakpoint
CREATE INDEX "memory_edges_code_idx" ON "memory_edges" USING btree ("repo_id","dst_path") WHERE dst_kind = 'code' and valid_to is null and quarantined_at is null;--> statement-breakpoint
CREATE INDEX "memory_edges_author_idx" ON "memory_edges" USING btree ("created_by_agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "memory_edges_uniq_mem" ON "memory_edges" USING btree ("src_memory_id","relation","dst_memory_id") WHERE dst_kind = 'memory';--> statement-breakpoint
CREATE UNIQUE INDEX "memory_edges_uniq_code" ON "memory_edges" USING btree ("src_memory_id","relation","dst_path") WHERE dst_kind = 'code';