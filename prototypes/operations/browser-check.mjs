import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

if (!process.env.ACP_PLAYWRIGHT_MODULE) throw new Error("Set ACP_PLAYWRIGHT_MODULE to an already installed Playwright module. This check installs nothing.");
const { chromium } = createRequire(import.meta.url)(process.env.ACP_PLAYWRIGHT_MODULE);
const browser = await chromium.launch({ channel: "msedge", headless: true, timeout: 15000 });
let checks = 0;
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
const page = await context.newPage(); page.setDefaultTimeout(5000); page.setDefaultNavigationTimeout(10000);
const errors = [], remoteRequests = [];
page.on("pageerror", error => errors.push(error.message));
await context.route(/^https?:/u, route => { remoteRequests.push(route.request().url()); return route.abort(); });
async function check(name, callback) { await callback(); checks++; process.stdout.write(`PASS Operations browser: ${name}\n`); }
const reset = () => page.locator("#reset").click();
const select = id => page.locator(`#request-${id}`).click();
const content = () => page.locator("#review-content").innerText();
const clickTab = name => page.locator(`#tab-${name}`).click();
async function noOverflow() { assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false); }
async function screenshot(name) {
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: resolve(`.impeccable/review/${name}.png`), fullPage: true, animations: "disabled" });
}
try {
  await page.goto(pathToFileURL(resolve("prototypes/operations/index.html")).href);
  await check("initial sample board and explicit no-live-action boundary", async () => {
    await page.locator("#request-EX-001").waitFor();
    assert.equal(await page.locator("tbody tr").count(), 3);
    assert.equal(await page.locator('.filters [data-filter="decisions"]').getAttribute("aria-pressed"), "true");
    assert.match(await page.locator(".prototype-bar").innerText(), /Illustrative data. No live approvals/u);
    assert.match(await content(), /Final outcome/u); assert.match(await content(), /Proposed/u);
  });
  await check("editing scope safely renders text, creates a revision and retains prior wording", async () => {
    await page.locator("#edit-scope").click();
    await page.locator("#editor-text").fill('Review <img src="https://example.invalid/injected"> as literal sample text.');
    await page.locator("#save-editor").click();
    assert.match(await content(), /revision 2/u); assert.equal(await page.locator("#review-content img").count(), 0);
    await clickTab("journey"); assert.match(await content(), /Revision 1/u); assert.match(await content(), /Restore amendment submission/u);
    await clickTab("review"); await page.locator("#approve-scope").click();
    assert.match(await page.locator("#notice").innerText(), /No worker started/u);
    assert.equal(await page.locator("#approve-scope").isDisabled(), true);
    assert.equal(await page.locator("#request-EX-001").count(), 1); assert.match(await page.locator("#request-rows").innerText(), /Kept here while you review/u);
    assert.match(await content(), /Still owed/u);
    assert.equal(await page.locator('#journey-strip [aria-current="step"] strong').innerText(), "Implementation");
  });
  await check("rejection records a reason while keeping the original request open", async () => {
    await reset(); await page.locator("#reject-solution").click(); await page.locator("#editor-text").fill("Investigate role handling before proposing a repair.");
    await page.locator("#save-editor").click(); assert.match(await content(), /original request and obligations remain open/u);
    await clickTab("journey"); assert.match(await content(), /Solution rejected/u); assert.match(await content(), /Investigate role handling/u);
    assert.equal(await page.locator('#journey-strip [aria-current="step"] strong').innerText(), "Alternative review");
  });
  await check("changed scope disables approval, keeps focus, and requires explicit revised-proposal loading", async () => {
    await reset(); await page.locator(".prototype-controls summary").click(); await page.locator("#drift").click();
    assert.equal(await page.locator("#approve-scope").isDisabled(), true); assert.match(await content(), /scope changed to revision 2/u);
    assert.equal(await page.evaluate(() => document.activeElement.id), "drift");
    await page.locator("#load-revision").click(); assert.equal(await page.locator("#approve-scope").isEnabled(), true);
    assert.match(await page.locator("#notice").innerText(), /has not been approved/u);
  });
  await check("editing cannot be silently discarded by switching requests", async () => {
    await reset(); await page.locator("#edit-scope").click(); await page.locator("#editor-text").fill("Unsaved sample direction.");
    await select("EX-002"); assert.equal(await page.locator("#editor-text").inputValue(), "Unsaved sample direction.");
    assert.match(await page.locator("#review-header").innerText(), /EX-001/u);
    if (!await page.locator("#coverage-toggle").isVisible()) await page.locator(".prototype-controls summary").click();
    await page.locator("#coverage-toggle").click(); assert.equal(await page.locator("#editor-text").inputValue(), "Unsaved sample direction.");
    assert.equal(await page.locator("#coverage").isVisible(), false); await page.locator("#cancel-editor").click();
  });
  await check("loading a stale proposal cannot replace an unsaved scope draft", async () => {
    await reset();
    if (!await page.locator("#drift").isVisible()) await page.locator(".prototype-controls summary").click();
    await page.locator("#drift").click(); await page.locator("#edit-scope").click();
    await page.locator("#editor-text").fill("Keep this unsaved draft while the proposal is stale.");
    await page.locator("#load-revision").click();
    assert.equal(await page.locator("#editor-text").inputValue(), "Keep this unsaved draft while the proposal is stale.");
    assert.equal(await page.evaluate(() => document.activeElement.id), "editor-text");
    await page.locator("#cancel-editor").click(); assert.equal(await page.locator("#approve-scope").isDisabled(), true);
  });
  await check("operator report does not pass incomplete verification", async () => {
    await reset(); await select("EX-002"); await page.locator("#report-evidence").click();
    await page.locator("#editor-text").fill("Sample report: an account is available through the approved secure path.");
    await page.locator("#save-editor").click(); await clickTab("evidence");
    assert.match(await content(), /Role regression/u); assert.match(await content(), /Incomplete/u); assert.match(await content(), /Sample report/u);
  });
  await check("communication due and unknown sends cannot masquerade as completed work", async () => {
    await reset(); await select("EX-003"); assert.match(await page.locator("#review-header").innerText(), /Communication due/u);
    assert.match(await content(), /project-contact@example.invalid/u);
    await page.locator("#unknown-send").click(); assert.equal(await page.locator("#unknown-send").isDisabled(), true);
    assert.match(await page.locator("#review-actions").innerText(), /Unknown outcome/u);
    assert.match(await page.locator("#review-header").innerText(), /Reconciliation required/u);
    assert.equal(await page.locator('#journey-strip [aria-current="step"] strong').innerText(), "Delivery reconciliation");
    await clickTab("journey"); assert.match(await content(), /Reply review.*Reviewed in sample/su);
  });
  await check("deferred reactivation preserves identity and no current execution permission is invented", async () => {
    await reset(); await page.locator('.filters [data-filter="waiting"]').click(); await select("EX-004");
    await page.locator("#wake-request").click(); assert.equal(await page.locator("#request-EX-004").count(), 1);
    assert.match(await content(), /Linked ticket selected/u); assert.match(await page.locator("#review-actions").innerText(), /permissions must be reviewed/u);
    assert.equal(await page.locator('#journey-strip [aria-current="step"] strong').innerText(), "Return review");
  });
  await check("empty search and simulated disconnected source do not claim healthy absence", async () => {
    await reset(); await page.locator("#search").fill("no matching request");
    assert.match(await page.locator("#empty").innerText(), /Live arrivals are not connected/u);
    if (!await page.locator("#coverage-toggle").isVisible()) await page.locator(".prototype-controls summary").click();
    await page.locator("#coverage-toggle").click(); assert.match(await page.locator("#coverage").innerText(), /no absence of new arrivals can be inferred/u);
  });
  await check("keyboard tablist and native readiness dialog retain usable focus", async () => {
    await reset(); await page.locator("#tab-review").focus(); await page.keyboard.press("ArrowRight");
    assert.equal(await page.locator("#tab-evidence").getAttribute("aria-selected"), "true");
    assert.equal(await page.evaluate(() => document.activeElement.id), "tab-evidence");
    await page.locator("#readiness-open").click(); assert.equal(await page.locator("#readiness-dialog").isVisible(), true);
    await page.keyboard.press("Escape"); assert.equal(await page.locator("#readiness-dialog").isVisible(), false);
    assert.equal(await page.evaluate(() => document.activeElement.id), "readiness-open");
  });
  await check("desktop, tablet, narrow and zoom-equivalent layouts have no page overflow", async () => {
    for (const width of [1440, 1100, 1024, 720, 390, 320]) {
      await page.setViewportSize({ width, height: 1000 }); await reset(); await noOverflow();
      await select("EX-001"); await noOverflow();
      assert.equal(await page.locator("#approve-scope").isVisible(), true);
      assert.match(await page.locator("#review-actions").innerText(), /production remains a separate manual handoff/u);
      assert.deepEqual(await page.locator(".review-context dt").allTextContents(), ["Checkpoint", "Next owner", "Sample age"]);
      assert.deepEqual(await page.locator(".review-context dd").allTextContents(), ["Scope review", "David", "24 min · awaiting scope review"]);
      if (width <= 1050) assert.equal(await page.evaluate(() => document.querySelector("#review-actions").getBoundingClientRect().top >= document.querySelector("#review-content").getBoundingClientRect().bottom - 1), true, "Narrow actions must follow, not cover, the reviewed content");
    }
  });
  await check("narrow scope, rejection and evidence editors reveal the focused field", async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    for (const [id, action] of [["EX-001", "edit-scope"], ["EX-001", "reject-solution"], ["EX-002", "report-evidence"]]) {
      await reset(); await select(id); await page.locator(`#${action}`).click();
      assert.equal(await page.evaluate(() => document.activeElement.id), "editor-text");
      assert.equal(await page.locator("#editor-text").evaluate(element => { const box = element.getBoundingClientRect(); return box.top >= 0 && box.bottom <= innerHeight; }), true);
      await page.locator("#cancel-editor").click(); await page.locator("#close-review").click();
      assert.equal(await page.locator(`#request-${id}`).isVisible(), true);
      assert.equal(await page.evaluate(() => document.activeElement.id), `request-${id}`);
    }
  });
  await check("declared foreground pairs meet the prototype's text contrast floor", async () => {
    const colors = await page.evaluate(() => { const style = getComputedStyle(document.documentElement); return Object.fromEntries(["ink", "panel", "white", "amber", "teal", "red", "muted"].map(key => [key, style.getPropertyValue(`--${key}`).trim()])); });
    const luminance = hex => { const rgb = hex.slice(1).match(/../g).map(value => parseInt(value, 16) / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4); return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722; };
    for (const bg of ["ink", "panel"]) for (const fg of ["white", "amber", "teal", "red", "muted"]) {
      const a = luminance(colors[fg]), b = luminance(colors[bg]); assert.ok((Math.max(a, b) + .05) / (Math.min(a, b) + .05) >= 4.5, `${fg} on ${bg}`);
    }
  });
  await check("CSP prevents network connections and the authored interface produced no remote request or script error", async () => {
    assert.match(await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute("content"), /connect-src 'none'/u);
    assert.equal(await page.evaluate(() => fetch("https://example.invalid/should-not-connect").then(() => false, () => true)), true);
    assert.deepEqual(remoteRequests, []); assert.deepEqual(errors, []);
  });
  if (process.env.ACP_PROTO_CAPTURE === "1") {
    await mkdir(resolve(".impeccable/review"), { recursive: true });
    await page.setViewportSize({ width: 1440, height: 1000 }); await reset();
    await page.locator(".prototype-controls").evaluate(element => { element.open = false; });
    await screenshot("desktop");
    await page.setViewportSize({ width: 390, height: 844 }); await reset(); await screenshot("mobile");
    await select("EX-001"); await screenshot("mobile-review");
    process.stdout.write("Captured desktop, mobile board and mobile review under .impeccable/review/.\n");
  }
  process.stdout.write(`PASS ${checks} Operations browser checks. No production boundary exercised.\n`);
} finally { await context.close(); await browser.close(); }
