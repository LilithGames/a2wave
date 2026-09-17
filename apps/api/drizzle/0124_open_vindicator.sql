ALTER TABLE `runs` ADD `conversation_id` text;--> statement-breakpoint
CREATE INDEX `runs_conversation_list_idx` ON `runs` (`initiator_agent_id`,`trigger_source`,`conversation_id`,`updated_at`,`id`);