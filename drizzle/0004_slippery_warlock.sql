ALTER TABLE `settings_channel` ADD `roundtrip_cap_override` integer;--> statement-breakpoint
ALTER TABLE `settings_global` ADD `roundtrip_cap_default` integer DEFAULT 5 NOT NULL;