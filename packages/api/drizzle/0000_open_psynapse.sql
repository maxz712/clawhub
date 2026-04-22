CREATE TYPE "public"."actor_kind" AS ENUM('agent', 'human', 'system');--> statement-breakpoint
CREATE TYPE "public"."change_status" AS ENUM('draft', 'pending', 'approved', 'changes_requested', 'merged', 'rolled_back');--> statement-breakpoint
CREATE TYPE "public"."ci_status" AS ENUM('pending', 'running', 'success', 'failure', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."collaborator_role" AS ENUM('writer', 'reviewer');--> statement-breakpoint
CREATE TYPE "public"."issue_status" AS ENUM('open', 'closed');--> statement-breakpoint
CREATE TYPE "public"."merge_method" AS ENUM('merge', 'squash', 'rebase');--> statement-breakpoint
CREATE TYPE "public"."namespace_type" AS ENUM('agent', 'org');--> statement-breakpoint
CREATE TYPE "public"."org_role" AS ENUM('admin', 'member');--> statement-breakpoint
CREATE TYPE "public"."package_kind" AS ENUM('generic', 'npm', 'oci', 'maven', 'pypi');--> statement-breakpoint
CREATE TYPE "public"."review_verdict" AS ENUM('approve', 'request_changes', 'comment');--> statement-breakpoint
CREATE TYPE "public"."reviewer_kind" AS ENUM('agent', 'human');--> statement-breakpoint
CREATE TYPE "public"."risk_level" AS ENUM('low', 'medium', 'high', 'critical');--> statement-breakpoint
CREATE TYPE "public"."rule_action" AS ENUM('push', 'review', 'merge');--> statement-breakpoint
CREATE TYPE "public"."rule_effect" AS ENUM('allow', 'deny');--> statement-breakpoint
CREATE TYPE "public"."sandbox_status" AS ENUM('pending', 'running', 'finished', 'failed', 'killed');--> statement-breakpoint
CREATE TYPE "public"."sso_provider_kind" AS ENUM('oidc', 'saml');--> statement-breakpoint
CREATE TYPE "public"."vuln_severity" AS ENUM('low', 'medium', 'high', 'critical');--> statement-breakpoint
CREATE TABLE "agent_followers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"to_agent_id" uuid NOT NULL,
	"from_kind" "actor_kind" NOT NULL,
	"from_id" uuid NOT NULL,
	"change_id" uuid,
	"kind" varchar(40) DEFAULT 'feedback' NOT NULL,
	"body" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"read" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_quality_scores" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"merge_rate" integer DEFAULT 0 NOT NULL,
	"revert_rate" integer DEFAULT 0 NOT NULL,
	"time_to_green_ci_p50" integer DEFAULT 0 NOT NULL,
	"review_hit_rate" integer DEFAULT 0 NOT NULL,
	"drift_score" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_quality_scores_agent_id_unique" UNIQUE("agent_id")
);
--> statement-breakpoint
CREATE TABLE "agent_quotas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"push_per_hour" integer DEFAULT 60 NOT NULL,
	"review_per_hour" integer DEFAULT 120 NOT NULL,
	"api_per_hour" integer DEFAULT 1000 NOT NULL,
	"max_loc_per_change" integer DEFAULT 0 NOT NULL,
	"path_allowlist" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"path_denylist" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"risk_ceiling" "risk_level" DEFAULT 'critical' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_quotas_agent_id_unique" UNIQUE("agent_id")
);
--> statement-breakpoint
CREATE TABLE "agent_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"window" varchar(40) NOT NULL,
	"kind" varchar(20) NOT NULL,
	"count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"version" varchar(60) NOT NULL,
	"model_name" varchar(120),
	"prompt_hash" varchar(128),
	"notes" text,
	"trust_tier" varchar(20) DEFAULT 'untrusted' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(120) NOT NULL,
	"token_hash" varchar(255) NOT NULL,
	"claim_token" varchar(120),
	"associated_user_id" uuid,
	"git_author_name" varchar(120) NOT NULL,
	"git_author_email" varchar(255) NOT NULL,
	"capabilities" jsonb DEFAULT '{"push":true,"review":false}'::jsonb NOT NULL,
	"stats" jsonb DEFAULT '{"changesOpened":0,"reviewsSubmitted":0}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agents_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "attestations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repo_id" uuid NOT NULL,
	"change_id" uuid,
	"commit_sha" varchar(64) NOT NULL,
	"agent_id" uuid NOT NULL,
	"agent_version" varchar(60),
	"model_name" varchar(120),
	"model_version" varchar(120),
	"prompt_hash" varchar(128),
	"framework" varchar(120),
	"tools_used" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"tests_run" boolean DEFAULT false NOT NULL,
	"typechecked" boolean DEFAULT false NOT NULL,
	"signature" text,
	"signing_key_id" varchar(120),
	"extra" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repo_id" uuid,
	"actor_kind" "actor_kind" NOT NULL,
	"actor_id" uuid,
	"action" varchar(120) NOT NULL,
	"category" varchar(40) DEFAULT 'other' NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ip" varchar(64),
	"user_agent" varchar(500),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "branches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repo_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"head_commit" varchar(64) NOT NULL,
	"protection" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "changelog_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" varchar(500) NOT NULL,
	"body" text NOT NULL,
	"tag" varchar(100),
	"published_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repo_id" uuid NOT NULL,
	"branch" varchar(255) NOT NULL,
	"head_commit" varchar(64) NOT NULL,
	"intent" text NOT NULL,
	"risk" "risk_level" DEFAULT 'low' NOT NULL,
	"scope" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"review_focus" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"trailers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "change_status" DEFAULT 'pending' NOT NULL,
	"has_conflicts" boolean DEFAULT false NOT NULL,
	"escalated" boolean DEFAULT false NOT NULL,
	"escalation_reason" text,
	"opened_by_agent_id" uuid NOT NULL,
	"ci_status" "ci_status" DEFAULT 'pending' NOT NULL,
	"is_draft" boolean DEFAULT false NOT NULL,
	"auto_merge" jsonb,
	"requested_reviewers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"merged_at" timestamp with time zone,
	"merged_by" uuid,
	"merge_method" "merge_method",
	"merge_commit" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ci_artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"repo_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"content_type" varchar(200) DEFAULT 'application/octet-stream' NOT NULL,
	"size" integer DEFAULT 0 NOT NULL,
	"url" text NOT NULL,
	"checksum" varchar(128),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ci_pipelines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repo_id" uuid NOT NULL,
	"name" varchar(120) NOT NULL,
	"yaml" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ci_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repo_id" uuid NOT NULL,
	"change_id" uuid,
	"pipeline_id" uuid NOT NULL,
	"status" "ci_status" DEFAULT 'pending' NOT NULL,
	"runner_token" varchar(120) NOT NULL,
	"log_url" text,
	"step_results" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "code_index_shards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repo_id" uuid NOT NULL,
	"commit_sha" varchar(64) NOT NULL,
	"path" text NOT NULL,
	"trigrams" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cost_budgets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid,
	"org_id" uuid,
	"monthly_limit_cents" integer DEFAULT 0 NOT NULL,
	"hard_limit" boolean DEFAULT false NOT NULL,
	"alert_at_percent" integer DEFAULT 80 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cost_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"repo_id" uuid,
	"change_id" uuid,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cached_tokens" integer DEFAULT 0 NOT NULL,
	"cost_cents" integer DEFAULT 0 NOT NULL,
	"model" varchar(120),
	"kind" varchar(40) DEFAULT 'change' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cross_repo_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"change_id" uuid NOT NULL,
	"target_repo_id" uuid NOT NULL,
	"target_branch" varchar(255) NOT NULL,
	"status" varchar(20) DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cross_repo_proposals_change_id_unique" UNIQUE("change_id")
);
--> statement-breakpoint
CREATE TABLE "email_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"to_email" varchar(255) NOT NULL,
	"subject" varchar(500) NOT NULL,
	"body" text NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"sent_at" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "eval_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"suite_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"agent_version_id" uuid,
	"status" varchar(20) DEFAULT 'queued' NOT NULL,
	"score" integer,
	"results" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "eval_suites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(120) NOT NULL,
	"description" text,
	"cases" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"passing_threshold" integer DEFAULT 80 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "eval_suites_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "external_issue_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repo_id" uuid NOT NULL,
	"issue_id" uuid,
	"system" varchar(20) NOT NULL,
	"external_key" varchar(120) NOT NULL,
	"url" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feature_flags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repo_id" uuid,
	"key" varchar(120) NOT NULL,
	"description" text,
	"enabled" boolean DEFAULT false NOT NULL,
	"rollout_percent" integer DEFAULT 0 NOT NULL,
	"rules" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gdpr_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" varchar(20) NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"download_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "issue_comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"issue_id" uuid NOT NULL,
	"author_kind" "actor_kind" NOT NULL,
	"author_id" uuid NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "issue_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repo_id" uuid NOT NULL,
	"name" varchar(120) NOT NULL,
	"title" varchar(500) DEFAULT '' NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"labels" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "issues" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repo_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"title" varchar(500) NOT NULL,
	"body" text,
	"status" "issue_status" DEFAULT 'open' NOT NULL,
	"assigned_agent_id" uuid,
	"labels" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"milestone_id" uuid,
	"priority" varchar(20) DEFAULT 'normal' NOT NULL,
	"created_by_kind" "actor_kind" NOT NULL,
	"created_by_id" uuid NOT NULL,
	"closing_change_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kill_switches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"reason" text,
	"engaged_by" uuid,
	"engaged_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "kill_switches_agent_id_unique" UNIQUE("agent_id")
);
--> statement-breakpoint
CREATE TABLE "lfs_objects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repo_id" uuid NOT NULL,
	"oid" varchar(128) NOT NULL,
	"size" integer NOT NULL,
	"uploaded" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mentions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repo_id" uuid,
	"mentioned_kind" "actor_kind" NOT NULL,
	"mentioned_id" uuid NOT NULL,
	"source_kind" varchar(40) NOT NULL,
	"source_id" uuid NOT NULL,
	"author_kind" "actor_kind" NOT NULL,
	"author_id" uuid NOT NULL,
	"acknowledged" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "metrics_counters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(120) NOT NULL,
	"window" varchar(40) NOT NULL,
	"count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "milestones" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repo_id" uuid NOT NULL,
	"title" varchar(200) NOT NULL,
	"description" text,
	"due_date" timestamp with time zone,
	"status" varchar(20) DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_prefs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"email" boolean DEFAULT true NOT NULL,
	"email_on_mention" boolean DEFAULT true NOT NULL,
	"email_on_review_requested" boolean DEFAULT true NOT NULL,
	"email_on_change_merged" boolean DEFAULT true NOT NULL,
	"email_on_ci_failure" boolean DEFAULT true NOT NULL,
	"digest_frequency" varchar(20) DEFAULT 'never' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_prefs_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "org_agent_registry" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"trust_tier" varchar(20) DEFAULT 'sandbox' NOT NULL,
	"approved_by" uuid,
	"approved_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "org_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "org_role" DEFAULT 'member' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(120) NOT NULL,
	"display_name" varchar(200),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organizations_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "package_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"version_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"content_type" varchar(200) DEFAULT 'application/octet-stream' NOT NULL,
	"size" integer DEFAULT 0 NOT NULL,
	"shasum" varchar(128),
	"path" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "package_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"package_id" uuid NOT NULL,
	"version" varchar(120) NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "packages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repo_id" uuid NOT NULL,
	"kind" "package_kind" DEFAULT 'generic' NOT NULL,
	"name" varchar(255) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "permission_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repo_id" uuid NOT NULL,
	"path_glob" varchar(500) DEFAULT '**' NOT NULL,
	"actor_kind" "actor_kind" NOT NULL,
	"actor_id" uuid,
	"action" "rule_action" NOT NULL,
	"effect" "rule_effect" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "presence_heartbeats" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"change_id" uuid NOT NULL,
	"actor_kind" "actor_kind" NOT NULL,
	"actor_id" uuid NOT NULL,
	"last_seen" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "public_activity" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repo_id" uuid NOT NULL,
	"agent_id" uuid,
	"kind" varchar(40) NOT NULL,
	"change_id" uuid,
	"summary" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "release_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"release_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"content_type" varchar(200) DEFAULT 'application/octet-stream' NOT NULL,
	"size" integer DEFAULT 0 NOT NULL,
	"url" text NOT NULL,
	"checksum" varchar(128),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "releases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repo_id" uuid NOT NULL,
	"tag" varchar(255) NOT NULL,
	"title" varchar(500),
	"body" text,
	"change_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "repo_collaborators" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repo_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"role" "collaborator_role" DEFAULT 'writer' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "repo_stars" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repo_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "repo_watchers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repo_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "repositories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(120) NOT NULL,
	"namespace_type" "namespace_type" NOT NULL,
	"namespace_id" uuid NOT NULL,
	"description" text,
	"default_branch" varchar(120) DEFAULT 'main' NOT NULL,
	"is_public" boolean DEFAULT false NOT NULL,
	"topics" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"language" varchar(40),
	"stars_count" integer DEFAULT 0 NOT NULL,
	"watchers_count" integer DEFAULT 0 NOT NULL,
	"changes_count" integer DEFAULT 0 NOT NULL,
	"merged_this_week" integer DEFAULT 0 NOT NULL,
	"fork_of_repo_id" uuid,
	"merge_policy" jsonb DEFAULT '{"requireHumanApproval":"if_risk_at_least","requireHumanApprovalLevel":"high","minApprovalsTotal":1,"minApprovalsHuman":0,"allowSelfReview":false,"ciRequired":false,"pathOverrides":[],"trustedAgents":[],"allowedMergeMethods":["merge","squash","rebase"],"defaultMergeMethod":"merge"}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "review_comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"change_id" uuid NOT NULL,
	"thread_id" uuid NOT NULL,
	"parent_id" uuid,
	"path" varchar(500) NOT NULL,
	"line" integer NOT NULL,
	"side" varchar(8) DEFAULT 'new' NOT NULL,
	"body" text NOT NULL,
	"suggestion" text,
	"author_kind" "actor_kind" NOT NULL,
	"author_id" uuid NOT NULL,
	"resolved" boolean DEFAULT false NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"change_id" uuid NOT NULL,
	"reviewer_kind" "reviewer_kind" NOT NULL,
	"reviewer_id" uuid NOT NULL,
	"verdict" "review_verdict" NOT NULL,
	"summary" text,
	"additional_focus" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sandboxes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"repo_id" uuid NOT NULL,
	"ref" varchar(255),
	"image" varchar(255) DEFAULT 'node:20-slim' NOT NULL,
	"command" text NOT NULL,
	"status" "sandbox_status" DEFAULT 'pending' NOT NULL,
	"container_id" varchar(80),
	"stdout" text DEFAULT '' NOT NULL,
	"stderr" text DEFAULT '' NOT NULL,
	"exit_code" integer,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sast_findings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repo_id" uuid NOT NULL,
	"change_id" uuid,
	"rule_id" uuid NOT NULL,
	"path" varchar(500) NOT NULL,
	"line" integer NOT NULL,
	"excerpt" text,
	"severity" "vuln_severity" NOT NULL,
	"status" varchar(20) DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sast_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repo_id" uuid,
	"identifier" varchar(64) NOT NULL,
	"pattern" text NOT NULL,
	"flags" varchar(20) DEFAULT 'm' NOT NULL,
	"severity" "vuln_severity" DEFAULT 'medium' NOT NULL,
	"message" text NOT NULL,
	"languages" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sbom_exports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"release_id" uuid NOT NULL,
	"format" varchar(20) DEFAULT 'spdx-json' NOT NULL,
	"document" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "secrets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repo_id" uuid NOT NULL,
	"name" varchar(120) NOT NULL,
	"ciphertext" text NOT NULL,
	"nonce" varchar(120) NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "signing_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key_id" varchar(120) NOT NULL,
	"kind" varchar(20) DEFAULT 'ed25519' NOT NULL,
	"public_key" text NOT NULL,
	"private_key" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"rotated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "signing_keys_key_id_unique" UNIQUE("key_id")
);
--> statement-breakpoint
CREATE TABLE "sso_providers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"kind" "sso_provider_kind" NOT NULL,
	"name" varchar(120) NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sso_states" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"state" varchar(64) NOT NULL,
	"provider_id" uuid NOT NULL,
	"code_verifier" varchar(128),
	"redirect_to" varchar(500),
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "sso_states_state_unique" UNIQUE("state")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" varchar(255) NOT NULL,
	"name" varchar(120),
	"username" varchar(60),
	"avatar_url" text,
	"bio" text,
	"password_hash" varchar(255) NOT NULL,
	"totp_secret" varchar(120),
	"totp_enabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_username_unique" UNIQUE("username")
);
--> statement-breakpoint
CREATE TABLE "vuln_advisories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"identifier" varchar(64) NOT NULL,
	"ecosystem" varchar(40) NOT NULL,
	"package_name" varchar(255) NOT NULL,
	"vulnerable_range" varchar(255) NOT NULL,
	"patched_range" varchar(255),
	"severity" "vuln_severity" DEFAULT 'medium' NOT NULL,
	"summary" text NOT NULL,
	"url" text,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vuln_advisories_identifier_unique" UNIQUE("identifier")
);
--> statement-breakpoint
CREATE TABLE "vuln_findings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repo_id" uuid NOT NULL,
	"advisory_id" uuid NOT NULL,
	"manifest_path" varchar(500) NOT NULL,
	"installed_version" varchar(120) NOT NULL,
	"status" varchar(20) DEFAULT 'open' NOT NULL,
	"issue_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"webhook_id" uuid NOT NULL,
	"payload" jsonb NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"last_error" text,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "webhooks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repo_id" uuid NOT NULL,
	"url" text NOT NULL,
	"secret" varchar(255) NOT NULL,
	"events" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_followers" ADD CONSTRAINT "agent_followers_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_followers" ADD CONSTRAINT "agent_followers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_messages" ADD CONSTRAINT "agent_messages_to_agent_id_agents_id_fk" FOREIGN KEY ("to_agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_messages" ADD CONSTRAINT "agent_messages_change_id_changes_id_fk" FOREIGN KEY ("change_id") REFERENCES "public"."changes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_quality_scores" ADD CONSTRAINT "agent_quality_scores_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_quotas" ADD CONSTRAINT "agent_quotas_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_usage" ADD CONSTRAINT "agent_usage_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_versions" ADD CONSTRAINT "agent_versions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_associated_user_id_users_id_fk" FOREIGN KEY ("associated_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attestations" ADD CONSTRAINT "attestations_repo_id_repositories_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attestations" ADD CONSTRAINT "attestations_change_id_changes_id_fk" FOREIGN KEY ("change_id") REFERENCES "public"."changes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attestations" ADD CONSTRAINT "attestations_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_repo_id_repositories_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branches" ADD CONSTRAINT "branches_repo_id_repositories_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "changes" ADD CONSTRAINT "changes_repo_id_repositories_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "changes" ADD CONSTRAINT "changes_opened_by_agent_id_agents_id_fk" FOREIGN KEY ("opened_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ci_artifacts" ADD CONSTRAINT "ci_artifacts_run_id_ci_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."ci_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ci_artifacts" ADD CONSTRAINT "ci_artifacts_repo_id_repositories_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ci_pipelines" ADD CONSTRAINT "ci_pipelines_repo_id_repositories_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ci_runs" ADD CONSTRAINT "ci_runs_repo_id_repositories_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ci_runs" ADD CONSTRAINT "ci_runs_change_id_changes_id_fk" FOREIGN KEY ("change_id") REFERENCES "public"."changes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ci_runs" ADD CONSTRAINT "ci_runs_pipeline_id_ci_pipelines_id_fk" FOREIGN KEY ("pipeline_id") REFERENCES "public"."ci_pipelines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_index_shards" ADD CONSTRAINT "code_index_shards_repo_id_repositories_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_budgets" ADD CONSTRAINT "cost_budgets_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_budgets" ADD CONSTRAINT "cost_budgets_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_ledger" ADD CONSTRAINT "cost_ledger_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_ledger" ADD CONSTRAINT "cost_ledger_repo_id_repositories_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_ledger" ADD CONSTRAINT "cost_ledger_change_id_changes_id_fk" FOREIGN KEY ("change_id") REFERENCES "public"."changes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cross_repo_proposals" ADD CONSTRAINT "cross_repo_proposals_change_id_changes_id_fk" FOREIGN KEY ("change_id") REFERENCES "public"."changes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cross_repo_proposals" ADD CONSTRAINT "cross_repo_proposals_target_repo_id_repositories_id_fk" FOREIGN KEY ("target_repo_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_runs" ADD CONSTRAINT "eval_runs_suite_id_eval_suites_id_fk" FOREIGN KEY ("suite_id") REFERENCES "public"."eval_suites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_runs" ADD CONSTRAINT "eval_runs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_runs" ADD CONSTRAINT "eval_runs_agent_version_id_agent_versions_id_fk" FOREIGN KEY ("agent_version_id") REFERENCES "public"."agent_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_issue_links" ADD CONSTRAINT "external_issue_links_repo_id_repositories_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_issue_links" ADD CONSTRAINT "external_issue_links_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feature_flags" ADD CONSTRAINT "feature_flags_repo_id_repositories_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gdpr_requests" ADD CONSTRAINT "gdpr_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_comments" ADD CONSTRAINT "issue_comments_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_templates" ADD CONSTRAINT "issue_templates_repo_id_repositories_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_repo_id_repositories_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_assigned_agent_id_agents_id_fk" FOREIGN KEY ("assigned_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_closing_change_id_changes_id_fk" FOREIGN KEY ("closing_change_id") REFERENCES "public"."changes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kill_switches" ADD CONSTRAINT "kill_switches_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lfs_objects" ADD CONSTRAINT "lfs_objects_repo_id_repositories_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mentions" ADD CONSTRAINT "mentions_repo_id_repositories_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "milestones" ADD CONSTRAINT "milestones_repo_id_repositories_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_prefs" ADD CONSTRAINT "notification_prefs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_agent_registry" ADD CONSTRAINT "org_agent_registry_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_agent_registry" ADD CONSTRAINT "org_agent_registry_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_agent_registry" ADD CONSTRAINT "org_agent_registry_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_members" ADD CONSTRAINT "org_members_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_members" ADD CONSTRAINT "org_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_files" ADD CONSTRAINT "package_files_version_id_package_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."package_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_versions" ADD CONSTRAINT "package_versions_package_id_packages_id_fk" FOREIGN KEY ("package_id") REFERENCES "public"."packages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packages" ADD CONSTRAINT "packages_repo_id_repositories_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_rules" ADD CONSTRAINT "permission_rules_repo_id_repositories_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "presence_heartbeats" ADD CONSTRAINT "presence_heartbeats_change_id_changes_id_fk" FOREIGN KEY ("change_id") REFERENCES "public"."changes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "public_activity" ADD CONSTRAINT "public_activity_repo_id_repositories_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "public_activity" ADD CONSTRAINT "public_activity_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "public_activity" ADD CONSTRAINT "public_activity_change_id_changes_id_fk" FOREIGN KEY ("change_id") REFERENCES "public"."changes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "release_assets" ADD CONSTRAINT "release_assets_release_id_releases_id_fk" FOREIGN KEY ("release_id") REFERENCES "public"."releases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "releases" ADD CONSTRAINT "releases_repo_id_repositories_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "releases" ADD CONSTRAINT "releases_change_id_changes_id_fk" FOREIGN KEY ("change_id") REFERENCES "public"."changes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repo_collaborators" ADD CONSTRAINT "repo_collaborators_repo_id_repositories_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repo_collaborators" ADD CONSTRAINT "repo_collaborators_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repo_stars" ADD CONSTRAINT "repo_stars_repo_id_repositories_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repo_stars" ADD CONSTRAINT "repo_stars_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repo_watchers" ADD CONSTRAINT "repo_watchers_repo_id_repositories_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repo_watchers" ADD CONSTRAINT "repo_watchers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_comments" ADD CONSTRAINT "review_comments_change_id_changes_id_fk" FOREIGN KEY ("change_id") REFERENCES "public"."changes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_change_id_changes_id_fk" FOREIGN KEY ("change_id") REFERENCES "public"."changes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandboxes" ADD CONSTRAINT "sandboxes_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandboxes" ADD CONSTRAINT "sandboxes_repo_id_repositories_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sast_findings" ADD CONSTRAINT "sast_findings_repo_id_repositories_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sast_findings" ADD CONSTRAINT "sast_findings_change_id_changes_id_fk" FOREIGN KEY ("change_id") REFERENCES "public"."changes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sast_findings" ADD CONSTRAINT "sast_findings_rule_id_sast_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."sast_rules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sast_rules" ADD CONSTRAINT "sast_rules_repo_id_repositories_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sbom_exports" ADD CONSTRAINT "sbom_exports_release_id_releases_id_fk" FOREIGN KEY ("release_id") REFERENCES "public"."releases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secrets" ADD CONSTRAINT "secrets_repo_id_repositories_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secrets" ADD CONSTRAINT "secrets_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sso_providers" ADD CONSTRAINT "sso_providers_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sso_states" ADD CONSTRAINT "sso_states_provider_id_sso_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."sso_providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vuln_findings" ADD CONSTRAINT "vuln_findings_repo_id_repositories_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vuln_findings" ADD CONSTRAINT "vuln_findings_advisory_id_vuln_advisories_id_fk" FOREIGN KEY ("advisory_id") REFERENCES "public"."vuln_advisories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vuln_findings" ADD CONSTRAINT "vuln_findings_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_webhook_id_webhooks_id_fk" FOREIGN KEY ("webhook_id") REFERENCES "public"."webhooks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhooks" ADD CONSTRAINT "webhooks_repo_id_repositories_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_followers_uniq" ON "agent_followers" USING btree ("agent_id","user_id");--> statement-breakpoint
CREATE INDEX "agent_messages_to_idx" ON "agent_messages" USING btree ("to_agent_id","read");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_usage_uniq" ON "agent_usage" USING btree ("agent_id","window","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_versions_uniq" ON "agent_versions" USING btree ("agent_id","version");--> statement-breakpoint
CREATE INDEX "attestations_commit_idx" ON "attestations" USING btree ("commit_sha");--> statement-breakpoint
CREATE INDEX "attestations_agent_idx" ON "attestations" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "audit_repo_idx" ON "audit_events" USING btree ("repo_id");--> statement-breakpoint
CREATE INDEX "audit_created_idx" ON "audit_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "audit_action_idx" ON "audit_events" USING btree ("action");--> statement-breakpoint
CREATE UNIQUE INDEX "branches_uniq" ON "branches" USING btree ("repo_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "changes_repo_branch_uniq" ON "changes" USING btree ("repo_id","branch");--> statement-breakpoint
CREATE INDEX "changes_repo_idx" ON "changes" USING btree ("repo_id");--> statement-breakpoint
CREATE INDEX "ci_artifacts_run_idx" ON "ci_artifacts" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ci_pipelines_uniq" ON "ci_pipelines" USING btree ("repo_id","name");--> statement-breakpoint
CREATE INDEX "ci_runs_change_idx" ON "ci_runs" USING btree ("change_id");--> statement-breakpoint
CREATE UNIQUE INDEX "code_index_shards_uniq" ON "code_index_shards" USING btree ("repo_id","path");--> statement-breakpoint
CREATE INDEX "cost_ledger_agent_idx" ON "cost_ledger" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "cost_ledger_repo_idx" ON "cost_ledger" USING btree ("repo_id");--> statement-breakpoint
CREATE INDEX "cost_ledger_created_idx" ON "cost_ledger" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "email_outbox_status_idx" ON "email_outbox" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "external_issue_links_uniq" ON "external_issue_links" USING btree ("repo_id","system","external_key");--> statement-breakpoint
CREATE UNIQUE INDEX "feature_flags_uniq" ON "feature_flags" USING btree ("repo_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "issue_templates_uniq" ON "issue_templates" USING btree ("repo_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "issues_repo_num_uniq" ON "issues" USING btree ("repo_id","number");--> statement-breakpoint
CREATE INDEX "issues_status_idx" ON "issues" USING btree ("status");--> statement-breakpoint
CREATE INDEX "issues_milestone_idx" ON "issues" USING btree ("milestone_id");--> statement-breakpoint
CREATE UNIQUE INDEX "lfs_objects_uniq" ON "lfs_objects" USING btree ("repo_id","oid");--> statement-breakpoint
CREATE INDEX "mentions_target_idx" ON "mentions" USING btree ("mentioned_kind","mentioned_id");--> statement-breakpoint
CREATE UNIQUE INDEX "metrics_counters_uniq" ON "metrics_counters" USING btree ("name","window");--> statement-breakpoint
CREATE UNIQUE INDEX "milestones_repo_title_uniq" ON "milestones" USING btree ("repo_id","title");--> statement-breakpoint
CREATE UNIQUE INDEX "org_agent_registry_uniq" ON "org_agent_registry" USING btree ("org_id","agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "org_members_uniq" ON "org_members" USING btree ("org_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "package_files_uniq" ON "package_files" USING btree ("version_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "package_versions_uniq" ON "package_versions" USING btree ("package_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "packages_uniq" ON "packages" USING btree ("repo_id","kind","name");--> statement-breakpoint
CREATE UNIQUE INDEX "presence_uniq" ON "presence_heartbeats" USING btree ("change_id","actor_kind","actor_id");--> statement-breakpoint
CREATE INDEX "public_activity_created_idx" ON "public_activity" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "public_activity_repo_idx" ON "public_activity" USING btree ("repo_id");--> statement-breakpoint
CREATE INDEX "public_activity_agent_idx" ON "public_activity" USING btree ("agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "release_assets_uniq" ON "release_assets" USING btree ("release_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "releases_repo_tag_uniq" ON "releases" USING btree ("repo_id","tag");--> statement-breakpoint
CREATE UNIQUE INDEX "repo_collab_uniq" ON "repo_collaborators" USING btree ("repo_id","agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "repo_stars_uniq" ON "repo_stars" USING btree ("repo_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "repo_watchers_uniq" ON "repo_watchers" USING btree ("repo_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "repos_ns_name_uniq" ON "repositories" USING btree ("namespace_type","namespace_id","name");--> statement-breakpoint
CREATE INDEX "repos_stars_idx" ON "repositories" USING btree ("stars_count");--> statement-breakpoint
CREATE INDEX "review_comments_change_idx" ON "review_comments" USING btree ("change_id");--> statement-breakpoint
CREATE INDEX "review_comments_thread_idx" ON "review_comments" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX "reviews_change_idx" ON "reviews" USING btree ("change_id");--> statement-breakpoint
CREATE INDEX "sast_findings_change_idx" ON "sast_findings" USING btree ("change_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sast_rules_uniq" ON "sast_rules" USING btree ("repo_id","identifier");--> statement-breakpoint
CREATE UNIQUE INDEX "secrets_uniq" ON "secrets" USING btree ("repo_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "sso_providers_uniq" ON "sso_providers" USING btree ("org_id","name");--> statement-breakpoint
CREATE INDEX "vuln_advisories_pkg_idx" ON "vuln_advisories" USING btree ("ecosystem","package_name");--> statement-breakpoint
CREATE UNIQUE INDEX "vuln_findings_uniq" ON "vuln_findings" USING btree ("repo_id","advisory_id","manifest_path");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_status_idx" ON "webhook_deliveries" USING btree ("status","next_attempt_at");