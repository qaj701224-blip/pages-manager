ALTER TABLE `platform_dev_items` ADD `auto_dev_status` enum('pending','triggered') DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE `platform_dev_items` ADD `auto_dev_triggered_by` varchar(255);--> statement-breakpoint
ALTER TABLE `platform_dev_items` ADD `auto_dev_triggered_at` datetime(3);--> statement-breakpoint
ALTER TABLE `platform_dev_items` ADD `auto_dev_reason` text;--> statement-breakpoint
ALTER TABLE `platform_dev_events` MODIFY COLUMN `status` enum('received','triaging','issue_creating','issue_created','gate_pending','auto_dev_pending','agent_queued','agent_running','branch_committed','pr_created','ci_running','ci_failed','review_waiting','review_blocked','ready_to_merge','merged','closed_unmerged','failed','cancelled') NOT NULL;--> statement-breakpoint
ALTER TABLE `platform_dev_items` MODIFY COLUMN `status` enum('received','triaging','issue_creating','issue_created','gate_pending','auto_dev_pending','agent_queued','agent_running','branch_committed','pr_created','ci_running','ci_failed','review_waiting','review_blocked','ready_to_merge','merged','closed_unmerged','failed','cancelled') NOT NULL;--> statement-breakpoint
ALTER TABLE `slack_events` MODIFY COLUMN `result_type` enum('none','agent_replied','clarification_requested','job_created','platform_issue_created','platform_gate_pending','platform_auto_dev_pending','followup_appended','status_returned','session_closed') NOT NULL DEFAULT 'none';--> statement-breakpoint
UPDATE `platform_dev_events` SET `status` = 'auto_dev_pending' WHERE `status` = 'gate_pending';--> statement-breakpoint
UPDATE `platform_dev_items` SET `status` = 'auto_dev_pending' WHERE `status` = 'gate_pending';--> statement-breakpoint
UPDATE `platform_dev_items` SET `status` = 'auto_dev_pending' WHERE `status` = 'issue_created' AND `auto_dev_status` = 'pending';--> statement-breakpoint
UPDATE `slack_events` SET `result_type` = 'platform_auto_dev_pending' WHERE `result_type` = 'platform_gate_pending';--> statement-breakpoint
ALTER TABLE `platform_dev_events` MODIFY COLUMN `status` enum('received','triaging','issue_creating','issue_created','auto_dev_pending','agent_queued','agent_running','branch_committed','pr_created','ci_running','ci_failed','review_waiting','review_blocked','ready_to_merge','merged','closed_unmerged','failed','cancelled') NOT NULL;--> statement-breakpoint
ALTER TABLE `platform_dev_items` MODIFY COLUMN `status` enum('received','triaging','issue_creating','issue_created','auto_dev_pending','agent_queued','agent_running','branch_committed','pr_created','ci_running','ci_failed','review_waiting','review_blocked','ready_to_merge','merged','closed_unmerged','failed','cancelled') NOT NULL;--> statement-breakpoint
ALTER TABLE `slack_events` MODIFY COLUMN `result_type` enum('none','agent_replied','clarification_requested','job_created','platform_issue_created','platform_auto_dev_pending','followup_appended','status_returned','session_closed') NOT NULL DEFAULT 'none';--> statement-breakpoint
ALTER TABLE `platform_dev_items` DROP COLUMN `requires_human_gate`;--> statement-breakpoint
ALTER TABLE `platform_dev_items` DROP COLUMN `gate_status`;--> statement-breakpoint
ALTER TABLE `platform_dev_items` DROP COLUMN `gate_reason`;--> statement-breakpoint
DROP TABLE IF EXISTS `work_item_gates`;
