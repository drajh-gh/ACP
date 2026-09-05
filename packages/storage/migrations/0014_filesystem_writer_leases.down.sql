-- Transaction ownership belongs to the migration runner.
LOCK TABLE acp.filesystem_writer_leases, acp.filesystem_writer_releases IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM acp.filesystem_writer_leases) THEN
    RAISE EXCEPTION '0014 downgrade would remove retained filesystem writer history';
  END IF;
END; $$;
DROP VIEW acp.filesystem_writer_lease_status;
DROP TABLE acp.filesystem_writer_releases;
DROP TABLE acp.filesystem_writer_leases;
DROP FUNCTION acp.audit_filesystem_writer();
DROP FUNCTION acp.require_filesystem_writer_commit_authority();
DROP FUNCTION acp.project_filesystem_writer_release();
DROP FUNCTION acp.validate_filesystem_writer_release();
DROP FUNCTION acp.make_filesystem_writer_release_provenance(acp.stable_id,text,acp.stable_id,text);
DROP FUNCTION acp.filesystem_writer_release_valid(acp.stable_id,acp.stable_id,text,acp.stable_id,text);
DROP FUNCTION acp.validate_filesystem_writer_lease();
DROP FUNCTION acp.filesystem_writer_owner_valid(acp.stable_id,acp.stable_id);
DROP FUNCTION acp.lock_filesystem_writer(acp.stable_id,acp.stable_id);
