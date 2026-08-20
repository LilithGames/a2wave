DROP INDEX "runs_native_chat_event_unique";--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "qq_official_config" jsonb;--> statement-breakpoint
CREATE UNIQUE INDEX "runs_native_chat_event_unique" ON "runs" USING btree ("initiator_agent_id","trigger_source","trigger_event_id") WHERE trigger_source IN ('slack', 'discord', 'qq_official') AND trigger_event_id IS NOT NULL;