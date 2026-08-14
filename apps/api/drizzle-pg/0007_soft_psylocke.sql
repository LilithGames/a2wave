CREATE TABLE "scm_workspace_removals" (
	"id" text PRIMARY KEY NOT NULL,
	"scm_source_id" text NOT NULL,
	"workspace_name" text NOT NULL,
	"owner_instance_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "scm_workspace_removals" ADD CONSTRAINT "scm_workspace_removals_scm_source_id_scm_sources_id_fk" FOREIGN KEY ("scm_source_id") REFERENCES "public"."scm_sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "scm_workspace_removals_scm_source_id_idx" ON "scm_workspace_removals" USING btree ("scm_source_id");