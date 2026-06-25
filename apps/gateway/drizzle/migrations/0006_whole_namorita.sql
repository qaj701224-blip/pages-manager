CREATE TABLE `slack_agent_reply_messages` (
	`id` varchar(64) NOT NULL,
	`slack_session_id` varchar(64) NOT NULL,
	`agent_run_id` varchar(64) NOT NULL,
	`channel` varchar(255),
	`thread_ts` varchar(64),
	`message_ts` varchar(64),
	`text_snapshot` text,
	`last_sequence` int NOT NULL DEFAULT 0,
	`status` varchar(80) NOT NULL DEFAULT 'running',
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `slack_agent_reply_messages_id` PRIMARY KEY(`id`),
	CONSTRAINT `slack_agent_reply_messages_run_uk` UNIQUE(`agent_run_id`)
);
--> statement-breakpoint
CREATE INDEX `slack_agent_reply_messages_session_idx` ON `slack_agent_reply_messages` (`slack_session_id`,`updated_at`);--> statement-breakpoint
CREATE INDEX `slack_agent_reply_messages_channel_idx` ON `slack_agent_reply_messages` (`channel`,`message_ts`);