-- Private fresh-only admission prerequisite, not a native GO/launch capability.
-- Quiesce writers explicitly: never deadlock source-table DDL against their
-- plan/hold chain. Operators may retry only after incumbent writers finish.
LOCK TABLE acp.worktree_provisioner_processes,acp.worktree_provisioner_stops,
  acp.windows_native_root_claims IN ACCESS EXCLUSIVE MODE NOWAIT;

-- A semantic deferred cycle proves pair atomicity without transaction-ID or
-- xmin assumptions. Historical/standalone process rows remain permanently NULL.
ALTER TABLE acp.worktree_provisioner_processes ADD COLUMN admission_attempt_id acp.stable_id
  CHECK(admission_attempt_id IS NULL OR admission_attempt_id=attempt_id);
CREATE TABLE acp.worktree_provisioner_admissions (
  attempt_id acp.stable_id PRIMARY KEY REFERENCES acp.worktree_provisioner_processes(attempt_id),
  root_claim_owner_id acp.stable_id NOT NULL REFERENCES acp.windows_native_root_claims(owner_id),
  challenge_nonce text NOT NULL CHECK(length(challenge_nonce)=32 AND challenge_nonce ~ '^[0-9a-f]{32}$'),
  challenge_epoch integer NOT NULL CHECK(challenge_epoch=1),
  reservation_id acp.stable_id NOT NULL REFERENCES acp.worktree_reservations(reservation_id),
  reservation_revision integer NOT NULL CHECK(reservation_revision>0),
  deadline_at timestamptz NOT NULL CHECK(isfinite(deadline_at)),
  admitted_at timestamptz NOT NULL CHECK(isfinite(admitted_at)),
  duration_milliseconds integer NOT NULL CHECK(duration_milliseconds>250 AND duration_milliseconds<=20000),
  host_identifier text NOT NULL,
  owner_session_id acp.stable_id NOT NULL,
  application_version text NOT NULL,
  provenance_id acp.stable_id NOT NULL REFERENCES acp.runtime_provenance(provenance_id),
  FOREIGN KEY(host_identifier,owner_session_id,application_version) REFERENCES acp.worker_host_session_history(host_identifier,session_id,application_version),
  CHECK(root_claim_owner_id=attempt_id AND admitted_at<deadline_at)
);
ALTER TABLE acp.worktree_provisioner_processes ADD CONSTRAINT worktree_provisioner_process_admission_pair
  FOREIGN KEY(admission_attempt_id) REFERENCES acp.worktree_provisioner_admissions(attempt_id) DEFERRABLE INITIALLY DEFERRED;
CREATE TRIGGER worktree_provisioner_admissions_retained BEFORE UPDATE OR DELETE OR TRUNCATE ON acp.worktree_provisioner_admissions
FOR EACH STATEMENT EXECUTE FUNCTION acp.reject_immutable_mutation();

-- Preserve the exact existing1.0.0 journal payload despite the new internal
-- pairing column. Admission has its own separately versioned audit event.
CREATE OR REPLACE FUNCTION acp.audit_provisioner_journal() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p acp.worktree_provisioner_attempts; payload jsonb; event_kind text;
BEGIN
  SELECT * INTO STRICT p FROM acp.worktree_provisioner_attempts WHERE attempt_id=NEW.attempt_id;
  payload:=to_jsonb(NEW)-'admission_attempt_id'; event_kind:=CASE WHEN TG_TABLE_NAME='worktree_provisioner_processes' THEN 'filesystem.provisioner-process-recorded' ELSE 'filesystem.provisioner-stopped' END;
  INSERT INTO acp.mission_events(event_id,mission_id,event_type,event_version,idempotency_key,event_digest,payload,occurred_at,provenance_id)
    VALUES(('evt_'||gen_random_uuid())::acp.stable_id,p.mission_id,event_kind,'1.0.0',p.attempt_id::text,acp.jsonb_sha256(payload),payload,NEW.recorded_at,NEW.provenance_id);
  RETURN NEW;
END;
$$;

CREATE FUNCTION acp.provisioner_admission_source_valid(target_attempt acp.stable_id) RETURNS boolean LANGUAGE sql VOLATILE AS $$
  SELECT EXISTS(SELECT 1 FROM acp.worktree_provisioner_processes p JOIN acp.windows_native_root_claims c ON c.owner_id=p.attempt_id
    WHERE p.attempt_id=target_attempt AND p.admission_attempt_id=target_attempt AND c.owner_kind='provisioner'
      AND ROW(c.host_identifier,c.tree_identifier,c.process_id,c.process_start_token,c.supervision_scope)
        IS NOT DISTINCT FROM ROW(p.host_identifier,p.tree_identifier,p.root_process_id::bigint,p.root_process_start_token,p.supervision_scope))
    AND NOT EXISTS(SELECT 1 FROM acp.worktree_provisioner_stops WHERE attempt_id=target_attempt);
$$;
CREATE FUNCTION acp.validate_provisioner_admission() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p acp.worktree_provisioner_attempts;
BEGIN
  PERFORM acp.lock_provisioner_journal(NEW.attempt_id);
  SELECT * INTO STRICT p FROM acp.worktree_provisioner_attempts WHERE attempt_id=NEW.attempt_id;
  IF NOT acp.provisioner_admission_source_valid(NEW.attempt_id) THEN
    RAISE EXCEPTION 'admission requires a fresh same-transaction process and exact root claim without a stop';
  END IF;
  IF NOT acp.provisioner_journal_actor_valid(NEW.attempt_id,true) THEN
    RAISE EXCEPTION 'admission requires current original runtime and plan authority';
  END IF;
  NEW.root_claim_owner_id:=p.attempt_id;
  NEW.reservation_id:=p.reservation_id; NEW.reservation_revision:=p.reservation_revision;
  NEW.deadline_at:=p.deadline_at; NEW.admitted_at:=clock_timestamp();
  NEW.duration_milliseconds:=floor(extract(epoch FROM(NEW.deadline_at-NEW.admitted_at))*1000)::integer;
  NEW.host_identifier:=p.host_identifier; NEW.owner_session_id:=p.owner_session_id; NEW.application_version:=p.application_version; NEW.provenance_id:=p.provenance_id;
  RETURN NEW;
END;
$$;
CREATE TRIGGER worktree_provisioner_admissions_validate BEFORE INSERT ON acp.worktree_provisioner_admissions
FOR EACH ROW EXECUTE FUNCTION acp.validate_provisioner_admission();
-- The private producer owns BEGIN/COMMIT and never changes constraint timing.
-- As with0019, early SET CONSTRAINTS by another trusted SQL writer evaluates
-- these checks early; arbitrary SQL cannot be treated as fresh-ACK transport.
CREATE FUNCTION acp.require_provisioner_admission_commit_authority() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT acp.provisioner_journal_actor_valid(NEW.attempt_id,true) OR NOT acp.provisioner_admission_source_valid(NEW.attempt_id)
    OR NEW.deadline_at<=clock_timestamp()+interval '250 milliseconds' THEN
    RAISE EXCEPTION 'provisioner admission authority ended before commit';
  END IF;
  RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER worktree_provisioner_admissions_commit_authority AFTER INSERT ON acp.worktree_provisioner_admissions
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION acp.require_provisioner_admission_commit_authority();
CREATE FUNCTION acp.audit_provisioner_admission() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p acp.worktree_provisioner_attempts; payload jsonb;
BEGIN
  SELECT * INTO STRICT p FROM acp.worktree_provisioner_attempts WHERE attempt_id=NEW.attempt_id;
  payload:=to_jsonb(NEW);
  INSERT INTO acp.mission_events(event_id,mission_id,event_type,event_version,idempotency_key,event_digest,payload,occurred_at,provenance_id)
    VALUES(('evt_'||gen_random_uuid())::acp.stable_id,p.mission_id,'filesystem.provisioner-admitted','1.0.0',p.attempt_id::text,
      acp.jsonb_sha256(payload),payload,NEW.admitted_at,NEW.provenance_id);
  RETURN NEW;
END;
$$;
CREATE TRIGGER worktree_provisioner_admissions_audit AFTER INSERT ON acp.worktree_provisioner_admissions
FOR EACH ROW EXECUTE FUNCTION acp.audit_provisioner_admission();
