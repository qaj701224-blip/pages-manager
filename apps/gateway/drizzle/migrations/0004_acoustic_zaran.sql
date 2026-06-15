ALTER TABLE `issue_links` DROP INDEX `issue_links_job_uk`;--> statement-breakpoint
ALTER TABLE `slack_job_status_messages` DROP PRIMARY KEY;--> statement-breakpoint
ALTER TABLE `slack_job_status_messages` ADD `id` varchar(64) NULL FIRST;--> statement-breakpoint
UPDATE `slack_job_status_messages` SET `id` = CONCAT('slackmsg_', LEFT(SHA2(CONCAT(`job_id`, ':', COALESCE(`message_ts`, ''), ':', COALESCE(`thread_ts`, '')), 256), 16)) WHERE `id` IS NULL;--> statement-breakpoint
ALTER TABLE `slack_job_status_messages` MODIFY `id` varchar(64) NOT NULL;--> statement-breakpoint
ALTER TABLE `slack_job_status_messages` ADD PRIMARY KEY(`id`);--> statement-breakpoint
ALTER TABLE `slack_job_status_messages` ADD `slack_session_id` varchar(64);--> statement-breakpoint
ALTER TABLE `slack_job_status_messages` ADD `scope_key` varchar(255) DEFAULT 'job' NOT NULL;--> statement-breakpoint
ALTER TABLE `issue_links` ADD CONSTRAINT `issue_links_session_job_uk` UNIQUE(`slack_session_id`,`publishing_job_id`);--> statement-breakpoint
ALTER TABLE `slack_job_status_messages` ADD CONSTRAINT `slack_job_status_messages_job_scope_uk` UNIQUE(`job_id`,`scope_key`);--> statement-breakpoint
CREATE INDEX `issue_links_job_idx` ON `issue_links` (`publishing_job_id`,`updated_at`);--> statement-breakpoint
CREATE INDEX `slack_job_status_messages_job_idx` ON `slack_job_status_messages` (`job_id`,`updated_at`);--> statement-breakpoint
CREATE INDEX `slack_job_status_messages_session_idx` ON `slack_job_status_messages` (`slack_session_id`,`updated_at`);
