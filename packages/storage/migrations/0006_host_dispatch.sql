-- Transaction ownership belongs to the migration runner.
-- Cancellation is an intent before it is a terminal projection. A live OS
-- process must be stopped before the existing terminal-state guards can pass.
CREATE FUNCTION acp.validate_worker_cancellation_intent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.event_type <> 'mission.cancellation-requested' THEN RETURN NEW; END IF;
  PERFORM 1 FROM acp.missions WHERE mission_id = NEW.mission_id FOR UPDATE;
  IF NOT EXISTS (SELECT 1 FROM acp.mission_workflow_runs r WHERE r.mission_id = NEW.mission_id
    AND r.workflow_execution_id::text = NEW.payload ->> 'workflowExecutionId'
    AND r.dbos_workflow_id = NEW.payload ->> 'dbosWorkflowId'
    AND r.workflow_version::text = NEW.payload ->> 'workflowVersion'
    AND r.graph_revision = NEW.payload ->> 'graphRevision' AND r.provenance_id = NEW.provenance_id)
    OR nullif(btrim(NEW.payload ->> 'reason'), '') IS NULL
    OR nullif(btrim(NEW.payload ->> 'requestedBy'), '') IS NULL THEN
    RAISE EXCEPTION 'cancellation intent must match its exact workflow control target';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER mission_events_validate_worker_cancellation BEFORE INSERT ON acp.mission_events
FOR EACH ROW EXECUTE FUNCTION acp.validate_worker_cancellation_intent();
CREATE FUNCTION acp.worker_cancellation_requested(mission acp.stable_id, graph text) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM acp.mission_events e JOIN acp.mission_workflow_runs r
    ON r.mission_id = e.mission_id AND r.workflow_execution_id::text = e.payload ->> 'workflowExecutionId'
      AND r.dbos_workflow_id = e.payload ->> 'dbosWorkflowId'
      AND r.workflow_version::text = e.payload ->> 'workflowVersion'
      AND r.graph_revision = e.payload ->> 'graphRevision' AND r.provenance_id = e.provenance_id
    WHERE e.mission_id = mission AND r.graph_revision = graph AND e.event_type = 'mission.cancellation-requested');
$$;
CREATE TABLE acp.worker_host_session_history (
  session_id acp.stable_id PRIMARY KEY CHECK (left(session_id, 4) = 'whs_'),
  host_identifier text NOT NULL REFERENCES acp.worker_hosts (host_identifier),
  application_version text NOT NULL CHECK (length(btrim(application_version)) > 0),
  issued_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (host_identifier, session_id, application_version)
);
CREATE TRIGGER worker_host_session_history_immutable BEFORE UPDATE OR DELETE ON acp.worker_host_session_history
FOR EACH ROW EXECUTE FUNCTION acp.reject_immutable_mutation();
CREATE TABLE acp.worker_host_sessions (
  host_identifier text PRIMARY KEY REFERENCES acp.worker_hosts (host_identifier),
  session_id acp.stable_id NOT NULL CHECK (left(session_id, 4) = 'whs_'),
  application_version text NOT NULL CHECK (length(btrim(application_version)) > 0),
  state text NOT NULL CHECK (state IN ('active', 'closed')),
  heartbeat_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  FOREIGN KEY (host_identifier, session_id, application_version)
    REFERENCES acp.worker_host_session_history (host_identifier, session_id, application_version)
);
CREATE FUNCTION acp.validate_host_session() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'host session heads cannot be deleted'; END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.host_identifier <> OLD.host_identifier
       OR (NEW.session_id = OLD.session_id AND (NEW.application_version <> OLD.application_version OR OLD.state = 'closed'))
       OR (NEW.session_id <> OLD.session_id AND OLD.state = 'active' AND EXISTS (
         SELECT 1 FROM acp.worker_hosts h WHERE h.host_identifier = OLD.host_identifier
         AND OLD.heartbeat_at + make_interval(secs => h.heartbeat_ttl_seconds) > statement_timestamp())) THEN
      RAISE EXCEPTION 'host session identity is fenced until closed or expired';
    END IF;
  END IF;
  IF TG_OP = 'INSERT' OR NEW.session_id <> OLD.session_id THEN
    IF EXISTS (SELECT 1 FROM acp.worker_host_session_history WHERE session_id = NEW.session_id) THEN
      RAISE EXCEPTION 'historical host session identity cannot be reused';
    END IF;
    INSERT INTO acp.worker_host_session_history (session_id, host_identifier, application_version)
      VALUES (NEW.session_id, NEW.host_identifier, NEW.application_version);
  END IF;
  NEW.heartbeat_at := statement_timestamp();
  RETURN NEW;
END;
$$;
CREATE TRIGGER worker_host_sessions_validate BEFORE INSERT OR UPDATE OR DELETE ON acp.worker_host_sessions
FOR EACH ROW EXECUTE FUNCTION acp.validate_host_session();
CREATE TABLE acp.worker_host_runtimes (
  host_identifier text NOT NULL REFERENCES acp.worker_hosts (host_identifier),
  application_version text NOT NULL CHECK (length(btrim(application_version)) > 0),
  session_id acp.stable_id NOT NULL CHECK (left(session_id, 4) = 'whs_'),
  workflow_binding_id acp.stable_id NOT NULL REFERENCES acp.project_workflow_bindings (binding_id),
  template_provenance_id acp.stable_id NOT NULL REFERENCES acp.runtime_provenance (provenance_id),
  heartbeat_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (host_identifier, application_version, workflow_binding_id, session_id)
);
CREATE FUNCTION acp.validate_host_runtime() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR (TG_OP = 'UPDATE' AND
     to_jsonb(NEW) - 'heartbeat_at' IS DISTINCT FROM to_jsonb(OLD) - 'heartbeat_at') THEN
    RAISE EXCEPTION 'host runtime identity is immutable';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM acp.runtime_provenance p WHERE p.provenance_id = NEW.template_provenance_id
    AND p.host_identifier = NEW.host_identifier AND p.workflow_binding_id = NEW.workflow_binding_id) THEN
    RAISE EXCEPTION 'host runtime template must match its host and binding';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM acp.worker_host_sessions s WHERE s.host_identifier = NEW.host_identifier
    AND s.session_id = NEW.session_id AND s.application_version = NEW.application_version AND s.state = 'active') THEN
    RAISE EXCEPTION 'host runtime requires its current session';
  END IF;
  NEW.heartbeat_at := statement_timestamp();
  RETURN NEW;
END;
$$;
CREATE TRIGGER worker_host_runtimes_validate BEFORE INSERT OR UPDATE OR DELETE ON acp.worker_host_runtimes
FOR EACH ROW EXECUTE FUNCTION acp.validate_host_runtime();

CREATE TABLE acp.worker_dispatches (
  run_id acp.stable_id PRIMARY KEY CHECK (left(run_id, 4) = 'run_'),
  mission_id acp.stable_id NOT NULL,
  node_id acp.stable_id NOT NULL,
  grant_id acp.stable_id NOT NULL,
  attempt_number integer NOT NULL CHECK (attempt_number > 0),
  application_version text NOT NULL CHECK (length(btrim(application_version)) > 0),
  operation text NOT NULL CHECK (length(btrim(operation)) > 0),
  resource text NOT NULL CHECK (length(btrim(resource)) > 0),
  preferred_host_identifier text REFERENCES acp.worker_hosts (host_identifier),
  request_digest text NOT NULL CHECK (request_digest ~ '^sha256:[0-9a-f]{64}$'),
  provenance_id acp.stable_id NOT NULL REFERENCES acp.runtime_provenance (provenance_id),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'assigned', 'running', 'completed', 'cancelled', 'blocked')),
  generation integer NOT NULL DEFAULT 0 CHECK (generation >= 0),
  reason text,
  next_assignment_attempt_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  FOREIGN KEY (grant_id, mission_id, node_id) REFERENCES acp.capability_grants (grant_id, mission_id, node_id),
  UNIQUE (run_id, mission_id, node_id)
);
CREATE UNIQUE INDEX worker_dispatches_one_live_node ON acp.worker_dispatches (node_id)
WHERE state IN ('pending', 'assigned', 'running');
CREATE INDEX worker_dispatches_pending ON acp.worker_dispatches (next_assignment_attempt_at, created_at, run_id)
WHERE state IN ('pending', 'assigned');

CREATE FUNCTION acp.host_worker_queue(host text, resource_class text, session text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT 'acp-worker-v1:' || encode(sha256(convert_to(host, 'UTF8')), 'hex') || ':' || session || ':' || resource_class;
$$;
CREATE FUNCTION acp.worker_host_capacity(host acp.worker_hosts, resource_class text) RETURNS integer LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE resource_class WHEN 'cpu_intensive' THEN (host).maximum_cpu_intensive
    WHEN 'moderate_compute' THEN (host).maximum_moderate_compute
    WHEN 'lightweight_read' THEN (host).maximum_lightweight_read
    WHEN 'network_bound' THEN (host).maximum_network_bound ELSE 0 END;
$$;

CREATE TABLE acp.worker_dispatch_assignments (
  run_id acp.stable_id NOT NULL REFERENCES acp.worker_dispatches (run_id),
  generation integer NOT NULL CHECK (generation > 0),
  host_identifier text NOT NULL REFERENCES acp.worker_hosts (host_identifier),
  host_session_id acp.stable_id NOT NULL CHECK (left(host_session_id, 4) = 'whs_'),
  template_provenance_id acp.stable_id NOT NULL REFERENCES acp.runtime_provenance (provenance_id),
  context_packet_id acp.stable_id NOT NULL UNIQUE CHECK (left(context_packet_id, 4) = 'ctx_'),
  packet_provenance_id acp.stable_id NOT NULL UNIQUE CHECK (left(packet_provenance_id, 4) = 'prv_'),
  queue_name text NOT NULL,
  workflow_id text NOT NULL UNIQUE,
  assigned_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (run_id, generation),
  CHECK (expires_at > assigned_at AND expires_at <= assigned_at + interval '5 minutes')
);
CREATE TRIGGER worker_dispatch_assignments_are_immutable BEFORE UPDATE OR DELETE ON acp.worker_dispatch_assignments
FOR EACH ROW EXECUTE FUNCTION acp.reject_immutable_mutation();

CREATE FUNCTION acp.worker_host_load(host text, class text) RETURNS bigint LANGUAGE sql STABLE AS $$
  SELECT (SELECT count(*) FROM acp.worker_runs WHERE host_identifier = host AND resource_class = class AND state = 'started')
    + (SELECT count(*) FROM acp.worker_dispatches d
       JOIN acp.worker_dispatch_assignments a ON a.run_id = d.run_id AND a.generation = d.generation
       JOIN acp.capability_grants g ON g.grant_id = d.grant_id
       WHERE a.host_identifier = host AND g.resource_class = class AND d.state = 'assigned');
$$;

CREATE FUNCTION acp.validate_dispatch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'worker dispatches cannot be deleted'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'pending' OR NEW.generation <> 0 OR NEW.reason IS NOT NULL
       OR NOT acp.runtime_provenance_matches_context(NEW.provenance_id, NEW.mission_id)
       OR NEW.request_digest <> acp.jsonb_sha256(jsonb_build_object(
         'runId', NEW.run_id, 'missionId', NEW.mission_id, 'nodeId', NEW.node_id,
         'grantId', NEW.grant_id, 'attemptNumber', NEW.attempt_number,
         'applicationVersion', NEW.application_version, 'operation', NEW.operation,
         'resource', NEW.resource, 'preferredHostIdentifier', NEW.preferred_host_identifier,
         'provenanceId', NEW.provenance_id)) THEN
      RAISE EXCEPTION 'worker dispatch requires exact immutable request identity';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM acp.capability_grants g WHERE g.grant_id = NEW.grant_id
      AND g.allowed_operations ? NEW.operation AND g.allowed_resources ? NEW.resource) THEN
      RAISE EXCEPTION 'worker dispatch exceeds its grant';
    END IF;
    NEW.created_at := statement_timestamp();
  ELSE
    IF (to_jsonb(NEW) - ARRAY['state', 'generation', 'reason', 'updated_at', 'next_assignment_attempt_at']) IS DISTINCT FROM
       (to_jsonb(OLD) - ARRAY['state', 'generation', 'reason', 'updated_at', 'next_assignment_attempt_at'])
       OR OLD.state IN ('completed', 'cancelled', 'blocked') THEN
      RAISE EXCEPTION 'worker dispatch request or terminal outcome is immutable';
    END IF;
    IF NEW.state = OLD.state AND NEW.generation = OLD.generation AND NEW.reason IS NOT DISTINCT FROM OLD.reason THEN
      IF NEW.next_assignment_attempt_at <= statement_timestamp()
         OR NEW.next_assignment_attempt_at > statement_timestamp() + interval '1 minute' THEN
        RAISE EXCEPTION 'dispatch retry scheduling must be bounded';
      END IF;
      NEW.updated_at := statement_timestamp();
      RETURN NEW;
    END IF;
    IF NEW.state = 'assigned' THEN
      IF OLD.state NOT IN ('pending', 'assigned') OR NEW.generation <> OLD.generation + 1
         OR NOT EXISTS (SELECT 1 FROM acp.worker_dispatch_assignments a
           WHERE a.run_id = NEW.run_id AND a.generation = NEW.generation) THEN
        RAISE EXCEPTION 'dispatch assignment requires its next durable generation';
      END IF;
    ELSIF NEW.state IN ('running', 'completed') THEN
      IF NEW.generation <> OLD.generation OR NOT EXISTS (SELECT 1 FROM acp.worker_runs r
        WHERE r.run_id = NEW.run_id AND ((NEW.state = 'running' AND r.state = 'started')
          OR (NEW.state = 'completed' AND r.state <> 'started'))) THEN
        RAISE EXCEPTION 'dispatch state must follow its durable worker run';
      END IF;
    ELSIF NEW.state IN ('cancelled', 'blocked') THEN
      IF NEW.generation <> OLD.generation OR nullif(btrim(NEW.reason), '') IS NULL
         OR EXISTS (SELECT 1 FROM acp.worker_runs WHERE run_id = NEW.run_id) THEN
        RAISE EXCEPTION 'dispatch without-run cancellation requires a reason and no admitted run';
      END IF;
    ELSE RAISE EXCEPTION 'illegal dispatch transition';
    END IF;
  END IF;
  NEW.updated_at := statement_timestamp();
  RETURN NEW;
END;
$$;
CREATE TRIGGER worker_dispatches_validate BEFORE INSERT OR UPDATE OR DELETE ON acp.worker_dispatches
FOR EACH ROW EXECUTE FUNCTION acp.validate_dispatch();

CREATE FUNCTION acp.validate_dispatch_assignment() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  d acp.worker_dispatches;
  g acp.capability_grants;
  h acp.worker_hosts;
  prior acp.worker_dispatch_assignments;
BEGIN
  SELECT * INTO STRICT d FROM acp.worker_dispatches WHERE run_id = NEW.run_id FOR UPDATE;
  SELECT * INTO STRICT g FROM acp.capability_grants WHERE grant_id = d.grant_id;
  IF d.state NOT IN ('pending', 'assigned') OR NEW.generation <> d.generation + 1
     OR EXISTS (SELECT 1 FROM acp.worker_runs WHERE run_id = d.run_id)
     OR EXISTS (SELECT 1 FROM acp.mission_nodes n WHERE n.node_id = d.node_id
       AND acp.worker_cancellation_requested(d.mission_id, n.graph_revision))
     OR NEW.workflow_id <> ('worker:' || d.run_id || ':assignment:' || NEW.generation)
     OR NEW.queue_name <> acp.host_worker_queue(NEW.host_identifier, g.resource_class, NEW.host_session_id) THEN
    RAISE EXCEPTION 'dispatch assignment does not match its pending generation';
  END IF;
  SELECT * INTO prior FROM acp.worker_dispatch_assignments WHERE run_id = d.run_id AND generation = d.generation;
  IF prior.run_id IS NOT NULL AND prior.expires_at > statement_timestamp()
     AND EXISTS (SELECT 1 FROM acp.worker_hosts host JOIN acp.worker_host_runtimes runtime
       ON runtime.host_identifier = host.host_identifier
       JOIN acp.worker_host_sessions s ON s.host_identifier = host.host_identifier
       WHERE host.host_identifier = prior.host_identifier AND host.state = 'active'
         AND s.session_id = prior.host_session_id AND s.state = 'active'
         AND runtime.session_id = s.session_id
         AND s.heartbeat_at + make_interval(secs => host.heartbeat_ttl_seconds) > statement_timestamp()
         AND runtime.application_version = d.application_version
         AND runtime.template_provenance_id = prior.template_provenance_id
         AND least(host.heartbeat_at, runtime.heartbeat_at) + make_interval(secs => host.heartbeat_ttl_seconds) > statement_timestamp()) THEN
    RAISE EXCEPTION 'live unexpired assignment cannot be replaced';
  END IF;
  PERFORM 1 FROM acp.worker_host_sessions WHERE host_identifier = NEW.host_identifier FOR SHARE;
  SELECT * INTO STRICT h FROM acp.worker_hosts WHERE host_identifier = NEW.host_identifier FOR UPDATE;
  IF h.state <> 'active' OR h.heartbeat_at + make_interval(secs => h.heartbeat_ttl_seconds) <= statement_timestamp()
     OR (h.host_kind = 'operator_laptop' AND d.preferred_host_identifier IS DISTINCT FROM h.host_identifier)
     OR (d.preferred_host_identifier IS NOT NULL AND d.preferred_host_identifier <> h.host_identifier)
     OR NOT EXISTS (SELECT 1 FROM acp.worker_host_runtimes r JOIN acp.worker_host_sessions s USING (host_identifier)
       JOIN acp.missions m
       ON m.workflow_binding_id = r.workflow_binding_id WHERE m.mission_id = d.mission_id
       AND r.host_identifier = h.host_identifier AND r.application_version = d.application_version
       AND s.session_id = NEW.host_session_id AND r.session_id = s.session_id AND s.state = 'active'
       AND s.heartbeat_at + make_interval(secs => h.heartbeat_ttl_seconds) > statement_timestamp()
       AND r.template_provenance_id = NEW.template_provenance_id
       AND r.heartbeat_at + make_interval(secs => h.heartbeat_ttl_seconds) > statement_timestamp()) THEN
    RAISE EXCEPTION 'dispatch requires a live compatible explicitly eligible host';
  END IF;
  IF acp.worker_host_load(h.host_identifier, g.resource_class)
       - (CASE WHEN d.state = 'assigned' AND prior.host_identifier = h.host_identifier THEN 1 ELSE 0 END)
       >= acp.worker_host_capacity(h, g.resource_class) THEN
    RAISE EXCEPTION 'dispatch host capacity is reserved or occupied';
  END IF;
  IF g.valid_from > statement_timestamp() OR g.expires_at <= NEW.expires_at THEN
    RAISE EXCEPTION 'dispatch assignment must fit inside a current grant';
  END IF;
  NEW.assigned_at := statement_timestamp();
  RETURN NEW;
END;
$$;
CREATE TRIGGER worker_dispatch_assignments_validate BEFORE INSERT ON acp.worker_dispatch_assignments
FOR EACH ROW EXECUTE FUNCTION acp.validate_dispatch_assignment();

ALTER TABLE acp.worker_runs ADD COLUMN dispatch_generation integer;
CREATE FUNCTION acp.require_worker_dispatch() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  d acp.worker_dispatches;
  a acp.worker_dispatch_assignments;
BEGIN
  -- 0005 first acquires mission then node. Continue with dispatch, grant, host.
  SELECT * INTO d FROM acp.worker_dispatches WHERE run_id = NEW.run_id FOR UPDATE;
  SELECT * INTO a FROM acp.worker_dispatch_assignments WHERE run_id = NEW.run_id AND generation = NEW.dispatch_generation;
  -- Prerequisites may have changed since preparation/context assembly. Lock
  -- their current states through admission; a packet is not dependency authority.
  PERFORM prior.node_id FROM acp.mission_nodes n
    JOIN LATERAL jsonb_array_elements_text(n.dependencies) dep(id) ON true
    JOIN acp.mission_nodes prior ON prior.node_id::text = dep.id AND prior.mission_id = n.mission_id
    WHERE n.node_id = NEW.node_id ORDER BY prior.node_id FOR SHARE OF prior;
  IF EXISTS (SELECT 1 FROM acp.mission_nodes n
    JOIN LATERAL jsonb_array_elements_text(n.dependencies) dep(id) ON true
    LEFT JOIN acp.mission_nodes prior ON prior.node_id::text = dep.id AND prior.mission_id = n.mission_id
    WHERE n.node_id = NEW.node_id AND (prior.node_id IS NULL OR prior.state <> 'succeeded')) THEN
    RAISE EXCEPTION 'worker dispatch prerequisites are no longer satisfied';
  END IF;
  PERFORM 1 FROM acp.worker_host_sessions WHERE host_identifier = a.host_identifier FOR SHARE;
  IF d.run_id IS NULL OR a.run_id IS NULL OR d.state <> 'assigned' OR d.generation <> a.generation
     OR EXISTS (SELECT 1 FROM acp.mission_nodes n WHERE n.node_id = NEW.node_id
       AND acp.worker_cancellation_requested(NEW.mission_id, n.graph_revision))
     OR a.expires_at <= statement_timestamp() OR d.mission_id <> NEW.mission_id OR d.node_id <> NEW.node_id
     OR d.attempt_number <> NEW.attempt_number OR d.grant_id <> NEW.capability_grant_id
     OR d.operation <> NEW.operation OR d.resource <> NEW.resource
     OR a.host_identifier <> NEW.host_identifier OR a.context_packet_id <> NEW.context_packet_id
     OR a.packet_provenance_id <> NEW.provenance_id
     OR NOT EXISTS (SELECT 1 FROM acp.context_packets packet WHERE packet.context_packet_id = a.context_packet_id
       AND packet.provenance_id = a.packet_provenance_id AND packet.runtime_template_provenance_id = a.template_provenance_id)
     OR NOT EXISTS (SELECT 1 FROM acp.worker_host_runtimes r JOIN acp.worker_hosts h USING (host_identifier)
       JOIN acp.worker_host_sessions s USING (host_identifier)
       WHERE r.host_identifier = a.host_identifier AND r.application_version = d.application_version
       AND s.session_id = a.host_session_id AND r.session_id = s.session_id AND s.state = 'active'
       AND s.heartbeat_at + make_interval(secs => h.heartbeat_ttl_seconds) > statement_timestamp()
       AND r.template_provenance_id = a.template_provenance_id
       AND r.heartbeat_at + make_interval(secs => h.heartbeat_ttl_seconds) > statement_timestamp()) THEN
    RAISE EXCEPTION 'worker run requires its exact current host dispatch assignment';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER worker_runs_ab_require_dispatch BEFORE INSERT ON acp.worker_runs
FOR EACH ROW EXECUTE FUNCTION acp.require_worker_dispatch();

CREATE FUNCTION acp.sync_worker_dispatch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE acp.worker_dispatches SET state = CASE WHEN NEW.state = 'started' THEN 'running' ELSE 'completed' END
    WHERE run_id = NEW.run_id AND state IN ('assigned', 'running');
  IF NEW.state <> 'started' AND EXISTS (SELECT 1 FROM acp.worker_dispatches WHERE run_id = NEW.run_id) THEN
    UPDATE acp.mission_nodes SET state = NEW.state, completed_at = NEW.completed_at,
      transition_provenance_id = NEW.transition_provenance_id
      WHERE node_id = NEW.node_id AND mission_id = NEW.mission_id AND state = 'running';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER worker_runs_sync_dispatch AFTER INSERT OR UPDATE OF state ON acp.worker_runs
FOR EACH ROW EXECUTE FUNCTION acp.sync_worker_dispatch();
