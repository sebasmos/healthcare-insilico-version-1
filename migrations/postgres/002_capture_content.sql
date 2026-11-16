-- Free text a clinician chose to give while being recorded (think-aloud,
-- "why" answers, consented dictation). Kept out of the append-only log so it
-- can expire and be deleted. The text is stored encrypted.
CREATE TABLE capture_content (
  id         TEXT PRIMARY KEY,
  run_id     TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('think-aloud','why','dictation')),
  field      TEXT,
  about      TEXT,
  cipher     TEXT NOT NULL,
  length     INTEGER NOT NULL,
  redactions INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX idx_capture_content_run ON capture_content (run_id);
CREATE INDEX idx_capture_content_expiry ON capture_content (expires_at);
