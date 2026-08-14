ALTER TABLE "scm_workspace_removals" ALTER COLUMN "owner_instance_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "scm_workspace_removals" ADD COLUMN "attempt_started_at" timestamp with time zone;--> statement-breakpoint
UPDATE "scm_workspace_removals" SET "attempt_started_at" = "created_at" WHERE "attempt_started_at" IS NULL;--> statement-breakpoint
ALTER TABLE "scm_workspace_removals" ALTER COLUMN "attempt_started_at" SET NOT NULL;
