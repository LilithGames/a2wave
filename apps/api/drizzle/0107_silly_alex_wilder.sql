ALTER TABLE `scm_sources` ADD `deletion_requested_by` text REFERENCES users(id) ON DELETE SET NULL;
