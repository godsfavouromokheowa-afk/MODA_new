-- Heal stale data (e.g. rows left behind by interrupted test runs) before
-- enforcing the invariant: keep only the newest active ride per driver.
UPDATE rides doomed
SET status = 'cancelled', completed_at = NOW()
FROM (
  SELECT id,
         ROW_NUMBER() OVER (PARTITION BY driver_id ORDER BY requested_at DESC, id DESC) AS rn
  FROM rides
  WHERE driver_id IS NOT NULL AND status IN ('accepted', 'in_progress')
) ranked
WHERE doomed.id = ranked.id AND ranked.rn > 1;

UPDATE users freed
SET availability = 'available'
WHERE freed.availability = 'busy'
  AND NOT EXISTS (
    SELECT 1 FROM rides active_rides
    WHERE active_rides.driver_id = freed.id
      AND active_rides.status IN ('accepted', 'in_progress')
  );

CREATE UNIQUE INDEX rides_one_active_per_driver
  ON rides (driver_id)
  WHERE status IN ('accepted', 'in_progress');
