CREATE TABLE `settings_channel` (
	`channel_id` text PRIMARY KEY NOT NULL,
	`kb_budget_override` integer,
	`auto_approve` integer DEFAULT false NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `settings_global` (
	`id` integer PRIMARY KEY NOT NULL,
	`kb_budget_default` integer DEFAULT 200 NOT NULL,
	`show_groomed_default` integer DEFAULT false NOT NULL,
	`hide_system_messages_default` integer DEFAULT false NOT NULL,
	`default_channel_id` text,
	`theme` text DEFAULT 'system' NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
-- Seed the singleton row (ADR-0019). All column defaults are picked up;
-- only `id` and `updated_at` need explicit values. Unix epoch 0 is fine
-- as the seed timestamp — a real UPDATE on first user-side change will
-- overwrite it with Date.now().
INSERT INTO `settings_global` (`id`, `updated_at`) VALUES (1, 0);
