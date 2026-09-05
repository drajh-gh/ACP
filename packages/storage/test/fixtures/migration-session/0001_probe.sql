CREATE SCHEMA acp;
CREATE TABLE acp.schema_migrations (
  version text PRIMARY KEY, name text NOT NULL,
  checksum_sha256 text NOT NULL, down_checksum_sha256 text NOT NULL
);
CREATE TABLE acp.migration_session_probe (value integer PRIMARY KEY);
INSERT INTO acp.migration_session_probe VALUES (1);
