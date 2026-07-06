CREATE TABLE "code_graph_edges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repo_id" uuid NOT NULL,
	"src_path" text NOT NULL,
	"dst_path" text NOT NULL,
	"kind" varchar(16) DEFAULT 'imports' NOT NULL,
	"line" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "code_graph_nodes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repo_id" uuid NOT NULL,
	"path" text NOT NULL,
	"symbol" varchar(200) NOT NULL,
	"kind" varchar(16) NOT NULL,
	"line" integer DEFAULT 1 NOT NULL,
	"commit_sha" varchar(64) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "repositories" ADD COLUMN "graphify_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "viewed_full_diff" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "code_graph_edges" ADD CONSTRAINT "code_graph_edges_repo_id_repositories_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_graph_nodes" ADD CONSTRAINT "code_graph_nodes_repo_id_repositories_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "code_graph_edges_repo_src_idx" ON "code_graph_edges" USING btree ("repo_id","src_path");--> statement-breakpoint
CREATE INDEX "code_graph_edges_repo_dst_idx" ON "code_graph_edges" USING btree ("repo_id","dst_path");--> statement-breakpoint
CREATE INDEX "code_graph_nodes_repo_path_idx" ON "code_graph_nodes" USING btree ("repo_id","path");--> statement-breakpoint
CREATE INDEX "code_graph_nodes_repo_symbol_idx" ON "code_graph_nodes" USING btree ("repo_id","symbol");