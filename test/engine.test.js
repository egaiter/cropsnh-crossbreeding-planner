/*
 * Node test harness for the web app's engine — exercises the exact files the
 * browser loads (vendor/sql-wasm.js, data.js, breeding-engine.js).
 * Run: node web/test/engine.test.js
 */
"use strict";

const initSqlJs = require("../vendor/sql-wasm.js");
require("../data.js");
const engine = require("../breeding-engine.js");

let failures = 0;
let graph = null;
function assert(cond, msg) {
  if (!cond) {
    failures++;
    console.error("  FAIL:", msg);
  }
}

function checkPathShape(res, start, target, label) {
  for (const [i, p] of res.paths.entries()) {
    const why = `${label} path ${i + 1}`;
    assert(p.crops[0] === start, `${why}: starts at ${p.crops[0]} not ${start}`);
    assert(p.crops[p.crops.length - 1] === target, `${why}: ends at ${last(p.crops)} not ${target}`);
    assert(p.steps.length === p.length && p.length === res.totalShortest, `${why}: length mismatch`);
    for (const [j, s] of p.steps.entries()) {
      assert(s.from === p.crops[j] && s.to === p.crops[j + 1], `${why}: step ${j + 1} ${s.from}->${s.to} breaks chain`);
      assert(graph.mutations.some((m) => m.id === s.mutationId) || s.kind === "pool", `${why}: step ${j + 1} bad mutation ref`);
      assert(Array.isArray(s.toPlantable) && Array.isArray(s.ingredients), `${why}: step ${j + 1} missing plantability info`);
      for (const ing of s.ingredients) {
        assert(typeof ing.plantable === "boolean" && Array.isArray(ing.plantVia), `${why}: step ${j + 1} ingredient ${ing.label} plantability malformed`);
        assert(!ing.plantable || ing.plantVia.length > 0, `${why}: step ${j + 1} ingredient ${ing.label} plantable without any item`);
      }
    }
    assert(p.plantableExtras + p.bredExtras === p.extras, `${why}: plantableExtras + bredExtras != extras`);
  }
  assert(res.paths.length <= 5, `${label}: more than 5 paths returned`);
}
const last = (a) => a[a.length - 1];

async function main() {
  const SQL = await initSqlJs({
    wasmBinary: Uint8Array.from(atob(globalThis.CROPSNH_DATA.wasmBase64), (c) => c.charCodeAt(0)),
  });
  const db = new SQL.Database(Uint8Array.from(atob(globalThis.CROPSNH_DATA.dbBase64), (c) => c.charCodeAt(0)));
  globalThis.__graph = engine.loadGraph(db);
  graph = globalThis.__graph;
  console.log(`graph loaded: ${graph.crops.length} crops, ${graph.mutations.length} mutations, ${graph.pools.length} pools, meta.commit=${(graph.meta.source_commit || "").slice(0, 8)}`);
  assert(graph.crops.length === 181, "crop count");
  assert(graph.mutations.length === 172, "mutation count");

  let res;

  console.log("\n[1] Wheat -> Rubyne (deterministic)");
  res = engine.findPaths(graph, "Wheat", "Rubyne", { usePools: false });
  assert(res.status === "ok" && res.paths.length >= 1, "expected at least one deterministic path");
  checkPathShape(res, "Wheat", "Rubyne", "Wheat->Rubyne");
  for (const p of res.paths) console.log(`  ${p.crops.join(" → ")}  (${p.length} steps, extras=${p.extras}${p.machineSteps ? ", machine=" + p.machineSteps : ""})`);

  console.log("\n[2] Poppy -> Blueberry (deterministic)");
  res = engine.findPaths(graph, "Poppy", "Blueberry", {});
  assert(res.status === "ok", "path should exist");
  checkPathShape(res, "Poppy", "Blueberry", "Poppy->Blueberry");
  for (const p of res.paths) console.log(`  ${p.crops.join(" → ")}  (${p.length} steps)`);

  console.log("\n[3] Poppy -> Rubyne (pools on: should be a 1-step RED pool spread)");
  res = engine.findPaths(graph, "Poppy", "Rubyne", { usePools: true });
  assert(res.status === "ok" && res.paths[0].length === 1 && res.paths[0].usesPool, "expected 1-step pool path");
  console.log(`  shortest: ${res.paths[0].steps[0].text}`);

  console.log("\n[4] edge cases");
  assert(engine.findPaths(graph, "Wheat", "NotACrop", {}).status === "unknown", "unknown target");
  assert(engine.findPaths(graph, "bogus", "Rubyne", {}).status === "unknown", "unknown start");
  assert(engine.findPaths(graph, "Rubyne", "Rubyne", {}).status === "same", "same crop");
  res = engine.findPaths(graph, "Weed", "Rubyne", {});
  assert(res.status === "unreachable", "Weed has no outgoing edges -> unreachable");
  console.log("  Weed -> Rubyne unreachable:", res.status === "unreachable", "| unknown crop handled | same-crop handled");

  console.log("\n[5] Blueberry -> StarWart (deep, machine-gated chain)");
  res = engine.findPaths(graph, "Blueberry", "StarWart", {});
  assert(res.status === "ok", "deep path should exist");
  checkPathShape(res, "Blueberry", "StarWart", "Blueberry->StarWart");
  for (const p of res.paths.slice(0, 3)) console.log(`  ${p.crops.join(" → ")}  (${p.length} steps, machine=${p.machineSteps})`);

  console.log("\n[6] maxPaths cap: Poppy -> CobaltOreBerry (deterministic, many equal routes)");
  const t0 = Date.now();
  res = engine.findPaths(graph, "Poppy", "CobaltOreBerry", { maxPaths: 5 });
  const ms = Date.now() - t0;
  assert(res.status === "ok" && res.paths.length === 5, "expected exactly the 5-path cap");
  assert(res.paths.every((p) => p.length === res.totalShortest), "all returned paths share the shortest length");
  assert(new Set(res.paths.map((p) => p.crops.join(">"))).size === 5, "paths must be distinct");
  checkPathShape(res, "Poppy", "CobaltOreBerry", "Poppy->CobaltOreBerry");
  for (const p of res.paths) console.log(`  ${p.crops.join(" → ")}`);
  console.log(`  cap respected, all ${res.totalShortest} steps, ${ms} ms`);

  console.log("\n[7] pools on perf (busiest pair)");
  const t1 = Date.now();
  res = engine.findPaths(graph, "Wheat", "Auronia", { usePools: true });
  assert(res.status === "ok" && res.paths[0].length === res.totalShortest, "pool search sane");
  console.log(`  Wheat -> Auronia: ${res.totalShortest} step(s), ${Date.now() - t1} ms with pool edges enabled`);

  console.log("\n[8] plantable-from-item data (alternate_seeds)");
  const via = (c) => (graph.plantable.get(c) || []).map((v) => v.desc);
  assert(graph.plantable.size >= 90, `expected ~90+ plantable crops, got ${graph.plantable.size}`);
  assert(JSON.stringify(via("Wheat")) === '["minecraft:wheat_seeds"]', `Wheat via ${via("Wheat")}`);
  assert(JSON.stringify(via("Poppy")) === '["minecraft:red_flower"]', `Poppy via ${via("Poppy")}`);
  assert(JSON.stringify(via("BonsaiOak")) === '["minecraft:sapling"]', `BonsaiOak via ${via("BonsaiOak")}`);
  assert(JSON.stringify(via("BonsaiDarkOak")) === '["minecraft:sapling:5"]', `BonsaiDarkOak via ${via("BonsaiDarkOak")} (ctor-chain meta)`);
  assert(JSON.stringify(via("BonsaiSlimy")) === '["TinkerConstruct:slime.sapling"]', `BonsaiSlimy via ${via("BonsaiSlimy")} (super chain)`);
  const moss = graph.plantable.get("Moss") || [];
  assert(moss.length === 3 && moss.some((m) => m.gate === "TwilightForest") && moss.some((m) => m.gate === "BiomesOPlenty"), `Moss gated items: ${JSON.stringify(moss)}`);
  assert(via("Coffee").includes("cropCoffee"), `Coffee oredict via ${via("Coffee")}`);
  assert(!graph.plantable.has("StoneLily"), "StoneLily must NOT be plantable (breeding only)");
  assert(graph.plantable.has("GaiaWart") && !graph.pools.some((p) => p.members.includes("GaiaWart")), "GaiaWart: plantable but never bred");
  assert(!via("Cinderpearl").some((d) => d.startsWith("raw")), `Cinderpearl resolved: ${via("Cinderpearl")}`);
  console.log(`  ${graph.plantable.size} plantable crops; e.g. Wheat<-${via("Wheat")}, BonsaiDarkOak<-${via("BonsaiDarkOak")}, Cinderpearl<-${via("Cinderpearl")}`);

  console.log("\n[9] prioritization: fewer bred ingredients ranks first");
  res = engine.findPaths(graph, "Poppy", "CobaltOreBerry", { maxPaths: 5 });
  const bred = res.paths.map((p) => p.bredExtras);
  assert(bred.every((v, i) => i === 0 || bred[i - 1] <= v), `bredExtras must be non-decreasing: ${bred}`);
  for (const p of res.paths)
    console.log(`  ${p.crops.join(" → ")}  bredExtras=${p.bredExtras}/${p.extras} plantableExtras=${p.plantableExtras}`);
  const p1 = res.paths[0];
  const plantableIng = p1.steps.flatMap((s) => s.ingredients).filter((i) => i.plantable && !i.partnerExample);
  assert(plantableIng.length === p1.plantableExtras, "step-level plantable count must match path-level");
  assert(plantableIng.every((i) => graph.plantable.has(i.label)), "ingredient flagged plantable must exist in alternate_seeds");

  console.log(failures === 0 ? "\nALL TESTS PASSED" : `\n${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
