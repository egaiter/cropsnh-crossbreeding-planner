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

  // invalid input
  search("Not A Crop", "Rubyne");
  await waitFor(() => doc.getElementById("status").classList.contains("error"), "error status");
  console.log("invalid input ->", doc.getElementById("status").textContent);

  if (errors.length) throw new Error("page errors:\n" + errors.join("\n"));
  console.log("\nJSDOM SMOKE PASSED (boot + options + 5-path render + expand + plantable badges + pools + invalid input, no page errors)");
  window.close();
}

main().catch((e) => { console.error("FAIL:", e.message); process.exit(1); });
