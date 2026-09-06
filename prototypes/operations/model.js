/* Isolated, synthetic in-memory state. Intentionally no storage, network or ACP ports.
   These transitions demonstrate review UX, not approved production policy. */
(() => {
  const proposal = text => ({ revision: 1, text, approvedRevision: null, stale: false, history: [] });
  const step = (name, state, detail) => ({ key: name, name, state, detail });
  const updateStep = (row, key, change) => Object.assign(row.journey.find(item => item.key === key), change);
  function createState() {
    const common = { project: "SZS / SloSki", closed: false, execution: "Not started", decisions: [], reports: [],
      outcomeStatus: "Proposed", needsDecision: true, owner: "David", waiting: false, communications: [] };
    return { filter: "decisions", search: "", selectedId: "EX-001", pinnedId: null, coverage: "sample", notice: "", requests: [
      { ...structuredClone(common), id: "EX-001", subject: "Membership amendment cannot be submitted", category: "Incident", age: "24 min", ageLabel: "awaiting scope review",
        checkpoint: "Scope review", status: "Decision due", outcome: "Production issue resolved", environment: "Development first · production by manual handoff",
        reason: "Approve the investigation-backed scope before implementation. The affected cohort is not established yet.",
        summary: "In this sample case, a club can open an amendment but cannot submit it. Investigation reproduced the interruption in a development fixture; its cause is still a hypothesis.",
        proposal: proposal("Restore amendment submission without changing the club's existing journey. Investigate the cause and affected roles, prepare a development repair, then verify the agreed flow and regressions. Production changes require a separate reviewed manual handoff."),
        tradeoff: "Preserving the existing journey minimizes retraining. Investigating role coverage adds work before a production plan can be prepared.",
        checks: [step("Reported blockage", "Observed in sample", "Synthetic report and development reproduction; not a real incident finding."),
          step("Root cause", "Unconfirmed", "Validation and permission handling need investigation."), step("Affected cohort", "Unknown", "No production records have been inspected.")],
        journey: [step("Arrival", "Passed", "Sample source retained"), step("Investigation", "Passed", "Initial sample findings prepared; cause still unconfirmed"), step("Scope review", "Your decision", "Outcome and scope revision 1"), step("Implementation", "Pending", "No worker started"), step("Verification", "Pending", "No repair exists"), step("Communication", "Pending", "Exact sends need review")],
        obligations: ["Restore the reported submission flow", "Establish root cause and affected scope", "Verify prevention and relevant regressions", "Review any production handoff", "Complete required client communication"],
        communications: [{ purpose: "Acknowledge the report", recipient: "Project contact · sample", state: "Review required", required: true },
          { purpose: "Confirm the verified outcome", recipient: "Project contact · sample", state: "Not due", required: true }] },
      { ...structuredClone(common), id: "EX-002", subject: "Club export is ready for role verification", category: "Change", age: "46 min", ageLabel: "waiting for test access",
        checkpoint: "Dev verification", status: "Verification incomplete", outcome: "Requested change delivered", outcomeStatus: "Approved", environment: "Development · not production",
        reason: "A role-specific test account is missing. Report available access or evidence; an independent check must still run.",
        summary: "The sample development candidate contains the export change. The happy path was checked, but club-role regression remains incomplete.",
        proposal: null, tradeoff: "Shipping without role verification could hide an access regression. A visual preview does not close that gap.",
        checks: [step("Development behavior", "Passed", "Illustrative result for the sample candidate only"), step("Role regression", "Incomplete", "A permitted club-role account is needed"), step("Production validation", "Not performed", "No production handoff has occurred")],
        journey: [step("Scope review", "Passed", "Sample scope approved"), step("Implementation", "Passed", "Illustrative candidate"), step("Dev verification", "Incomplete", "Role test account missing"), step("Production handoff", "Pending", "Manual and separately reviewed"), step("Communication", "Pending", "Outcome not verified")],
        obligations: ["Run club-role regression", "Verify the selected candidate in the agreed environment", "Review final communication"],
        communications: [{ purpose: "Report the verified change", recipient: "Project contact · sample", state: "Not due", required: true }] },
      { ...structuredClone(common), id: "EX-003", subject: "Membership renewal guidance is ready to send", category: "Support", age: "12 min", ageLabel: "awaiting reply review",
        checkpoint: "Reply review", status: "Communication due", outcome: "Support matter answered", outcomeStatus: "Approved", environment: "Support response · no deployment",
        reason: "Review the exact recipient and prepared reply. The request stays open until the required communication is confirmed.",
        summary: "The sample explanation was checked against a synthetic help document. No engineering change is needed, but the requester has not received the answer.",
        proposal: null, tradeoff: "A prepared answer is not a delivered answer. An uncertain provider response would require reconciliation before another attempt.",
        checks: [step("Answer review", "Passed", "Synthetic source and reply agree"), step("Engineering checks", "Not required", "This sample is a support explanation"), step("Message delivery", "Not performed", "No message has been sent")],
        journey: [step("Arrival", "Passed", "Sample source"), step("Answer preparation", "Passed", "Sample evidence checked"), step("Reply review", "Your decision", "Exact text and recipient"), step("Delivery", "Pending", "No provider connected"), step("Final outcome", "Pending", "Required communication outstanding")],
        obligations: ["Review the exact reply", "Confirm delivery before closure"],
        communications: [{ purpose: "Answer the renewal question", recipient: "project-contact@example.invalid", state: "Review required", required: true,
          body: "Sample reply for review only: please use the renewal option in the membership workspace. No change to an existing application is required in this illustrative scenario." }] },
      { ...structuredClone(common), id: "EX-004", subject: "Roster import needs a clearer preview", category: "Change", age: "2 days", ageLabel: "deferred in sample backlog",
        checkpoint: "Waiting", status: "Deferred", outcome: "Requested change delivered", outcomeStatus: "Approved", needsDecision: false, waiting: true,
        owner: "Linked ticket / David", environment: "Development target · work not started", reason: "Deferred until the linked ticket is selected. The approved outcome and outstanding work remain attached to this request.",
        summary: "This sample request is in the backlog, not completed. A linked-ticket signal can bring it back for refreshed review without creating another request.",
        proposal: null, tradeoff: "Deferral preserves the obligation; it is not evidence that the import problem was fixed.",
        checks: [step("Current execution permission", "Not granted", "Returning work must revalidate approvals")],
        journey: [step("Scope review", "Passed", "Sample destination approved"), step("Waiting", "Waiting externally", "Linked ticket selected or manual review"), step("Implementation", "Pending", "No worker started"), step("Verification", "Pending", "No candidate")],
        obligations: ["Review current context on return", "Prepare the preview change", "Verify the agreed outcome"], communications: [] },
      { ...structuredClone(common), id: "EX-005", subject: "Attachment retry guidance delivered", category: "Support", age: "1 day", ageLabel: "since sample closure",
        checkpoint: "Final outcome", status: "Verified outcome", outcome: "Support matter answered", outcomeStatus: "Approved", closed: true, needsDecision: false,
        owner: "No action due", environment: "Support response · no deployment", reason: "The illustrative answer, delivery and required follow-up are complete. This is a completed sample, not a live receipt.",
        summary: "A completed sample lets you compare a verified final outcome with work that is merely in a waiting area.", proposal: null, tradeoff: "Closure is specific to the sample contract. It does not establish a tracker or deployment transition.",
        checks: [step("Answer review", "Passed", "Sample evidence"), step("Delivery confirmation", "Passed", "Illustrative receipt, no real provider")],
        journey: [step("Answer review", "Passed", "Sample contract"), step("Delivery", "Passed", "Illustrative receipt"), step("Final outcome", "Passed", "All sample obligations met")], obligations: [],
        communications: [{ purpose: "Deliver reviewed guidance", recipient: "Project contact · sample", state: "Confirmed in sample", required: true }] }
    ] };
  }
  const matches = (row, filter) => filter === "decisions" ? row.needsDecision : filter === "active" ? !row.closed : filter === "waiting" ? row.waiting : row.closed;
  function visibleRequests(state) {
    const search = state.search.toLocaleLowerCase();
    return state.requests.filter(row => (matches(row, state.filter) || row.id === state.pinnedId)
      && `${row.id} ${row.subject} ${row.checkpoint} ${row.outcome}`.toLocaleLowerCase().includes(search));
  }
  function counts(state) {
    return Object.fromEntries(["decisions", "active", "waiting", "completed"].map(filter => [filter, state.requests.filter(row => matches(row, filter)).length]));
  }
  function text(value) {
    if (typeof value !== "string" || !value.trim() || value.length > 5000) throw new Error("Enter between 1 and 5,000 characters.");
    return value.trim();
  }
  function transition(previous, event) {
    const state = structuredClone(previous); state.notice = "";
    if (event.type === "filter" || event.type === "search") {
      if (event.type === "filter") {
        if (!["decisions", "active", "waiting", "completed"].includes(event.value)) throw new Error("Unknown view.");
        state.filter = event.value;
      } else { if (typeof event.value !== "string" || event.value.length > 200) throw new Error("Search is too long."); state.search = event.value; }
      state.pinnedId = null; state.selectedId = visibleRequests(state)[0]?.id ?? null; return state;
    }
    if (event.type === "toggle_coverage") { state.coverage = state.coverage === "sample" ? "unavailable" : "sample"; return state; }
    const row = state.requests.find(item => item.id === event.id);
    if (!row) throw new Error("The sample request is unavailable.");
    if (event.type === "select") { state.selectedId = row.id; return state; }
    const scopeAction = ["edit_scope", "approve_scope", "reject_solution", "simulate_drift", "load_revision"].includes(event.type);
    if (scopeAction && (!row.proposal || row.closed)) throw new Error("This request has no editable scope proposal.");
    switch (event.type) {
      case "edit_scope": {
        const nextText = text(event.text);
        if (nextText === row.proposal.text) { state.notice = "No scope changes to save."; return state; }
        row.proposal.history.push({ revision: row.proposal.revision, text: row.proposal.text, approvedRevision: row.proposal.approvedRevision });
        row.proposal.revision++; row.proposal.text = nextText; row.proposal.approvedRevision = null;
        row.needsDecision = true; row.outcomeStatus = "Proposed"; row.status = "Decision due"; row.checkpoint = "Scope review"; row.owner = "David";
        updateStep(row, "Scope review", { name: "Scope review", state: "Your decision", detail: `Outcome and scope revision ${row.proposal.revision}` });
        row.reason = "Review the revised scope and remaining uncertainty before any implementation can start.";
        state.notice = `Sample scope revision ${row.proposal.revision} saved. Any earlier scope approval no longer applies.`; break;
      }
      case "approve_scope":
        if (row.proposal.stale || row.proposal.revision !== event.revision || row.proposal.approvedRevision !== null || row.checkpoint !== "Scope review") throw new Error("Review the current scope revision before approving.");
        row.proposal.approvedRevision = event.revision; row.outcomeStatus = "Approved"; row.needsDecision = false;
        row.checkpoint = "Implementation"; row.status = "Ready for next step"; row.owner = "ACP · not started";
        row.reason = "Scope approval is simulated. Implementation, exact effect approvals and verification are still outstanding.";
        updateStep(row, "Scope review", { state: "Passed", detail: `Scope revision ${event.revision} approved in the simulation only` });
        row.decisions.push({ kind: "Scope approved", revision: event.revision, text: row.proposal.text });
        state.notice = `Scope approval simulated for revision ${event.revision}. No worker started and no effect was authorized.`; break;
      case "reject_solution":
        row.decisions.push({ kind: "Solution rejected", revision: row.proposal.revision, text: text(event.text) });
        row.proposal.approvedRevision = null; row.needsDecision = false; row.status = "Decision recorded"; row.checkpoint = "Alternative review";
        row.owner = "ACP · not started"; row.reason = "The solution was rejected in this simulation. The original request and obligations remain open.";
        updateStep(row, "Scope review", { name: "Alternative review", state: "Pending", detail: `Scope revision ${row.proposal.revision} rejected; no alternative investigation started` });
        state.notice = "Rejection recorded in the sample. The underlying request remains open; no investigation started."; break;
      case "simulate_drift":
        row.proposal.history.push({ revision: row.proposal.revision, text: row.proposal.text, approvedRevision: row.proposal.approvedRevision });
        row.proposal.revision++; row.proposal.text += " New sample evidence: a second role may be affected; investigate before selecting a repair.";
        row.proposal.stale = true; row.proposal.approvedRevision = null; row.outcomeStatus = "Proposed";
        row.needsDecision = true; row.status = "Proposal changed"; row.checkpoint = "Scope review"; row.owner = "David";
        updateStep(row, "Scope review", { name: "Scope review", state: "Your decision", detail: `Changed scope revision ${row.proposal.revision} requires refreshed review` });
        row.reason = "The proposed scope changed. Load the current revision and review its uncertainty before any approval.";
        state.notice = "A material sample update invalidated the open proposal. Load the revised scope before approval."; break;
      case "load_revision":
        row.proposal.stale = false; row.status = "Decision due";
        state.notice = "Current sample proposal loaded. It has not been approved."; break;
      case "report_evidence":
        if (row.id !== "EX-002") throw new Error("No missing-evidence report is expected here.");
        row.reports.push(text(event.text)); row.needsDecision = false; row.owner = "Verifier · not started";
        state.notice = "Operator report noted in the sample; independent verification remains incomplete."; break;
      case "simulate_return":
        if (!row.waiting) throw new Error("This sample request is not deferred.");
        row.waiting = false; row.needsDecision = true; row.checkpoint = "Return review"; row.status = "Returned for review"; row.owner = "David";
        row.reason = "Linked ticket selected (simulated). Review current context and permissions before any implementation resumes.";
        updateStep(row, "Waiting", { name: "Return review", state: "Your decision", detail: "Linked ticket selected in sample; current context and permissions still need review" });
        state.notice = "The same sample request returned. No new request, restored approval or worker execution was created."; break;
      case "simulate_unknown_send":
        if (row.id !== "EX-003" || row.communications[0].state !== "Review required") throw new Error("Do not repeat a send with an unknown outcome.");
        row.communications[0].state = "Unknown outcome"; row.status = "Reconciliation required"; row.checkpoint = "Delivery reconciliation";
        row.checks.find(item => item.name === "Message delivery").state = "Unknown";
        updateStep(row, "Reply review", { state: "Reviewed in sample", detail: "Exact sample recipient and reply selected for the lost-response simulation only" });
        updateStep(row, "Delivery", { name: "Delivery reconciliation", state: "Unknown outcome", detail: "Simulated acknowledgement lost; delivery is unconfirmed and repeat send is disabled" });
        row.reason = "This simulation lost a send acknowledgement. It cannot claim delivery or safely repeat the action.";
        state.notice = "Unknown send outcome simulated. No real message was sent; a duplicate attempt is disabled."; break;
      default: throw new Error("This action is not part of the isolated prototype.");
    }
    row.age = "0 min"; row.ageLabel = "since this simulated update";
    state.selectedId = row.id; state.pinnedId = row.id; return state;
  }
  globalThis.ACPPrototype = Object.freeze({ createState, transition, visibleRequests, counts });
})();
