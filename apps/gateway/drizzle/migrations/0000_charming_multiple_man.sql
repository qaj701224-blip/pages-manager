CREATE TABLE `agent_run_events` (
	`id` varchar(64) NOT NULL,
	`publishing_job_id` varchar(64),
	`slack_session_id` varchar(64),
	`agent_run_id` varchar(64),
	`type` varchar(80) NOT NULL,
	`stage` varchar(80),
	`text` text,
	`status` varchar(80),
	`dedupe_key` varchar(255),
	`slack_channel_id` varchar(255),
	`slack_thread_ts` varchar(64),
	`slack_message_ts` varchar(64),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `agent_run_events_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `agent_runs` (
	`id` varchar(64) NOT NULL,
	`agent_kind` varchar(80) NOT NULL,
	`slack_session_id` varchar(64),
	`publishing_job_id` varchar(64),
	`status` enum('running','completed','failed') NOT NULL,
	`round_no` int NOT NULL DEFAULT 1,
	`provider` varchar(80),
	`model` varchar(128),
	`model_api_style` varchar(80),
	`prompt_version` varchar(64),
	`policy_version` varchar(64),
	`input_summary_hash` char(64),
	`output_hash` char(64),
	`report_json` json,
	`error_code` varchar(128),
	`error_message` text,
	`lease_expires_at` datetime(3),
	`timeout_at` datetime(3),
	`started_at` datetime(3),
	`completed_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `agent_runs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `audit_logs` (
	`id` varchar(64) NOT NULL,
	`actor_type` varchar(80) NOT NULL,
	`actor_id` varchar(255) NOT NULL,
	`action` varchar(128) NOT NULL,
	`target_type` varchar(80) NOT NULL,
	`target_id` varchar(255) NOT NULL,
	`request_id` varchar(128),
	`metadata_json` json,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `audit_logs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `external_api_call_logs` (
	`id` varchar(64) NOT NULL,
	`provider` varchar(80) NOT NULL,
	`operation` varchar(128) NOT NULL,
	`publishing_job_id` varchar(64),
	`slack_session_id` varchar(64),
	`agent_run_id` varchar(64),
	`request_id` varchar(128),
	`status` varchar(80) NOT NULL,
	`error_code` varchar(128),
	`duration_ms` int,
	`request_summary_json` json,
	`response_summary_json` json,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `external_api_call_logs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `github_webhook_deliveries` (
	`id` varchar(64) NOT NULL,
	`repo_full_name` varchar(255) NOT NULL,
	`delivery_id` varchar(255) NOT NULL,
	`event_name` varchar(80) NOT NULL,
	`action` varchar(80),
	`status` varchar(80) NOT NULL DEFAULT 'received',
	`request_id` varchar(128),
	`payload_hash` char(64),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `github_webhook_deliveries_id` PRIMARY KEY(`id`),
	CONSTRAINT `github_webhook_deliveries_repo_delivery_uk` UNIQUE(`repo_full_name`,`delivery_id`)
);
--> statement-breakpoint
CREATE TABLE `issue_links` (
	`id` varchar(64) NOT NULL,
	`slack_session_id` varchar(64) NOT NULL,
	`publishing_job_id` varchar(64) NOT NULL,
	`issue_number` int,
	`pr_number` int,
	`branch_name` varchar(255),
	`preview_url` varchar(1024),
	`head_sha` char(40),
	`relationship` varchar(64) NOT NULL DEFAULT 'primary',
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `issue_links_id` PRIMARY KEY(`id`),
	CONSTRAINT `issue_links_job_uk` UNIQUE(`publishing_job_id`)
);
--> statement-breakpoint
CREATE TABLE `job_events` (
	`id` varchar(64) NOT NULL,
	`publishing_job_id` varchar(64) NOT NULL,
	`status` enum('received','summarizing','issue_creating','issue_created','indexing','generating_page','patch_generated','branch_committed','pr_created','reviewing','changes_requested','fixing','previewing','preview_deployed','approved','merging','merged','deploying','deployed','failed','cancelled') NOT NULL,
	`message` text,
	`request_id` varchar(128),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `job_events_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `publishing_jobs` (
	`id` varchar(64) NOT NULL,
	`source` enum('slack','api','admin','system') NOT NULL,
	`requested_by_type` varchar(64) NOT NULL,
	`requested_by_id` varchar(255) NOT NULL,
	`idempotency_key` varchar(255) NOT NULL,
	`site_project_id` varchar(64),
	`owner_scope_id` varchar(64),
	`employee_id` varchar(64),
	`employee_slug` varchar(80) NOT NULL,
	`site_slug` varchar(120) NOT NULL,
	`intent` varchar(80) NOT NULL,
	`approval_mode` varchar(64) NOT NULL,
	`status` enum('received','summarizing','issue_creating','issue_created','indexing','generating_page','patch_generated','branch_committed','pr_created','reviewing','changes_requested','fixing','previewing','preview_deployed','approved','merging','merged','deploying','deployed','failed','cancelled') NOT NULL,
	`title` varchar(255),
	`summary` text,
	`slack_thread_json` json,
	`slack_session_id` varchar(64),
	`slack_session_key` varchar(255),
	`issue_number` int,
	`issue_url` varchar(1024),
	`pr_number` int,
	`pr_url` varchar(1024),
	`branch_name` varchar(255),
	`base_ref` varchar(128),
	`head_sha` char(40),
	`index_snapshot_id` varchar(64),
	`preview_url` varchar(1024),
	`error_code` varchar(128),
	`error_message` text,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `publishing_jobs_id` PRIMARY KEY(`id`),
	CONSTRAINT `publishing_jobs_idempotency_uk` UNIQUE(`source`,`requested_by_type`,`requested_by_id`,`idempotency_key`)
);
--> statement-breakpoint
CREATE TABLE `review_agent_comments` (
	`id` varchar(64) NOT NULL,
	`repo_full_name` varchar(255) NOT NULL,
	`pr_number` int NOT NULL,
	`github_comment_node_id` varchar(255) NOT NULL,
	`source_type` varchar(80) NOT NULL,
	`review_agent_login` varchar(255),
	`classification` varchar(80),
	`status` varchar(80) NOT NULL DEFAULT 'open',
	`path` varchar(1024),
	`line` int,
	`body_redacted` text,
	`body_hash` char(64),
	`head_sha` char(40),
	`first_seen_delivery_id` varchar(255),
	`last_seen_delivery_id` varchar(255),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `review_agent_comments_id` PRIMARY KEY(`id`),
	CONSTRAINT `review_agent_comments_node_uk` UNIQUE(`repo_full_name`,`github_comment_node_id`)
);
--> statement-breakpoint
CREATE TABLE `session_memories` (
	`id` varchar(64) NOT NULL,
	`slack_session_id` varchar(64) NOT NULL,
	`summary` text,
	`requirements_json` json,
	`pending_questions_json` json,
	`preferences_json` json,
	`last_preview_feedback` text,
	`last_agent_response` text,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `session_memories_id` PRIMARY KEY(`id`),
	CONSTRAINT `session_memories_session_uk` UNIQUE(`slack_session_id`)
);
--> statement-breakpoint
CREATE TABLE `slack_events` (
	`id` varchar(64) NOT NULL,
	`team_id` varchar(255) NOT NULL,
	`event_id` varchar(255) NOT NULL,
	`event_type` varchar(80),
	`action` varchar(120),
	`processing_status` enum('received','processing','processed','ignored','failed') NOT NULL DEFAULT 'received',
	`result_type` enum('none','agent_replied','clarification_requested','job_created','followup_appended','status_returned','session_closed') NOT NULL DEFAULT 'none',
	`ignored_reason` varchar(255),
	`error_code` varchar(128),
	`error_message` text,
	`retry_num` int NOT NULL DEFAULT 0,
	`retry_reason` varchar(255),
	`request_id` varchar(128),
	`channel_id` varchar(255),
	`thread_ts` varchar(64),
	`slack_user_id` varchar(255),
	`slack_session_id` varchar(64),
	`publishing_job_id` varchar(64),
	`agent_run_id` varchar(64),
	`payload_redacted_json` json,
	`payload_hash` char(64),
	`received_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `slack_events_id` PRIMARY KEY(`id`),
	CONSTRAINT `slack_events_team_event_uk` UNIQUE(`team_id`,`event_id`)
);
--> statement-breakpoint
CREATE TABLE `slack_job_status_messages` (
	`job_id` varchar(64) NOT NULL,
	`channel` varchar(255),
	`thread_ts` varchar(64),
	`message_ts` varchar(64),
	`stage` varchar(80),
	`status` varchar(80),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `slack_job_status_messages_job_id` PRIMARY KEY(`job_id`)
);
--> statement-breakpoint
CREATE TABLE `slack_sessions` (
	`id` varchar(64) NOT NULL,
	`team_id` varchar(255) NOT NULL,
	`session_key` varchar(255) NOT NULL,
	`session_title` varchar(255),
	`channel_id` varchar(255),
	`thread_ts` varchar(64),
	`dm_channel_id` varchar(255),
	`surface_context_json` json,
	`primary_slack_user_id` varchar(255) NOT NULL,
	`owner_scope_id` varchar(64),
	`active_job_id` varchar(64),
	`active_issue_number` int,
	`active_pr_number` int,
	`active_preview_url` varchar(1024),
	`active_context_expires_at` datetime(3),
	`status` enum('active','closed','expired') NOT NULL DEFAULT 'active',
	`last_intent` varchar(80),
	`last_active_at` datetime(3),
	`closed_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `slack_sessions_id` PRIMARY KEY(`id`),
	CONSTRAINT `slack_sessions_scope_uk` UNIQUE(`team_id`,`primary_slack_user_id`,`session_key`)
);
--> statement-breakpoint
CREATE INDEX `agent_run_events_dedupe_idx` ON `agent_run_events` (`dedupe_key`);--> statement-breakpoint
CREATE INDEX `agent_run_events_job_idx` ON `agent_run_events` (`publishing_job_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `agent_run_events_run_idx` ON `agent_run_events` (`agent_run_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `agent_runs_job_idx` ON `agent_runs` (`publishing_job_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `agent_runs_session_idx` ON `agent_runs` (`slack_session_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `agent_runs_lease_idx` ON `agent_runs` (`agent_kind`,`status`,`lease_expires_at`);--> statement-breakpoint
CREATE INDEX `audit_logs_actor_idx` ON `audit_logs` (`actor_type`,`actor_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `audit_logs_target_idx` ON `audit_logs` (`target_type`,`target_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `external_api_call_logs_job_idx` ON `external_api_call_logs` (`publishing_job_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `external_api_call_logs_provider_idx` ON `external_api_call_logs` (`provider`,`operation`,`created_at`);--> statement-breakpoint
CREATE INDEX `github_webhook_deliveries_event_idx` ON `github_webhook_deliveries` (`event_name`,`created_at`);--> statement-breakpoint
CREATE INDEX `issue_links_session_idx` ON `issue_links` (`slack_session_id`,`updated_at`);--> statement-breakpoint
CREATE INDEX `issue_links_issue_idx` ON `issue_links` (`issue_number`);--> statement-breakpoint
CREATE INDEX `issue_links_pr_idx` ON `issue_links` (`pr_number`);--> statement-breakpoint
CREATE INDEX `job_events_job_created_idx` ON `job_events` (`publishing_job_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `job_events_status_created_idx` ON `job_events` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `publishing_jobs_status_updated_idx` ON `publishing_jobs` (`status`,`updated_at`);--> statement-breakpoint
CREATE INDEX `publishing_jobs_target_idx` ON `publishing_jobs` (`employee_slug`,`site_slug`);--> statement-breakpoint
CREATE INDEX `publishing_jobs_slack_session_idx` ON `publishing_jobs` (`slack_session_id`);--> statement-breakpoint
CREATE INDEX `publishing_jobs_issue_idx` ON `publishing_jobs` (`issue_number`);--> statement-breakpoint
CREATE INDEX `publishing_jobs_pr_idx` ON `publishing_jobs` (`pr_number`);--> statement-breakpoint
CREATE INDEX `review_agent_comments_pr_idx` ON `review_agent_comments` (`repo_full_name`,`pr_number`,`head_sha`);--> statement-breakpoint
CREATE INDEX `review_agent_comments_status_idx` ON `review_agent_comments` (`status`,`updated_at`);--> statement-breakpoint
CREATE INDEX `slack_events_processing_idx` ON `slack_events` (`processing_status`,`created_at`);--> statement-breakpoint
CREATE INDEX `slack_events_result_idx` ON `slack_events` (`result_type`,`created_at`);--> statement-breakpoint
CREATE INDEX `slack_events_session_idx` ON `slack_events` (`slack_session_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `slack_events_job_idx` ON `slack_events` (`publishing_job_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `slack_job_status_messages_channel_idx` ON `slack_job_status_messages` (`channel`,`message_ts`);--> statement-breakpoint
CREATE INDEX `slack_sessions_user_active_idx` ON `slack_sessions` (`team_id`,`primary_slack_user_id`,`last_active_at`);--> statement-breakpoint
CREATE INDEX `slack_sessions_active_job_idx` ON `slack_sessions` (`active_job_id`);