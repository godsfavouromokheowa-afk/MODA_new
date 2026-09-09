ALTER TABLE rides
ADD COLUMN pickup_latitude NUMERIC(9, 6),
ADD COLUMN pickup_longitude NUMERIC(9, 6);

ALTER TABLE rides
ADD CONSTRAINT rides_pickup_latitude_check
CHECK (pickup_latitude IS NULL OR pickup_latitude BETWEEN -90 AND 90),
ADD CONSTRAINT rides_pickup_longitude_check
CHECK (pickup_longitude IS NULL OR pickup_longitude BETWEEN -180 AND 180);