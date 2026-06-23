CREATE TABLE `platform_dev_items` (
	`id` varchar(64) NOT NULL,
	`source` enum('slack','api','admin','system') NOT NULL,
	`requested_by_type` varchar(64) NOT NULL,
	`requested_by_id` varchar(255) NOT NULL,
	`idempotency_key` varchar(255) NOT NULL,
	`title` varchar(255) NOT NULL,
	`summary` text,
	`issue_type` enum('type:dev','type:bug','type:docs','type:feedback','type:question','type:ci','type:ops','type:security') NOT NULL,
	`areas_json` json,
	`risk` enum('risk:low','risk:medium','risk:high') NOT NULL,
	`agent_eligible` boolean NOT NULL DEFAULT false,
	`requires_human_gate` boolean NOT NULL DEFAULT false,
	`status` enum('received','triaging','issue_creating','issue_created','gate_pending','agent_queued','agent_running','branch_committed','pr_created','ci_running','ci_failed','review_waiting','review_blocked','ready_to_merge','merged','closed_unmerged','failed','cancelled') NOT NULL,
	`requester_profile_json` json,
	`slack_thread_json` json,
	`slack_session_id` varchar(64),
	`slack_session_key` varchar(255),
	`github_issue_number` int,
	`github_issue_url` varchar(1024),
	`github_pr_number` int,
	`github_pr_url` varchar(1024),
	`branch_name` varchar(255),
	`base_ref` varchar(128),
	`head_sha` char(40),
	`gate_status` enum('not_required','pending','approved','rejected','expired') NOT NULL DEFAULT 'not_required',
	`gate_reason` text,
	`error_code` varchar(128),
	`error_message` text,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `platform_dev_items_id` PRIMARY KEY(`id`),
	CONSTRAINT `platform_dev_items_idempotency_uk` UNIQUE(`source`,`requested_by_type`,`requested_by_id`,`idempotency_key`)
);
--> statement-breakpoint
CREATE INDEX `platform_dev_items_status_updated_idx` ON `platform_dev_items` (`status`,`updated_at`);--> statement-breakpoint
CREATE INDEX `platform_dev_items_slack_session_idx` ON `platform_dev_items` (`slack_session_id`);--> statement-breakpoint
CREATE INDEX `platform_dev_items_issue_idx` ON `platform_dev_items` (`github_issue_number`);--> statement-breakpoint
CREATE INDEX `platform_dev_items_pr_idx` ON `platform_dev_items` (`github_pr_number`);--> statement-breakpoint
CREATE TABLE `platform_dev_events` (
	`id` varchar(64) NOT NULL,
	`platform_dev_item_id` varchar(64) NOT NULL,
	`status` enum('received','triaging','issue_creating','issue_created','gate_pending','agent_queued','agent_running','branch_committed','pr_created','ci_running','ci_failed','review_waiting','review_blocked','ready_to_merge','merged','closed_unmerged','failed','cancelled') NOT NULL,
	`message` text,
	`request_id` varchar(128),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `platform_dev_events_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `platform_dev_events_item_created_idx` ON `platform_dev_events` (`platform_dev_item_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `platform_dev_events_status_created_idx` ON `platform_dev_events` (`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `work_item_links` (
	`id` varchar(64) NOT NULL,
	`work_item_kind` enum('site_publishing','platform_dev') NOT NULL,
	`work_item_id` varchar(64) NOT NULL,
	`slack_session_id` varchar(64),
	`publishing_job_id` varchar(64),
	`platform_dev_item_id` varchar(64),
	`issue_number` int,
	`pr_number` int,
	`branch_name` varchar(255),
	`preview_url` varchar(1024),
	`head_sha` char(40),
	`relationship` varchar(64) NOT NULL DEFAULT 'primary',
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `work_item_links_id` PRIMARY KEY(`id`),
	CONSTRAINT `work_item_links_work_item_uk` UNIQUE(`work_item_kind`,`work_item_id`,`relationship`)
);
--> statement-breakpoint
CREATE INDEX `work_item_links_session_idx` ON `work_item_links` (`slack_session_id`,`updated_at`);--> statement-breakpoint
CREATE INDEX `work_item_links_issue_idx` ON `work_item_links` (`issue_number`);--> statement-breakpoint
CREATE INDEX `work_item_links_pr_idx` ON `work_item_links` (`pr_number`);--> statement-breakpoint
CREATE TABLE `work_item_gates` (
	`id` varchar(64) NOT NULL,
	`work_item_kind` enum('site_publishing','platform_dev') NOT NULL,
	`work_item_id` varchar(64) NOT NULL,
	`gate_type` enum('risk','ci_cd','ops','security','manual') NOT NULL,
	`status` enum('not_required','pending','approved','rejected','expired') NOT NULL DEFAULT 'pending',
	`reason` text,
	`decided_by` varchar(255),
	`decided_at` datetime(3),
	`metadata_json` json,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `work_item_gates_id` PRIMARY KEY(`id`),
	CONSTRAINT `work_item_gates_work_item_type_uk` UNIQUE(`work_item_kind`,`work_item_id`,`gate_type`)
);
--> statement-breakpoint
CREATE INDEX `work_item_gates_status_idx` ON `work_item_gates` (`status`,`updated_at`);--> statement-breakpoint
CREATE TABLE `work_item_followups` (
	`id` varchar(64) NOT NULL,
	`work_item_kind` enum('site_publishing','platform_dev') NOT NULL,
	`work_item_id` varchar(64) NOT NULL,
	`slack_session_id` varchar(64),
	`text` text NOT NULL,
	`status` enum('queued','applied','skipped','failed') NOT NULL DEFAULT 'queued',
	`metadata_json` json,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `work_item_followups_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `work_item_followups_work_item_idx` ON `work_item_followups` (`work_item_kind`,`work_item_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `work_item_followups_session_idx` ON `work_item_followups` (`slack_session_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `slack_work_item_status_messages` (
	`id` varchar(64) NOT NULL,
	`work_item_kind` enum('site_publishing','platform_dev') NOT NULL,
	`work_item_id` varchar(64) NOT NULL,
	`slack_session_id` varchar(64),
	`scope_key` varchar(255) NOT NULL DEFAULT 'work-item',
	`channel` varchar(255),
	`thread_ts` varchar(64),
	`message_ts` varchar(64),
	`stage` varchar(80),
	`status` varchar(80),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `slack_work_item_status_messages_id` PRIMARY KEY(`id`),
	CONSTRAINT `slack_work_item_status_messages_item_scope_uk` UNIQUE(`work_item_kind`,`work_item_id`,`scope_key`)
);
--> statement-breakpoint
CREATE INDEX `slack_work_item_status_messages_item_idx` ON `slack_work_item_status_messages` (`work_item_kind`,`work_item_id`,`updated_at`);--> statement-breakpoint
CREATE INDEX `slack_work_item_status_messages_session_idx` ON `slack_work_item_status_messages` (`slack_session_id`,`updated_at`);--> statement-breakpoint
ALTER TABLE `slack_events` ADD `work_item_kind` enum('site_publishing','platform_dev');--> statement-breakpoint
ALTER TABLE `slack_events` ADD `work_item_id` varchar(64);--> statement-breakpoint
ALTER TABLE `slack_events` ADD `platform_dev_item_id` varchar(64);--> statement-breakpoint
ALTER TABLE `slack_events` MODIFY COLUMN `result_type` enum('none','agent_replied','clarification_requested','job_created','platform_issue_created','platform_gate_pending','followup_appended','status_returned','session_closed') NOT NULL DEFAULT 'none';--> statement-breakpoint
CREATE INDEX `slack_events_work_item_idx` ON `slack_events` (`work_item_kind`,`work_item_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `slack_sessions` ADD `active_work_item_kind` enum('site_publishing','platform_dev');--> statement-breakpoint
ALTER TABLE `slack_sessions` ADD `active_work_item_id` varchar(64);--> statement-breakpoint
CREATE INDEX `slack_sessions_active_work_item_idx` ON `slack_sessions` (`active_work_item_kind`,`active_work_item_id`);--> statement-breakpoint
ALTER TABLE `agent_runs` ADD `work_item_kind` enum('site_publishing','platform_dev');--> statement-breakpoint
ALTER TABLE `agent_runs` ADD `work_item_id` varchar(64);--> statement-breakpoint
CREATE INDEX `agent_runs_work_item_idx` ON `agent_runs` (`work_item_kind`,`work_item_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `agent_run_events` ADD `work_item_kind` enum('site_publishing','platform_dev');--> statement-breakpoint
ALTER TABLE `agent_run_events` ADD `work_item_id` varchar(64);--> statement-breakpoint
CREATE INDEX `agent_run_events_work_item_idx` ON `agent_run_events` (`work_item_kind`,`work_item_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `slack_notification_dedupes` MODIFY `job_id` varchar(64);--> statement-breakpoint
ALTER TABLE `slack_notification_dedupes` ADD `work_item_kind` enum('site_publishing','platform_dev');--> statement-breakpoint
ALTER TABLE `slack_notification_dedupes` ADD `work_item_id` varchar(64);--> statement-breakpoint
CREATE UNIQUE INDEX `slack_notification_dedupes_work_item_key_uk` ON `slack_notification_dedupes` (`work_item_kind`,`work_item_id`,`dedupe_key`);--> statement-breakpoint
CREATE INDEX `slack_notification_dedupes_work_item_idx` ON `slack_notification_dedupes` (`work_item_kind`,`work_item_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `external_api_call_logs` ADD `work_item_kind` enum('site_publishing','platform_dev');--> statement-breakpoint
ALTER TABLE `external_api_call_logs` ADD `work_item_id` varchar(64);--> statement-breakpoint
CREATE INDEX `external_api_call_logs_work_item_idx` ON `external_api_call_logs` (`work_item_kind`,`work_item_id`,`created_at`);
