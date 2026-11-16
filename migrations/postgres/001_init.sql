CREATE TABLE branches (
  id            TEXT PRIMARY KEY,
  parent_branch TEXT REFERENCES branches(id),
  forked_at     TEXT,
  kind          TEXT NOT NULL CHECK (kind IN ('main','shadow','sandbox','rollout','redteam')),
  created_at    TEXT NOT NULL,
  dropped_at    TEXT,
  CHECK ((kind = 'main') = (parent_branch IS NULL)),
  CHECK ((kind = 'main') = (forked_at IS NULL))
);

INSERT INTO branches (id, parent_branch, forked_at, kind, created_at)
VALUES ('main', NULL, NULL, 'main', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));

CREATE TABLE resource_versions (
  seq           BIGSERIAL PRIMARY KEY,
  resource_type TEXT NOT NULL,
  id            TEXT NOT NULL,
  version_id    INTEGER NOT NULL CHECK (version_id >= 1),
  branch        TEXT NOT NULL REFERENCES branches(id),
  recorded_at   TEXT NOT NULL,
  valid_at      TEXT NOT NULL,
  patient       TEXT,
  group_key     TEXT,
  internal      INTEGER NOT NULL DEFAULT 0 CHECK (internal IN (0, 1)),
  body          JSONB NOT NULL,
  UNIQUE (resource_type, id, branch, version_id)
);

CREATE INDEX idx_rv_type_branch_id_time ON resource_versions (resource_type, branch, id, recorded_at);
CREATE INDEX idx_rv_patient ON resource_versions (patient, resource_type);
CREATE INDEX idx_rv_group ON resource_versions (resource_type, group_key);
CREATE INDEX idx_rv_time ON resource_versions (recorded_at);

CREATE FUNCTION resource_versions_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'resource_versions is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER resource_versions_no_update
BEFORE UPDATE OR DELETE ON resource_versions
FOR EACH ROW EXECUTE FUNCTION resource_versions_append_only();

CREATE TABLE idempotency_keys (
  scope      TEXT NOT NULL,
  key        TEXT NOT NULL,
  status     INTEGER NOT NULL,
  response   TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (scope, key)
);
