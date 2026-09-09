ALTER TABLE users
ADD COLUMN availability TEXT NOT NULL DEFAULT 'offline',
ADD COLUMN latitude NUMERIC(9, 6),
ADD COLUMN longitude NUMERIC(9, 6),
ADD COLUMN location_updated_at TIMESTAMPTZ;

ALTER TABLE users
ADD CONSTRAINT users_driver_availability_check
CHECK (availability IN ('offline', 'available', 'busy')),
ADD CONSTRAINT users_latitude_check
CHECK (latitude IS NULL OR latitude BETWEEN -90 AND 90),
ADD CONSTRAINT users_longitude_check
CHECK (longitude IS NULL OR longitude BETWEEN -180 AND 180);