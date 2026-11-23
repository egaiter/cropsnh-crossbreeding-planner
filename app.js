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
    typeModal: $("cropTypeModal"),
    typeTitle: $("cropTypeTitle"),
    typeSub: $("cropTypeSub"),
    typeList: $("cropTypeList"),
    typeClose: $("cropTypeClose"),
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
    closeTypeModal(); // any open type list belongs to the previous results
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
    const ing = step.ingredients.map((x) => `<b>${labelHtml(x, step.from)}</b>`).join(" × ");
    const badges = [];
    if (step.kind === "pool") badges.push(`<span class="badge pool">in-world spreading · probabilistic</span>`);
    if (step.machineOnly) badges.push(`<span class="badge machine">crop breeder machine only</span>`);
    if (step.catalysts.length)
      badges.push(`<span class="badge machine">catalyst: ${esc(step.catalysts.map((c) => c.label).join(", "))}</span>`);
    if (step.modGate) badges.push(`<span class="badge mod">requires mods: ${esc(step.modGate.replace(/ && /g, ", "))}</span>`);
    if (step.toPlantable && step.toPlantable.length)
      badges.push(`<span class="badge plantable" title="this crop skips breeding entirely">🌱 output plantable: ${esc(viaText(step.toPlantable))}</span>`);

    const mats = step.ingredients.map((x) => matHtml(x, step.from)).join(", ");
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

  function matHtml(x, from) {
    let chip;
    if (x.plantable) {
      const prefix = x.partnerExample ? `partner e.g. ${esc(x.partnerExample)}: ` : "";
      chip = `<span class="badge plantable" title="plantable directly from an item — no breeding">🌱 ${prefix}${esc(viaText(x.plantVia))}</span>`;
    } else {
      chip = `<span class="badge bred">needs breeding</span>`;
    }
    return `<span class="mat"><b>${labelHtml(x, from)}</b> ${chip}</span>`;
  }

  /**
   * Ingredient label as HTML. In an in-world spreading step the crop-type word
   * ("tendrilly") is a button that opens a browsable list of that type's crops.
   */
  function labelHtml(x, from) {
    if (!x.labelSegments) return esc(x.label);
    return x.labelSegments
      .map((seg) =>
        seg.pool
          ? `<button type="button" class="type-link" data-pool="${esc(seg.pool)}" data-exclude="${esc(from || "")}" ` +
            `title="Show every ${esc(seg.text)} crop">${esc(seg.text)}</button>`
          : esc(seg.text)
      )
      .join("");
  }

  // ------------------------------------------------------- crop-type modal

  let typeModalOpener = null;

  /** List every crop of one spreading pool; `exclude` is the crop being crossed. */
  function openTypeModal(poolName, exclude) {
    const type = window.BreedingEngine.cropsOfType(graph, poolName);
    if (!type) {
      setStatus(`“${poolName}” is not a known crop type.`, true);
      return;
    }
    const pretty = type.label.replace(/_/g, " ");
    els.typeTitle.textContent = pretty.charAt(0).toUpperCase() + pretty.slice(1) + " crops";
    els.typeSub.textContent =
      `${type.members.length} crops of type “${type.lang || type.label}” spread with each other in-world` +
      (exclude ? ` — ${exclude} pairs with any of them but itself.` : ".");
    els.typeList.innerHTML =
      type.members
        .map((m) => {
          const skipped = !!exclude && m.crop === exclude;
          const chip = m.plantVia.length
            ? `<span class="badge plantable" title="plantable directly from an item — no breeding">🌱 ${esc(viaText(m.plantVia))}</span>`
            : "";
          const note = skipped ? `<span class="ct-note">the crop you are crossing</span>` : "";
          return `<li${skipped ? ' class="ct-skip"' : ""}><span class="ct-name">${esc(m.crop)}</span>${chip}${note}</li>`;
        })
        .join("") || `<li class="empty">No crops recorded for this type.</li>`;

    typeModalOpener = document.activeElement;
    els.typeModal.hidden = false;
    document.body.classList.add("modal-open");
    els.typeClose.focus();
  }

  function closeTypeModal() {
    if (els.typeModal.hidden) return;
    els.typeModal.hidden = true;
    document.body.classList.remove("modal-open");
    if (typeModalOpener && document.contains(typeModalOpener)) typeModalOpener.focus();
    typeModalOpener = null;
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

  // crop-type links live inside re-rendered results, so listen once on the document
  document.addEventListener("click", (e) => {
    const target = e.target;
    if (!target || !target.closest) return;
    const link = target.closest(".type-link[data-pool]");
    if (link) {
      e.preventDefault();
      openTypeModal(link.dataset.pool, link.dataset.exclude || null);
      return;
    }
    // click anywhere on the dimmed backdrop (but not inside the dialog) dismisses
    if (!els.typeModal.hidden && (target === els.typeModal || target.closest("#cropTypeClose"))) closeTypeModal();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") return closeTypeModal();
    if (e.key !== "Tab" || els.typeModal.hidden) return;
    // keep Tab inside the dialog: the ✕ button and the scrollable crop list
    const controls = [...els.typeModal.querySelectorAll("button, [href], [tabindex]:not([tabindex='-1'])")];
    if (!controls.length) return;
    const first = controls[0];
    const last = controls[controls.length - 1];
    const active = document.activeElement;
    if (!els.typeModal.contains(active)) {
      e.preventDefault();
      first.focus();
    } else if (e.shiftKey && active === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  });

  boot();
})();
