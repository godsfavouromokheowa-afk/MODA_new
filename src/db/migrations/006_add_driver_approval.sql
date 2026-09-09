ALTER TABLE users
ADD COLUMN driver_application_status TEXT NOT NULL DEFAULT 'not_applicable',
ADD COLUMN driver_application_submitted_at TIMESTAMPTZ,
ADD COLUMN driver_application_reviewed_at TIMESTAMPTZ;

ALTER TABLE users
ADD CONSTRAINT users_driver_application_status_check
CHECK (driver_application_status IN ('not_applicable', 'pending', 'approved', 'rejected'));