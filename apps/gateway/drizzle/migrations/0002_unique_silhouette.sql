CREATE TABLE `site_check_runs` (
	`id` varchar(64) NOT NULL,
	`repo_full_name` varchar(255) NOT NULL,
	`pr_number` int NOT NULL,
	`check_run_id` varchar(255),
	`check_run_node_id` varchar(255) NOT NULL,
	`check_name` varchar(255) NOT NULL,
	`app_slug` varchar(255),
	`app_name` varchar(255),
	`status` varchar(80),
	`conclusion` varchar(80),
	`head_sha` char(40),
	`details_url` varchar(1024),
	`html_url` varchar(1024),
	`output_summary` text,
	`first_seen_delivery_id` varchar(255),
	`last_seen_delivery_id` varchar(255),
	`completed_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `site_check_runs_id` PRIMARY KEY(`id`),
	CONSTRAINT `site_check_runs_node_uk` UNIQUE(`repo_full_name`,`check_run_node_id`)
);
--> statement-breakpoint
CREATE INDEX `site_check_runs_pr_idx` ON `site_check_runs` (`repo_full_name`,`pr_number`,`head_sha`);--> statement-breakpoint
CREATE INDEX `site_check_runs_status_idx` ON `site_check_runs` (`status`,`conclusion`,`updated_at`);