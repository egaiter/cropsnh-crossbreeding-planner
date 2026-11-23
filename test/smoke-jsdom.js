/*
 * DOM-level smoke test of the CropsNH web app under jsdom: loads the real
 * index.html (scripts included), boots sql.js/WASM against the embedded
 * database, drives the form, and asserts the rendered result DOM.
 *
 * Requires jsdom (kept out of the project):
 *   npm i --prefix <somewhere> jsdom && NODE_PATH=<somewhere>/node_modules node web/test/smoke-jsdom.js
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { JSDOM, ResourceLoader, VirtualConsole } = require("jsdom");

const WEB = require("path").join(__dirname, "..");
const errors = [];

class LocalLoader extends ResourceLoader {
  fetch(url) {
    const p = decodeURIComponent(new URL(url).pathname);
    if (!fs.existsSync(p)) return Promise.reject(new Error("missing resource " + p));
    return fs.promises.readFile(p);
  }
}

function waitFor(predicate, what, timeoutMs = 60000) {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    (function poll() {
      let v;
      try { v = predicate(); } catch (e) { v = false; }
      if (v) return resolve(v);
      if (Date.now() - t0 > timeoutMs) return reject(new Error("timeout waiting for " + what));
      setTimeout(poll, 50);
    })();
  });
}

async function main() {
  const vc = new VirtualConsole();
  vc.on("jsdomError", (e) => errors.push("jsdomError: " + e.message));
  vc.on("error", (...a) => errors.push("console.error: " + a.join(" ")));

  const dom = await JSDOM.fromFile(path.join(WEB, "index.html"), {
    runScripts: "dangerously",
    resources: new LocalLoader(),
    virtualConsole: vc,
    beforeParse(window) {
      window.TextDecoder = TextDecoder;
      window.TextEncoder = TextEncoder;
      window.WebAssembly = WebAssembly; // sql.js needs wasm in this minimal env
    },
  });
  const { window } = dom;
  const doc = window.document;

  await waitFor(() => doc.getElementById("footer").textContent.includes("database:"), "sql.js boot");
  console.log("footer:", doc.getElementById("footer").textContent.trim());

  const options = doc.querySelectorAll("#cropList option");
  console.log("datalist options:", options.length);
  if (options.length !== 181) throw new Error("expected 181 crop options");

  const search = (from, to) => {
    doc.getElementById("results").innerHTML = ""; // avoid matching stale results
    doc.getElementById("fromInput").value = from;
    doc.getElementById("toInput").value = to;
    doc.getElementById("searchForm").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  };

  // pool spreading is ON by default: first search uses it without touching the box
  if (!doc.getElementById("poolsChk").checked) throw new Error("pool spreading should default to enabled");
  search("Poppy", "Rubyne");
  await waitFor(() => doc.getElementById("status").textContent.includes("1 breeding step"), "default-on pool path");
  console.log("default pools on ->", doc.getElementById("status").textContent);

  // turn pools off for the deterministic assertions below
  doc.getElementById("poolsChk").checked = false;

  // deterministic: Poppy -> Cobalt (partial name) has 5 equal shortest routes
  search("Poppy", "Cobalt");
  await waitFor(() => doc.querySelectorAll("details.path").length, "rendered paths");
  const paths = [...doc.querySelectorAll("details.path")];
  console.log("status:", doc.getElementById("status").textContent);
  console.log("paths rendered:", paths.length);
  if (paths.length !== 5) throw new Error("expected 5 paths, got " + paths.length);
  if (paths[0].querySelectorAll("ol.steps li").length !== 4) throw new Error("expected 4 steps in path 1");
  console.log("\n--- rendered Path 1 (text) ---\n" + paths[0].textContent.replace(/\s*\n\s*/g, "\n").trim());
  // collapse behavior: path 1 open by default, others closed
  if (!paths[0].hasAttribute("open") || paths[1].hasAttribute("open")) throw new Error("expand state wrong");

  // plantable-from-item feature
  const plantableChips = doc.querySelectorAll("details.path .badge.plantable");
  const bredChips = doc.querySelectorAll("details.path .badge.bred");
  console.log("plantable chips:", plantableChips.length, "| bred chips:", bredChips.length);
  if (!plantableChips.length || !bredChips.length) throw new Error("expected both plantable and needs-breeding ingredient badges");
  if (!/plantable/.test(plantableChips[0].textContent)) throw new Error("plantable badge lacks item info: " + plantableChips[0].textContent);
  if (!doc.querySelector(".legend .badge.plantable")) throw new Error("legend missing plantable explanation");
  if (!/ingredients plantable/.test(doc.querySelector("details.path .meta-right").textContent))
    throw new Error("path summary missing plantable ratio: " + doc.querySelector("details.path .meta-right").textContent);

  // pools toggle: Poppy -> Rubyne — deterministic distance is >1, pools make it 1
  search("Poppy", "Rubyne");
  const detStatus = await waitFor(() => {
    const t = doc.getElementById("status").textContent;
    return /from Poppy to Rubyne/.test(t) ? t : false;
  }, "deterministic Poppy->Rubyne status");
  if (detStatus.includes("1 breeding step")) throw new Error("det path unexpectedly 1 step: " + detStatus);
  console.log("\ndet status:", detStatus);
  doc.getElementById("poolsChk").checked = true;
  doc.getElementById("poolsChk").dispatchEvent(new window.Event("change", { bubbles: true }));
  await waitFor(() => doc.getElementById("status").textContent.includes("1 breeding step"), "pool 1-step status");
  console.log("pool status:", doc.getElementById("status").textContent);
  const badge = doc.querySelector("details.path .badge.pool");
  console.log("pool badge on expanded path:", badge && badge.textContent);
  if (!badge) throw new Error("expected pool-spreading badge");

  // ------------------------------------------------- crop-type list + modal
  const click = (el) => el.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
  const modal = doc.getElementById("cropTypeModal");
  const closeBtn = doc.getElementById("cropTypeClose");

  const typeLinks = [...doc.querySelectorAll("#results .type-link[data-pool]")];
  console.log("\ncrop-type links on the spreading step:", typeLinks.length, "|", typeLinks[0] && typeLinks[0].textContent);
  if (typeLinks.length !== 2)
    throw new Error("expected the type name clickable in both the cross line and the ingredient line, got " + typeLinks.length);
  typeLinks.forEach((l, i) => {
    if (l.dataset.pool !== "RED") throw new Error(`type link ${i + 1} should point at the RED pool: ${l.dataset.pool}`);
    if (l.dataset.exclude !== "Poppy") throw new Error(`type link ${i + 1} should remember Poppy as excluded: "${l.dataset.exclude}"`);
    if (l.tagName !== "BUTTON") throw new Error(`type link ${i + 1} should be a real button, got ${l.tagName}`);
  });
  if (modal.hidden === false) throw new Error("modal should start hidden");

  click(typeLinks[0]);
  if (modal.hidden) throw new Error("clicking the crop type name should open the modal");
  if (!doc.body.classList.contains("modal-open")) throw new Error("page scroll should be locked while open");
  const listed = [...modal.querySelectorAll("#cropTypeList li")];
  console.log("modal:", doc.getElementById("cropTypeTitle").textContent, "|", doc.getElementById("cropTypeSub").textContent);
  console.log("crops listed:", listed.length, "| first:", listed[0] && listed[0].textContent.trim().replace(/\s+/g, " "));
  if (listed.length !== 19) throw new Error("expected the 19 red crops, got " + listed.length);
  const skipped = listed.filter((li) => li.classList.contains("ct-skip"));
  if (skipped.length !== 1 || !skipped[0].textContent.includes("Poppy"))
    throw new Error("Poppy should be marked as the crop being crossed");
  if (modal.querySelector(".modal-close[aria-label]") === null) throw new Error("close button needs an aria-label");
  if (doc.activeElement !== closeBtn) throw new Error("focus should move to the close button, got " + doc.activeElement.id);

  click(closeBtn);
  if (!modal.hidden) throw new Error("the ✕ button should dismiss the modal");
  if (doc.body.classList.contains("modal-open")) throw new Error("scroll lock should be released on close");
  console.log("dismissed with ✕");

  click(typeLinks[1]); // this time from the "also source" ingredient line
  if (modal.hidden) throw new Error("modal should reopen");
  click(modal.querySelector("#cropTypeList")); // inside the dialog: must stay open
  if (modal.hidden) throw new Error("clicking inside the dialog must not dismiss it");
  click(modal); // the dimmed backdrop
  if (!modal.hidden) throw new Error("clicking outside the dialog should dismiss it");
  console.log("dismissed by clicking outside the dialog");

  click(typeLinks[0]);
  doc.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  if (!modal.hidden) throw new Error("Escape should dismiss the modal");
  console.log("dismissed with Escape");

  // keyboard: the list can be reached and focus stays inside the dialog
  click(typeLinks[0]);
  const list = doc.getElementById("cropTypeList");
  if (!list.hasAttribute("tabindex")) throw new Error("the crop list should be keyboard-scrollable");
  list.focus();
  doc.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
  if (doc.activeElement !== closeBtn) throw new Error("Tab from the last control should wrap to ✕");
  closeBtn.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true }));
  if (doc.activeElement !== list) throw new Error("Shift+Tab from ✕ should wrap to the crop list");
  doc.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  if (!modal.hidden) throw new Error("Escape should dismiss the modal from the list");
  console.log("focus stays on ✕ and the crop list; Escape closes from either");

  // the reported example: a "tendrilly" suggestion lists every tendrilly crop
  search("Cotton", "Vine");
  await waitFor(() => doc.querySelector("#results .type-link[data-pool='TENDRILLY']"), "tendrilly suggestion");
  click(doc.querySelector("#results .type-link[data-pool='TENDRILLY']"));
  if (modal.hidden) throw new Error("clicking “tendrilly” should open the modal");
  const tendrilly = [...modal.querySelectorAll("#cropTypeList li")];
  console.log("modal:", doc.getElementById("cropTypeTitle").textContent, "|", doc.getElementById("cropTypeSub").textContent);
  if (doc.getElementById("cropTypeTitle").textContent !== "Tendrilly crops")
    throw new Error("title should name the type: " + doc.getElementById("cropTypeTitle").textContent);
  if (tendrilly.length !== 19) throw new Error("expected 19 tendrilly crops, got " + tendrilly.length);
  if (!tendrilly.some((li) => li.textContent.includes("Thornvine")))
    throw new Error("Thornvine should be listed among the tendrilly crops");
  click(closeBtn);
  if (!modal.hidden) throw new Error("✕ should dismiss the tendrilly list too");

  // a new search closes a stale list whose trigger is gone
  click(doc.querySelector("#results .type-link[data-pool='TENDRILLY']"));
  search("Poppy", "Rubyne");
  await waitFor(() => doc.getElementById("status").textContent.includes("shortest path"), "re-render after reopen");
  if (!modal.hidden) throw new Error("a new search should close the modal");
  console.log("tendrilly list opens for its own type and closes on the next search");

  // invalid input
  search("Not A Crop", "Rubyne");
  await waitFor(() => doc.getElementById("status").classList.contains("error"), "error status");
  console.log("invalid input ->", doc.getElementById("status").textContent);

  if (errors.length) throw new Error("page errors:\n" + errors.join("\n"));
  console.log("\nJSDOM SMOKE PASSED (boot + options + 5-path render + expand + plantable badges + pools + crop-type modal ✕/outside/Escape + invalid input, no page errors)");
  window.close();
}

main().catch((e) => { console.error("FAIL:", e.message); process.exit(1); });
