DROP INDEX `agent_run_events_dedupe_idx` ON `agent_run_events`;--> statement-breakpoint
ALTER TABLE `agent_run_events` ADD CONSTRAINT `agent_run_events_dedupe_uk` UNIQUE(`dedupe_key`);