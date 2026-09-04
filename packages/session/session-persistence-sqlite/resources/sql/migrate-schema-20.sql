ALTER TABLE events ADD COLUMN ignorable INTEGER CHECK (ignorable IS NULL OR ignorable IN (0, 1));
UPDATE events SET ignorable = 0 WHERE is_packed = 1;
ALTER TABLE events DROP COLUMN is_packed;
