ALTER TABLE site_routes ADD COLUMN runtime_config_generation INTEGER NOT NULL DEFAULT 0;
ALTER TABLE site_routes ADD COLUMN runtime_config_lock_id TEXT;
