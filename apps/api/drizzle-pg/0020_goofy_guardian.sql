ALTER TABLE "run_steps" ADD COLUMN "wait_ms" bigint;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "queued_at" timestamp with time zone;