/* DOM wiring for the CropsNH breeding path finder. All logic lives in breeding-engine.js. */
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const els = {
    form: $("searchForm"),
    from: $("fromInput"),
    to: $("toInput"),
    list: $("cropList"),
    pools: $("poolsChk"),
    go: $("goBtn"),
    status: $("status"),
    results: $("results"),
    footer: $("footer"),
    swap: $("swapBtn"),
  };

  let graph = null;

  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function b64ToBytes(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  // ------------------------------------------------------------- boot & sql.js

  async function boot() {
    try {
      const SQL = await initSqlJsSafe();
      const db = new SQL.Database(b64ToBytes(window.CROPSNH_DATA.dbBase64));
      graph = window.BreedingEngine.loadGraph(db);

      for (const name of graph.crops) {
        const opt = document.createElement("option");
        opt.value = name;
        els.list.appendChild(opt);
      }

      const commit = (graph.meta.source_commit || "").slice(0, 8);
      els.footer.innerHTML =
        `database: <code>${graph.crops.length} crops</code> · <code>${graph.mutations.length} deterministic mutations</code> · ` +
        `<code>${graph.pools.length} pools</code> · <code>${graph.plantable.size} plantable-from-item</code> — built ${esc(graph.meta.generated_at || "?")} from commit ${esc(commit || "?")} — ` +
        `SQLite (sql.js 1.13.0) running entirely in your browser`;

      document.body.classList.remove("booting");
      els.from.focus();
    } catch (err) {
      setStatus("Failed to load the embedded database: " + (err && err.message ? err.message : err), true);
      console.error(err);
    }
  }

  async function initSqlJsSafe() {
    const wasmB64 = window.CROPSNH_DATA && window.CROPSNH_DATA.wasmBase64;
    try {
      // embedded wasm bytes: works even on file:// where fetch/XHR is blocked
      return await initSqlJs({ wasmBinary: b64ToBytes(wasmB64) });
    } catch (err) {
      console.warn("embedded wasm load failed, falling back to vendor fetch", err);
      return await initSqlJs({ locateFile: (f) => "vendor/" + f });
    }
  }

  // -------------------------------------------------------------------- search

  function setStatus(msg, isError) {
    els.status.textContent = msg || "";
    els.status.className = "status" + (isError ? " error" : "");
  }

  function resolveCrop(input) {
    const t = input.trim().toLowerCase();
    if (!t) return null;
    const exact = graph.crops.find((c) => c.toLowerCase() === t);
    if (exact) return exact;
    // unique prefix or substring match (e.g. "cobalt" -> CobaltOreBerry)
    let hits = graph.crops.filter((c) => c.toLowerCase().startsWith(t));
    if (hits.length === 1) return hits[0];
    hits = graph.crops.filter((c) => c.toLowerCase().includes(t));
    return hits.length === 1 ? hits[0] : null;
  }

  function runSearch() {
    if (!graph) return;
    const start = resolveCrop(els.from.value);
    const target = resolveCrop(els.to.value);
    if (!start || !target) {
      const bad = !start ? els.from.value : els.to.value;
      setStatus(`“${bad}” is not a known crop — pick one from the dropdown.`, true);
      els.results.innerHTML = "";
      return;
    }
    setStatus("computing…");
    els.go.disabled = true;
    // yield one frame so the status paints before the (synchronous) search
    setTimeout(() => {
      try {
        const res = window.BreedingEngine.findPaths(graph, start, target, {
          usePools: els.pools.checked,
          maxPaths: 5,
        });
        render(start, target, res);
      } catch (err) {
        setStatus("Search failed: " + err.message, true);
        console.error(err);
      } finally {
        els.go.disabled = false;
      }
    }, 0);
  }

  // ------------------------------------------------------------------- render

  function chainHtml(crops) {
    return crops.map((c) => `<span class="crop">${esc(c)}</span>`).join('<span class="arrow">→</span>');
  }

  function render(start, target, res) {
    els.results.innerHTML = "";
    if (res.status === "same") {
      setStatus(`${start} is already ${target}. 🌱`);
      return;
    }
    if (res.status === "unreachable") {
      setStatus(
        `No breeding path from ${start} to ${target}` +
          (els.pools.checked ? "." : " with deterministic mutations — try enabling pool spreading."),
        true
      );
      return;
    }
    if (!res.paths.length) {
      setStatus(`No path found from ${start} to ${target}.`, true);
      return;
    }
    setStatus(
      `${res.paths.length} shortest path${res.paths.length > 1 ? "s" : ""} from ${start} to ${target} ` +
        `(${res.totalShortest} breeding step${res.totalShortest > 1 ? "s" : ""})`
    );

    res.paths.forEach((p, i) => {
      const d = document.createElement("details");
      d.className = "path";
      if (i === 0) d.open = true;

      const badges = [];
      if (p.extras > 0 && p.bredExtras === 0) badges.push("🌱 every ingredient plantable");
      else if (p.plantableExtras > 0) badges.push(`${p.plantableExtras}/${p.extras} ingredients plantable`);
      if (p.machineSteps) badges.push(`${p.machineSteps} machine-only step${p.machineSteps > 1 ? "s" : ""}`);
      if (p.usesPool) badges.push("uses pool spreading");
      d.innerHTML =
        `<summary><span class="pathno">Path ${i + 1}</span>` +
        `<span class="chain">${chainHtml(p.crops)}</span>` +
        `<span class="meta-right">${p.length} step${p.length > 1 ? "s" : ""}${badges.length ? " · " + badges.join(" · ") : ""}</span></summary>` +
        `<ol class="steps">${p.steps.map(stepHtml).join("")}</ol>`;
      els.results.appendChild(d);
    });
  }

  function stepHtml(step) {
    const ing = step.ingredients.map((x) => `<b>${esc(x.label)}</b>`).join(" × ");
    const badges = [];
    if (step.kind === "pool") badges.push(`<span class="badge pool">in-world spreading · probabilistic</span>`);
    if (step.machineOnly) badges.push(`<span class="badge machine">crop breeder machine only</span>`);
    if (step.catalysts.length)
      badges.push(`<span class="badge machine">catalyst: ${esc(step.catalysts.map((c) => c.label).join(", "))}</span>`);
    if (step.modGate) badges.push(`<span class="badge mod">requires mods: ${esc(step.modGate.replace(/ && /g, ", "))}</span>`);
    if (step.toPlantable && step.toPlantable.length)
      badges.push(`<span class="badge plantable" title="this crop skips breeding entirely">🌱 output plantable: ${esc(viaText(step.toPlantable))}</span>`);

    const mats = step.ingredients.map(matHtml).join(", ");
    const needs = step.ingredients.length ? `<div class="need">also source ${mats}</div>` : "";

    return (
      `<li><div class="cross"><b>${esc(step.from)}</b> × ${ing} <span class="out">→ <b>${esc(step.to)}</b></span></div>` +
      (badges.length ? `<div class="badges">${badges.join("")}</div>` : "") +
      needs +
      `</li>`
    );
  }

  /** e.g. "minecraft:wheat_seeds / BiomesOPlenty:moss (if BiomesOPlenty)" */
  function viaText(via) {
    return via.map((v) => v.desc + (v.gate ? ` (if ${v.gate})` : "")).join(" / ");
  }

  function matHtml(x) {
    let chip;
    if (x.plantable) {
      const prefix = x.partnerExample ? `partner e.g. ${esc(x.partnerExample)}: ` : "";
      chip = `<span class="badge plantable" title="plantable directly from an item — no breeding">🌱 ${prefix}${esc(viaText(x.plantVia))}</span>`;
    } else {
      chip = `<span class="badge bred">needs breeding</span>`;
    }
    return `<span class="mat"><b>${esc(x.label)}</b> ${chip}</span>`;
  }

  // --------------------------------------------------------------------- wire

  els.form.addEventListener("submit", (e) => {
    e.preventDefault();
    runSearch();
  });
  els.pools.addEventListener("change", () => {
    if (resolveCrop(els.from.value) && resolveCrop(els.to.value)) runSearch();
  });
  els.swap.addEventListener("click", () => {
    [els.from.value, els.to.value] = [els.to.value, els.from.value];
    if (resolveCrop(els.from.value) && resolveCrop(els.to.value)) runSearch();
  });

  boot();
})();
