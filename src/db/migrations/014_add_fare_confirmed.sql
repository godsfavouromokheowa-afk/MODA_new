ALTER TABLE rides
ADD COLUMN fare_confirmed_by_rider BOOLEAN NOT NULL DEFAULT false;
