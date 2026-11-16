-- Whole-unit deletion (a study, a run, an agent with its runs, or all test data). The log stays append-only:
-- a row can be deleted only while the guard is open, and the guard is opened only inside the one transaction
-- that removes a whole unit (store.purge). Updates stay forbidden always.
CREATE TABLE purge_guard (id INTEGER PRIMARY KEY CHECK (id = 1), open INTEGER NOT NULL DEFAULT 0 CHECK (open IN (0, 1)));
INSERT INTO purge_guard (id, open) VALUES (1, 0);
CREATE OR REPLACE FUNCTION resource_versions_append_only() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND (SELECT open FROM purge_guard WHERE id = 1) = 1 THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'resource_versions is append-only';
END;
$$ LANGUAGE plpgsql;
