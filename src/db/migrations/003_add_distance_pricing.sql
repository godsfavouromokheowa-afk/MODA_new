ALTER TABLE rides
ADD COLUMN distance_km NUMERIC(8, 2),
ADD COLUMN price_per_km NUMERIC(10, 2),
ADD COLUMN currency CHAR(3) NOT NULL DEFAULT 'NGN';

ALTER TABLE rides
ADD CONSTRAINT rides_distance_km_check
CHECK (distance_km IS NULL OR distance_km > 0),
ADD CONSTRAINT rides_price_per_km_check
CHECK (price_per_km IS NULL OR price_per_km >= 0),
ADD CONSTRAINT rides_currency_check
CHECK (currency = 'NGN');