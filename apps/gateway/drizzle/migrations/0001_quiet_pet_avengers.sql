CREATE TABLE `slack_notification_dedupes` (
	`id` varchar(64) NOT NULL,
	`job_id` varchar(64) NOT NULL,
	`dedupe_key` varchar(255) NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `slack_notification_dedupes_id` PRIMARY KEY(`id`),
	CONSTRAINT `slack_notification_dedupes_job_key_uk` UNIQUE(`job_id`,`dedupe_key`)
);
--> statement-breakpoint
CREATE INDEX `slack_notification_dedupes_job_idx` ON `slack_notification_dedupes` (`job_id`,`created_at`);