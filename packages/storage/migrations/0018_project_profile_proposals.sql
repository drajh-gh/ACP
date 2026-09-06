-- Inert review history, never human confirmation, publication or activation authority.
-- Transaction ownership belongs to the migration runner.
CREATE FUNCTION acp.profile_proposal_field_ids() RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY[
    'identity.project','identity.client','identity.stakeholders','identity.environments',
    'repositories.inventory','repositories.defaultBranches','repositories.developmentBranches','repositories.protections','repositories.owners',
    'tracker.adapterAndInstance','tracker.nativeStates','tracker.semanticMappings','tracker.itemTypes','tracker.transitionPolicy',
    'verification.tests','verification.linting','verification.builds','verification.ci','verification.reviewRules','verification.requiredGates',
    'deployment.paths','deployment.stagingAvailability','deployment.productionAuthority','deployment.verification','deployment.rollback',
    'context.product','context.business','context.scopeBoundaries','context.designDirection','context.personas','context.acceptanceMethods',
    'communications.channels','communications.externalRecipients','communications.internalRecipients','communications.messageApprovalRules',
    'knowledge.sources','knowledge.sourceAuthorityRules','knowledge.freshnessExpectations','knowledge.memoryDestinations',
    'data.sensitivity','data.restrictedSources','data.redaction','data.retention',
    'orchestration.workflowBindings','orchestration.schedules','orchestration.reconciliationSources','orchestration.cursorStrategies','orchestration.completionContracts',
    'attention.quietHours','attention.escalationRules','attention.failureThresholds','attention.unattendedLimits',
    'execution.hostRequirements','execution.browserRequirements','execution.concurrencyLimits',
    'credentials.references','credentials.readIdentities','credentials.writeIdentities',
    'revalidation.mutableTargets','revalidation.methods','compatibility.runtimeRequirements','compatibility.adapterRequirements'
  ]::text[]
$$;

-- SQL enforces complete closed envelopes and exact references. Fact-JSON domain semantics
-- are additionally enforced by the private producer before COMMIT and on every public read.
CREATE FUNCTION acp.profile_proposal_evidence_ids(fields jsonb) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE f jsonb; alternative jsonb; ids jsonb; all_ids jsonb:='[]'; status text; keys text[];
BEGIN
  IF jsonb_typeof(fields) IS DISTINCT FROM 'object' OR octet_length(fields::text)>524288
    OR (SELECT count(*) FROM jsonb_object_keys(fields))<>62 OR NOT fields ?& acp.profile_proposal_field_ids() THEN
    RAISE EXCEPTION 'profile proposal must address the exact bounded checklist'; END IF;
  FOR f IN SELECT value FROM jsonb_each(fields) LOOP
    IF jsonb_typeof(f) IS DISTINCT FROM 'object' OR jsonb_typeof(f->'status') IS DISTINCT FROM 'string' THEN
      RAISE EXCEPTION 'invalid profile field envelope'; END IF;
    status:=f->>'status';
    keys:=CASE status WHEN 'missing' THEN ARRAY['status','reason','question'] WHEN 'conflicted' THEN ARRAY['status','question','alternatives']
      WHEN 'observed' THEN ARRAY['status','value','evidenceIds'] WHEN 'proposed' THEN ARRAY['status','value','rationale','evidenceIds']
      WHEN 'not_applicable' THEN ARRAY['status','rationale','evidenceIds'] END;
    IF keys IS NULL OR NOT f ?& keys OR f-keys<>'{}'::jsonb THEN RAISE EXCEPTION 'invalid profile field envelope'; END IF;
    IF status IN ('missing','conflicted') AND (jsonb_typeof(f->'question') IS DISTINCT FROM 'string'
      OR NOT acp.readiness_canonical_text(f->>'question',2000)) THEN RAISE EXCEPTION 'invalid profile question'; END IF;
    IF status='missing' AND (jsonb_typeof(f->'reason') IS DISTINCT FROM 'string'
      OR NOT acp.readiness_canonical_text(f->>'reason',2000)) THEN RAISE EXCEPTION 'invalid profile missing reason'; END IF;
    IF status IN ('proposed','not_applicable') AND (jsonb_typeof(f->'rationale') IS DISTINCT FROM 'string'
      OR NOT acp.readiness_canonical_text(f->>'rationale',2000)) THEN RAISE EXCEPTION 'invalid profile rationale'; END IF;
    IF status='missing' THEN CONTINUE; END IF;
    IF status='conflicted' AND (jsonb_typeof(f->'alternatives') IS DISTINCT FROM 'array'
      OR jsonb_array_length(f->'alternatives') NOT BETWEEN 2 AND 5) THEN RAISE EXCEPTION 'invalid profile alternatives'; END IF;
    FOR alternative IN SELECT value FROM jsonb_array_elements(CASE WHEN status='conflicted' THEN f->'alternatives' ELSE jsonb_build_array(f) END) LOOP
      IF status='conflicted' AND (jsonb_typeof(alternative) IS DISTINCT FROM 'object' OR NOT alternative ?& ARRAY['value','evidenceIds']
        OR alternative-ARRAY['value','evidenceIds']<>'{}'::jsonb) THEN RAISE EXCEPTION 'invalid profile alternative envelope'; END IF;
      ids:=alternative->'evidenceIds';
      IF jsonb_typeof(ids) IS DISTINCT FROM 'array' OR jsonb_array_length(ids)>20
        OR (status IN ('observed','conflicted') AND jsonb_array_length(ids)=0)
        OR EXISTS(SELECT 1 FROM jsonb_array_elements(ids) i WHERE jsonb_typeof(i)<>'string') THEN RAISE EXCEPTION 'invalid profile evidence identifier set'; END IF;
      IF (SELECT count(DISTINCT id) FROM jsonb_array_elements_text(ids) i(id))<>jsonb_array_length(ids)
        OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(ids) i(id) WHERE id !~ '^evd_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') THEN
        RAISE EXCEPTION 'invalid profile evidence identifier set'; END IF;
      all_ids:=all_ids||ids;
    END LOOP;
  END LOOP;
  SELECT coalesce(jsonb_agg(id ORDER BY id),'[]'::jsonb) INTO all_ids FROM (SELECT DISTINCT id FROM jsonb_array_elements_text(all_ids) i(id)) ids;
  IF jsonb_array_length(all_ids)>1240 THEN RAISE EXCEPTION 'profile evidence set exceeds bound'; END IF;
  RETURN all_ids;
END;
$$;

CREATE TABLE acp.project_profile_proposals (
  proposal_id acp.stable_id PRIMARY KEY CHECK (proposal_id::text ~ '^pfp_'),
  project_id acp.stable_id NOT NULL REFERENCES acp.projects(project_id),
  profile_id acp.stable_id NOT NULL CHECK (profile_id::text ~ '^pro_'),
  profile_version acp.semantic_version NOT NULL CHECK (acp.readiness_canonical_text(profile_version,100)),
  base_profile_version acp.semantic_version CHECK (base_profile_version IS NULL OR acp.readiness_canonical_text(base_profile_version,100)),
  base_profile_digest text CHECK (base_profile_digest ~ '^sha256:[0-9a-f]{64}$'),
  supersedes_proposal_id acp.stable_id UNIQUE,
  producer jsonb NOT NULL, fields jsonb NOT NULL, scope_digest text NOT NULL,
  proposed_at timestamptz NOT NULL CHECK (isfinite(proposed_at) AND proposed_at>='0001-01-01T00:00:00Z' AND proposed_at<'10000-01-01T00:00:00Z'),
  evidence_pins jsonb NOT NULL CHECK (jsonb_typeof(evidence_pins)='array' AND jsonb_array_length(evidence_pins)<=1240),
  body jsonb NOT NULL CHECK (jsonb_typeof(body)='object' AND octet_length(body::text)<=524288),
  -- PG storage checksum, deliberately NOT the JS canonical proposal/confirmation digest.
  storage_digest text NOT NULL CHECK (storage_digest ~ '^sha256:[0-9a-f]{64}$'),
  FOREIGN KEY(project_id,profile_id,base_profile_version) REFERENCES acp.project_profiles(project_id,profile_id,version),
  CHECK ((base_profile_version IS NULL)=(base_profile_digest IS NULL)), CHECK (base_profile_version IS DISTINCT FROM profile_version),
  CHECK (supersedes_proposal_id IS DISTINCT FROM proposal_id),
  UNIQUE(proposal_id,scope_digest), UNIQUE(scope_digest,proposed_at),
  FOREIGN KEY(supersedes_proposal_id,scope_digest) REFERENCES acp.project_profile_proposals(proposal_id,scope_digest)
);
CREATE UNIQUE INDEX project_profile_proposals_single_root ON acp.project_profile_proposals(scope_digest) WHERE supersedes_proposal_id IS NULL;
CREATE INDEX project_profile_proposals_latest ON acp.project_profile_proposals(scope_digest,proposed_at DESC);
CREATE TRIGGER project_profile_proposals_retained BEFORE UPDATE OR DELETE OR TRUNCATE ON acp.project_profile_proposals
FOR EACH STATEMENT EXECUTE FUNCTION acp.reject_immutable_mutation();
CREATE TABLE acp.project_profile_proposal_evidence (
  proposal_id acp.stable_id NOT NULL REFERENCES acp.project_profile_proposals(proposal_id),
  evidence_id acp.stable_id NOT NULL REFERENCES acp.evidence_records(evidence_id),
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 1 AND 1240), identity_digest text NOT NULL CHECK (identity_digest ~ '^sha256:[0-9a-f]{64}$'),
  PRIMARY KEY(proposal_id,evidence_id), UNIQUE(proposal_id,ordinal)
);
CREATE TRIGGER project_profile_proposal_evidence_retained BEFORE UPDATE OR DELETE OR TRUNCATE ON acp.project_profile_proposal_evidence
FOR EACH STATEMENT EXECUTE FUNCTION acp.reject_immutable_mutation();

CREATE FUNCTION acp.validate_profile_proposal() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE ids jsonb; observed_evidence acp.evidence_records; previous acp.project_profile_proposals; observed timestamptz; state text; base_digest text;
BEGIN
  IF NEW.scope_digest IS NOT NULL OR NEW.proposed_at IS NOT NULL OR NEW.evidence_pins IS NOT NULL
    OR NEW.body IS NOT NULL OR NEW.storage_digest IS NOT NULL THEN RAISE EXCEPTION 'profile proposal derived fields are server owned'; END IF;
  IF jsonb_typeof(NEW.producer) IS DISTINCT FROM 'object' OR NOT NEW.producer ?& ARRAY['component','version','artifactDigest']
    OR NEW.producer-ARRAY['component','version','artifactDigest']<>'{}'::jsonb
    OR jsonb_typeof(NEW.producer->'component') IS DISTINCT FROM 'string' OR jsonb_typeof(NEW.producer->'version') IS DISTINCT FROM 'string'
    OR jsonb_typeof(NEW.producer->'artifactDigest') IS DISTINCT FROM 'string'
    OR NOT acp.readiness_canonical_text(NEW.producer->>'component',200) OR NOT acp.readiness_canonical_text(NEW.producer->>'version',200)
    OR NEW.producer->>'artifactDigest' !~ '^sha256:[0-9a-f]{64}$' THEN RAISE EXCEPTION 'invalid profile producer identity'; END IF;
  ids:=acp.profile_proposal_evidence_ids(NEW.fields);
  PERFORM 1 FROM acp.projects WHERE project_id=NEW.project_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'profile proposal requires an existing project'; END IF;
  IF NEW.base_profile_version IS NOT NULL THEN
    SELECT CASE WHEN octet_length(profile::text)<=524288 THEN acp.jsonb_sha256(profile) END INTO base_digest FROM acp.project_profiles
      WHERE (project_id,profile_id,version)=(NEW.project_id,NEW.profile_id,NEW.base_profile_version) FOR SHARE;
    IF base_digest IS NULL OR base_digest IS DISTINCT FROM NEW.base_profile_digest THEN RAISE EXCEPTION 'profile proposal baseline must match exact retained content'; END IF;
  END IF;
  NEW.evidence_pins:='[]';
  FOR observed_evidence IN SELECT e.* FROM acp.evidence_records e JOIN jsonb_array_elements_text(ids) i(id) ON e.evidence_id::text=i.id
    ORDER BY e.evidence_id FOR SHARE OF e LOOP
    IF observed_evidence.project_id<>NEW.project_id OR observed_evidence.sensitivity='restricted' OR acp.readiness_evidence_fingerprint(observed_evidence) IS NULL THEN
      RAISE EXCEPTION 'profile proposal contains invalid or undisclosable evidence'; END IF;
    NEW.evidence_pins:=NEW.evidence_pins||jsonb_build_array(jsonb_build_object('evidenceId',observed_evidence.evidence_id,'projectId',NEW.project_id,'identityDigest',acp.readiness_evidence_fingerprint(observed_evidence)));
  END LOOP;
  observed:=clock_timestamp();
  IF jsonb_array_length(NEW.evidence_pins)<>jsonb_array_length(ids)
    OR EXISTS(SELECT 1 FROM acp.evidence_records e JOIN jsonb_array_elements_text(ids) i(id) ON e.evidence_id::text=i.id
      WHERE e.observed_at>e.retrieved_at OR e.retrieved_at>observed) THEN RAISE EXCEPTION 'profile proposal contains invalid or undisclosable evidence'; END IF;
  NEW.scope_digest:=acp.jsonb_sha256(jsonb_build_array(NEW.project_id,NEW.profile_id,NEW.profile_version));
  PERFORM pg_advisory_xact_lock(hashtextextended('acp-profile-proposal:'||NEW.scope_digest,0));
  SELECT * INTO previous FROM acp.project_profile_proposals WHERE scope_digest=NEW.scope_digest
    AND (project_id,profile_id,profile_version)=(NEW.project_id,NEW.profile_id,NEW.profile_version) ORDER BY proposed_at DESC LIMIT 1 FOR UPDATE;
  NEW.proposed_at:=clock_timestamp();
  IF NEW.supersedes_proposal_id IS DISTINCT FROM previous.proposal_id OR (previous.proposal_id IS NOT NULL AND NEW.proposed_at<=previous.proposed_at) THEN
    RAISE EXCEPTION 'profile successor must name the exact latest proposal and a later instant'; END IF;
  -- Absence is an observation, not a reservation against legacy publication paths.
  IF EXISTS(SELECT 1 FROM acp.project_profiles WHERE (profile_id,version)=(NEW.profile_id,NEW.profile_version)) THEN
    RAISE EXCEPTION 'profile proposal candidate version already exists'; END IF;
  SELECT CASE WHEN bool_or(value->>'status'='conflicted') THEN 'conflicted' WHEN bool_or(value->>'status'='missing') THEN 'needs_input' ELSE 'reviewable' END
    INTO state FROM jsonb_each(NEW.fields);
  NEW.body:=jsonb_build_object('proposalId',NEW.proposal_id,'projectId',NEW.project_id,
    'candidateProfile',jsonb_build_object('profileId',NEW.profile_id,'profileVersion',NEW.profile_version),
    'baseProfile',CASE WHEN NEW.base_profile_version IS NOT NULL THEN jsonb_build_object('profileId',NEW.profile_id,'profileVersion',NEW.base_profile_version,'profileDigest',NEW.base_profile_digest) END,
    'supersedesProposalId',NEW.supersedes_proposal_id,'producer',NEW.producer,'proposedAt',acp.readiness_timestamp(NEW.proposed_at),
    'proposalSchemaVersion','1.0.0','fields',NEW.fields,'evidencePins',NEW.evidence_pins,'state',state,
    'authority',jsonb_build_object('assessment','not_evaluated','publication','not_authorized','activation','not_authorized'));
  NEW.storage_digest:=acp.jsonb_sha256(NEW.body);
  RETURN NEW;
END;
$$;
CREATE TRIGGER project_profile_proposals_validate BEFORE INSERT ON acp.project_profile_proposals
FOR EACH ROW EXECUTE FUNCTION acp.validate_profile_proposal();
CREATE FUNCTION acp.validate_profile_proposal_pin() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p acp.project_profile_proposals;
BEGIN
  SELECT * INTO STRICT p FROM acp.project_profile_proposals WHERE proposal_id=NEW.proposal_id;
  IF p.evidence_pins->(NEW.ordinal-1) IS DISTINCT FROM jsonb_build_object('evidenceId',NEW.evidence_id,'projectId',p.project_id,'identityDigest',NEW.identity_digest) THEN
    RAISE EXCEPTION 'profile evidence pin must match exact server-owned proposal pins'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER project_profile_proposal_evidence_validate BEFORE INSERT ON acp.project_profile_proposal_evidence
FOR EACH ROW EXECUTE FUNCTION acp.validate_profile_proposal_pin();
CREATE FUNCTION acp.insert_profile_proposal_pins() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO acp.project_profile_proposal_evidence(proposal_id,evidence_id,ordinal,identity_digest)
    SELECT NEW.proposal_id,(pin->>'evidenceId')::acp.stable_id,ordinal::integer,pin->>'identityDigest'
    FROM jsonb_array_elements(NEW.evidence_pins) WITH ORDINALITY i(pin,ordinal);
  RETURN NEW;
END;
$$;
CREATE TRIGGER project_profile_proposals_pin AFTER INSERT ON acp.project_profile_proposals
FOR EACH ROW EXECUTE FUNCTION acp.insert_profile_proposal_pins();
-- Private producer keeps constraints deferred; privileged SQL can force an early check.
-- Public reads independently recheck current disclosure and requests recheck identity.
CREATE FUNCTION acp.require_profile_proposal_commit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p acp.project_profile_proposals;
BEGIN
  SELECT * INTO STRICT p FROM acp.project_profile_proposals WHERE proposal_id=NEW.proposal_id;
  IF (SELECT count(*) FROM acp.project_profile_proposal_evidence WHERE proposal_id=p.proposal_id)<>jsonb_array_length(p.evidence_pins)
    OR EXISTS(SELECT 1 FROM acp.project_profile_proposal_evidence pin JOIN acp.evidence_records e USING(evidence_id)
      WHERE pin.proposal_id=p.proposal_id AND (e.project_id<>p.project_id OR e.sensitivity='restricted'
        OR e.observed_at>e.retrieved_at OR e.retrieved_at>clock_timestamp()
        OR pin.identity_digest IS DISTINCT FROM acp.readiness_evidence_fingerprint(e))) THEN
    RAISE EXCEPTION 'profile proposal evidence changed before commit'; END IF;
  RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER project_profile_proposals_commit AFTER INSERT ON acp.project_profile_proposals
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION acp.require_profile_proposal_commit();
