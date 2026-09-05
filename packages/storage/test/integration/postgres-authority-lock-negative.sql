CREATE TEMPORARY TABLE pg_locks (
  locktype text,
  pid integer,
  classid oid,
  objid oid,
  objsubid integer,
  mode text,
  granted boolean
);

INSERT INTO pg_locks VALUES (
  'advisory', pg_catalog.pg_backend_pid(), 1094929713::oid,
  1162237008::oid, 2, 'ExclusiveLock', true
);

DO $$
DECLARE
  denied boolean := false;
BEGIN
  BEGIN
    INSERT INTO acp.runtime_control_authorizations (
      authorization_id, scope_type, scope_id, action, authorized_by, reason,
      valid_from, expires_at, provenance_id
    ) VALUES (
      'rca_00000000-0000-4000-8000-000000000099', 'global', 'global',
      'unpause_effects', 'integration:test', 'Must require authority lock.',
      statement_timestamp(), statement_timestamp() + interval '1 minute',
      'prv_00000000-0000-4000-8000-000000000099'
    );
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM = 'effect authority mutation requires the transaction authority lock' THEN
      denied := true;
    ELSE
      RAISE;
    END IF;
  END;

  IF NOT denied THEN
    RAISE EXCEPTION 'authority mutation succeeded without the transaction lock';
  END IF;
END;
$$;

UPDATE acp.effect_proposals
SET state = 'previewed', updated_at = statement_timestamp()
WHERE effect_id = 'eff_00000000-0000-4000-8000-000000000900';

DO $$
DECLARE
  denied boolean := false;
BEGIN
  BEGIN
    UPDATE acp.effect_proposals
    SET state = 'authorized', updated_at = statement_timestamp()
    WHERE effect_id = 'eff_00000000-0000-4000-8000-000000000900';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM = 'effect authorization requires the transaction authority lock' THEN
      denied := true;
    ELSE
      RAISE;
    END IF;
  END;

  IF NOT denied THEN
    RAISE EXCEPTION 'effect authorization succeeded without the transaction lock';
  END IF;
END;
$$;
