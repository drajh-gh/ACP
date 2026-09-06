/* Browser-only rendering of authored samples. No persistence or network APIs. */
(() => {
  const model = globalThis.ACPPrototype;
  let state = model.createState(), tab = "review", editor = null, boardScroll = 0;
  const $ = id => document.getElementById(id);
  const escape = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  const current = () => state.requests.find(row => row.id === state.selectedId);
  const tone = value => /unknown|reconciliation|unconfirmed/i.test(value) ? "unknown" : /passed|verified|confirmed in sample/i.test(value) ? "passed" : /decision|due|changed|review|incomplete/i.test(value) ? "decision" : "";
  const badge = value => `<span class="status ${tone(value)}">${escape(value)}</span>`;
  const section = (title, body) => `<section class="review-section"><h3>${escape(title)}</h3>${body}</section>`;
  const list = values => `<ul>${values.map(value => `<li>${escape(value)}</li>`).join("")}</ul>`;
  const stepIcon = value => /Passed/.test(value)
    ? '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3 8 3 3 7-7"/></svg>'
    : '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="4"/></svg>';

  function renderBoard() {
    const counts = model.counts(state), rows = model.visibleRequests(state);
    for (const element of document.querySelectorAll("[data-count]")) element.textContent = counts[element.dataset.count];
    for (const button of document.querySelectorAll("[data-filter]")) {
      const active = button.dataset.filter === state.filter || (button.classList.contains("nav-item") && button.dataset.filter === "decisions" && state.filter === "active");
      if (button.closest(".filters")) button.setAttribute("aria-pressed", String(active));
      else { button.classList.toggle("active", active); if (active) button.setAttribute("aria-current", "page"); else button.removeAttribute("aria-current"); }
    }
    $("row-count").textContent = `${rows.length} shown · sample set`;
    $("request-rows").innerHTML = rows.map(row => `<tr class="${row.id === state.selectedId ? "selected" : ""}">
      <td><span class="row-id mono">${escape(row.id)} · ${escape(row.category)}</span><button id="request-${row.id}" type="button" class="request-button" data-request="${row.id}" aria-label="Review ${escape(row.subject)}" ${row.id === state.selectedId ? 'aria-current="true"' : ""}>${escape(row.subject)}</button><span class="outcome-line">Final: ${escape(row.outcome)}<br>${escape(row.outcomeStatus)}</span>${row.id === state.pinnedId ? '<span class="pinned">Kept here while you review</span>' : ""}</td>
      <td><span class="checkpoint">${escape(row.checkpoint)}</span>${badge(row.status)}<span class="owner">Next: ${escape(row.owner)}</span></td>
      <td class="age">${escape(row.age)}<span class="age-detail">${escape(row.ageLabel)}</span></td></tr>`).join("");
    $("empty").hidden = rows.length > 0;
    $("empty").innerHTML = '<strong>No sample requests match this view.</strong><p>Try another filter or search. Live arrivals are not connected, so this is not a claim that no work exists.</p>';
    $("coverage").hidden = state.coverage !== "unavailable";
    $("coverage").textContent = "Source coverage unavailable (simulated). Retained samples remain visible; no absence of new arrivals can be inferred.";
    const row = current();
    $("journey-id").textContent = row?.id ?? "";
    $("journey-description").textContent = row ? row.subject : "Select a request to inspect its checkpoints.";
    $("journey-strip").innerHTML = (row?.journey ?? []).map(item => `<li class="${item.state === "Passed" ? "done" : ""} ${item.name === row.checkpoint ? "current" : ""}" ${item.name === row.checkpoint ? 'aria-current="step"' : ""}><strong>${escape(item.name)}</strong><span class="step-state">${stepIcon(item.state)}${escape(item.state)}</span></li>`).join("");
  }
  function reviewBody(row) {
    let html = `<section class="review-section"><div class="outcome-heading"><h3>Final outcome</h3><span>${escape(row.outcomeStatus)}</span></div><p class="outcome-title">${escape(row.outcome)}</p><p>${escape(row.environment)}</p></section>`;
    html += section("Why you are needed", `<p>${escape(row.reason)}</p>`);
    if (row.proposal?.stale) html += `<div class="stale-warning">The scope changed to revision ${row.proposal.revision}. Previous approval is unavailable.<button type="button" id="load-revision">Load revised proposal</button></div>`;
    if (editor) {
      const title = editor === "scope" ? "Edit proposed scope" : editor === "rejection" ? "Why reject this solution?" : "Report available evidence";
      const initial = editor === "scope" ? row.proposal.text : "";
      const help = editor === "scope" ? "Saving creates a new sample revision and invalidates any earlier scope approval." : editor === "rejection" ? "Reject the solution, not the underlying request. Its obligations remain open." : "An operator report cannot mark an independent check passed. Do not enter credentials or real personal data.";
      html += `<section class="review-section editor"><form id="editor-form"><label for="editor-text">${title}</label><p>${help}</p><textarea id="editor-text" name="text" maxlength="5000" required>${escape(initial)}</textarea><div class="action-group"><button type="submit" class="primary" id="save-editor">${editor === "scope" ? "Save revised scope" : editor === "rejection" ? "Record rejection" : "Record sample report"}</button><button type="button" id="cancel-editor">Cancel editing</button></div></form></section>`;
    } else if (row.proposal) {
      html += section(`Proposed scope · revision ${row.proposal.revision}`, `<div class="scope-text"><p>${escape(row.proposal.text)}</p></div>`);
    } else {
      html += section("What is established", `<p>${escape(row.summary)}</p>`);
    }
    html += section("Trade-off and uncertainty", `<p>${escape(row.tradeoff)}</p>`);
    if (row.id === "EX-003") {
      const message = row.communications[0];
      html += section("Exact reply for this simulation", `<p><strong>To:</strong> ${escape(message.recipient)}</p><div class="scope-text"><p>${escape(message.body)}</p></div><p>Sample address and content only. No send capability is connected.</p>`);
    }
    html += section("Still owed before the final outcome", row.obligations.length ? list(row.obligations) : "<p>No outstanding obligations in this completed sample. It is not a live closure receipt.</p>");
    return html;
  }
  function evidenceBody(row) {
    return section("Evidence and limits", `<p>All findings below are authored sample data, not observations of SloSki or a real incident.</p><div>${row.checks.map(item => `<div class="evidence-item">${badge(item.state)}<strong>${escape(item.name)}</strong><p>${escape(item.detail)}</p></div>`).join("")}</div>`)
      + section("Environment", `<p>${escape(row.environment)}</p><p>There is no live candidate or execution receipt attached to this prototype.</p>`)
      + section("Operator reports", row.reports.length ? list(row.reports) : "<p>No sample reports recorded. An operator assertion would remain distinct from independent verification.</p>");
  }
  function journeyBody(row) {
    return section("Checkpoints and remaining work", `<ul class="record-list">${row.journey.map(item => `<li><strong>${escape(item.name)} ${badge(item.state)}</strong>${escape(item.detail)}</li>`).join("")}</ul>`)
      + section("Communication plan", row.communications.length ? `<ul class="record-list">${row.communications.map(item => `<li><strong>${escape(item.purpose)}</strong>${escape(item.recipient)}<br>Required · ${escape(item.state)}</li>`).join("")}</ul>` : "<p>No communication item is defined for this sample step. A real plan would require an explicit disposition.</p>")
      + section("Decisions in this session", row.decisions.length ? `<ul class="record-list">${row.decisions.map(item => `<li><strong>${escape(item.kind)} · revision ${item.revision}</strong>${escape(item.text)}</li>`).join("")}</ul>` : "<p>No decision recorded in this sample session.</p>")
      + (row.proposal ? section("Earlier scope revisions", row.proposal.history.length ? `<ul class="record-list">${row.proposal.history.map(item => `<li><strong>Revision ${item.revision} · ${item.approvedRevision ? "Previously approved in simulation" : "Not approved"}</strong>${escape(item.text)}</li>`).join("")}</ul>` : "<p>No previous sample revisions.</p>") : "");
  }
  function actionBody(row) {
    const limits = '<p class="action-limits">Simulation only. No real approval, worker, message or production action is created. Changes are lost on reload.</p>';
    if (editor) return '<p class="action-context">Save or cancel the inline edit to continue reviewing.</p>' + limits;
    if (tab !== "review") return '<button type="button" id="back-to-review">Return to decision review</button>' + limits;
    let actions = "";
    if (row.proposal) {
      const unavailable = row.proposal.stale || row.proposal.approvedRevision !== null || row.checkpoint !== "Scope review";
      actions = `<p class="action-context">Scope revision ${row.proposal.revision}<br><span>Development work only; production remains a separate manual handoff.</span></p><div class="action-group"><button type="button" class="primary" id="approve-scope" data-revision="${row.proposal.revision}" ${unavailable ? "disabled" : ""}>${row.proposal.approvedRevision ? "Scope approved in sample" : "Approve scope"}</button><button type="button" id="edit-scope">Edit scope</button><button type="button" id="reject-solution">Reject solution</button></div>`;
    } else if (row.id === "EX-002") actions = '<p class="action-context">Role regression remains incomplete. Reporting evidence does not pass the check.</p><button type="button" id="report-evidence" class="primary">Report available evidence</button>';
    else if (row.id === "EX-003") actions = `<p class="action-context">To: ${escape(row.communications[0].recipient)}<br><span>Required reply · ${escape(row.communications[0].state)}</span></p><button type="button" class="primary" id="unknown-send" ${row.communications[0].state !== "Review required" ? "disabled" : ""}>${row.communications[0].state === "Review required" ? "Simulate send with lost reply" : "Reconciliation required — no resend"}</button>`;
    else if (row.waiting) actions = '<p class="action-context">Wake condition: the linked ticket is selected.</p><button type="button" id="wake-request">Simulate linked-ticket return</button>';
    else actions = `<p class="action-context">${row.closed ? "Read-only completed sample. No live closure receipt." : "Current permissions must be reviewed before work can resume. No execution is connected."}</p>`;
    return actions + limits;
  }
  function render({ focusId, resetScroll = false, revealFocus = false } = {}) {
    const activeId = focusId ?? document.activeElement?.id;
    const scrollTop = $("review-content").scrollTop;
    renderBoard();
    const row = current();
    $("review-header").innerHTML = row ? `<h2 tabindex="-1" id="review-title">${escape(row.subject)}</h2><div class="review-meta"><span class="mono">${row.id}</span><span>${escape(row.category)}</span>${badge(row.status)}</div><dl class="review-context"><div><dt>Checkpoint</dt><dd>${escape(row.checkpoint)}</dd></div><div><dt>Next owner</dt><dd>${escape(row.owner)}</dd></div><div class="review-age"><dt>Sample age</dt><dd>${escape(row.age)} · ${escape(row.ageLabel)}</dd></div></dl>` : '<h2 id="review-title" tabindex="-1">Select a request</h2>';
    for (const button of document.querySelectorAll("[data-tab]")) { const active = button.dataset.tab === tab; button.setAttribute("aria-selected", String(active)); button.tabIndex = active ? 0 : -1; }
    $("review-content").setAttribute("aria-labelledby", `tab-${tab}`);
    $("review-content").innerHTML = row ? tab === "review" ? reviewBody(row) : tab === "evidence" ? evidenceBody(row) : journeyBody(row) : '<p class="empty">Choose a sample request from Operations.</p>';
    $("review-actions").innerHTML = row ? actionBody(row) : "";
    $("review-content").scrollTop = resetScroll ? 0 : scrollTop;
    $("notice").textContent = state.notice;
    const target = activeId && $(activeId);
    if (target && !target.disabled) { target.focus({ preventScroll: !revealFocus }); if (revealFocus) target.scrollIntoView({ block: "center" }); }
    else if (activeId && !document.activeElement?.id) $("review-title").focus({ preventScroll: true });
  }
  function dispatch(event, options) {
    try { state = model.transition(state, event); render(options); }
    catch (error) { $("notice").textContent = error.message; }
  }
  function guardEdit() {
    if (!editor) return true;
    $("notice").textContent = "Save or cancel the current edit before changing the request or view.";
    $("editor-text")?.focus({ preventScroll: true }); return false;
  }
  document.addEventListener("click", event => {
    const button = event.target.closest("button"); if (!button || button.disabled) return;
    if (button.dataset.filter) { if (!guardEdit()) return; tab = "review"; document.body.classList.remove("detail-open"); dispatch({ type: "filter", value: button.dataset.filter }); return; }
    if (button.dataset.request) { if (!guardEdit()) return; tab = "review"; if (!document.body.classList.contains("detail-open")) boardScroll = window.scrollY; document.body.classList.add("detail-open"); dispatch({ type: "select", id: button.dataset.request }, { focusId: "review-title", resetScroll: true, revealFocus: matchMedia("(max-width: 1050px)").matches }); return; }
    if (button.dataset.tab) { if (!guardEdit()) return; tab = button.dataset.tab; render({ focusId: button.id, resetScroll: true }); return; }
    const id = state.selectedId;
    switch (button.id) {
      case "reset": state = model.createState(); tab = "review"; editor = null; boardScroll = 0; $("search").value = ""; document.body.classList.remove("detail-open"); render({ focusId: "reset", resetScroll: true }); break;
      case "close-review": if (!guardEdit()) return; document.body.classList.remove("detail-open"); window.scrollTo({ top: boardScroll }); $(`request-${id}`)?.focus({ preventScroll: true }); break;
      case "edit-scope": editor = "scope"; render({ focusId: "editor-text", revealFocus: true }); break;
      case "reject-solution": editor = "rejection"; render({ focusId: "editor-text", revealFocus: true }); break;
      case "report-evidence": editor = "evidence"; render({ focusId: "editor-text", revealFocus: true }); break;
      case "cancel-editor": editor = null; render({ focusId: "review-title" }); break;
      case "approve-scope": dispatch({ type: "approve_scope", id, revision: Number(button.dataset.revision) }, { focusId: "review-title" }); break;
      case "load-revision": if (!guardEdit()) return; dispatch({ type: "load_revision", id }, { focusId: "review-title" }); break;
      case "back-to-review": tab = "review"; render({ focusId: "tab-review", resetScroll: true }); break;
      case "unknown-send": dispatch({ type: "simulate_unknown_send", id }, { focusId: "review-title" }); break;
      case "wake-request": dispatch({ type: "simulate_return", id }, { focusId: "review-title" }); break;
      case "drift": if (!guardEdit()) return; tab = "review"; dispatch({ type: "simulate_drift", id: "EX-001" }); break;
      case "return-signal": if (!guardEdit()) return; tab = "review"; dispatch({ type: "simulate_return", id: "EX-004" }); break;
      case "coverage-toggle": if (!guardEdit()) return; dispatch({ type: "toggle_coverage" }); break;
      case "readiness-open": $("readiness-dialog").showModal(); break;
      case "readiness-close": $("readiness-dialog").close(); break;
    }
  });
  document.addEventListener("submit", event => {
    if (event.target.id !== "editor-form") return;
    event.preventDefault();
    const action = editor === "scope" ? "edit_scope" : editor === "rejection" ? "reject_solution" : "report_evidence";
    try { state = model.transition(state, { type: action, id: state.selectedId, text: $("editor-text").value }); editor = null; render({ focusId: "review-title" }); }
    catch (error) { $("notice").textContent = error.message; }
  });
  $("search").addEventListener("input", event => {
    if (!guardEdit()) { event.target.value = state.search; return; }
    dispatch({ type: "search", value: event.target.value });
  });
  document.querySelector(".review-tabs").addEventListener("keydown", event => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key) || !guardEdit()) return;
    event.preventDefault(); const tabs = ["review", "evidence", "journey"], at = tabs.indexOf(tab);
    tab = event.key === "Home" ? tabs[0] : event.key === "End" ? tabs[2] : tabs[(at + (event.key === "ArrowRight" ? 1 : 2)) % 3];
    render({ focusId: `tab-${tab}`, resetScroll: true });
  });
  render();
})();
