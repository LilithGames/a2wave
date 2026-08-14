CREATE TABLE "scm_workload_leases" (
	"id" text PRIMARY KEY NOT NULL,
	"workload_type" text NOT NULL,
	"workload_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"scm_source_id" text NOT NULL,
	"phase" text DEFAULT 'reserved' NOT NULL,
	"owner_instance_id" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "scm_workload_leases" ADD CONSTRAINT "scm_workload_leases_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scm_workload_leases" ADD CONSTRAINT "scm_workload_leases_scm_source_id_scm_sources_id_fk" FOREIGN KEY ("scm_source_id") REFERENCES "public"."scm_sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "scm_workload_leases_workload_unique" ON "scm_workload_leases" USING btree ("workload_type","workload_id");--> statement-breakpoint
CREATE INDEX "scm_workload_leases_agent_id_idx" ON "scm_workload_leases" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "scm_workload_leases_scm_source_id_idx" ON "scm_workload_leases" USING btree ("scm_source_id");