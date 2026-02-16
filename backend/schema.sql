
-- appointments table
CREATE TABLE IF NOT EXISTS appointments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  serviceType TEXT,
  details TEXT,
  startTime TEXT,
  endTime TEXT,
  created_at TEXT
);
