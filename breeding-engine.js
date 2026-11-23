/*
 * CropsNH breeding path engine — pure JS, no DOM, no side effects.
 * Runs in the browser (window.BreedingEngine) and in Node (module.exports).
 *
 * Path semantics: a path is a chain of crosses starting at the source crop.
 * Every step takes one crop already on the chain and breeds it into the next
 * crop; all OTHER parents that mutation requires are listed per step as
 * ingredients to source yourself (world drop, trade, earlier side-chain).
 * Shortest = fewest breeding steps. Ties are prioritized: first by ingredients
 * that must THEMSELVES be bred (fewer is better — crops plantable straight from
 * an item are free), then fewer extra ingredients, then deterministic crosses
 * over probabilistic pool spreading, then non machine-only, then lower id.
 * Steps carry plantability info from the `alternate_seeds` table. An in-world
 * spreading step also names its crop type (`pool`, plus `labelSegments` whose
 * `pool` segment is the type name) so the UI can list every crop of that type
 * with `cropsOfType`.
 */
(function (global) {
  "use strict";

  // ---------------------------------------------------------------- graph load

  /** Build the graph object from an opened sql.js Database. */
  function loadGraph(db) {
    const q = (sql) => {
      const stmt = db.prepare(sql);
      const rows = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      stmt.free();
      return rows;
    };

    const crops = q("SELECT name, mod_gate FROM crops ORDER BY name");
    const mutRows = q("SELECT id, output, machine_only, requirements, mod_gate FROM mutations");
    const parentRows = q("SELECT mutation_id, parent, parent_index FROM mutation_parents ORDER BY mutation_id, parent_index");

    const parentsById = new Map();
    for (const r of parentRows) {
      if (!parentsById.has(r.mutation_id)) parentsById.set(r.mutation_id, []);
      parentsById.get(r.mutation_id).push(r.parent);
    }
    const mutations = mutRows.map((m) => ({
      id: m.id,
      output: m.output,
      machineOnly: !!m.machine_only,
      requirements: m.requirements || null,
      modGate: m.mod_gate || null,
      parents: parentsById.get(m.id) || [],
    }));

    const poolRows = q("SELECT name, lang_value FROM pools ORDER BY name");
    const memberRows = q("SELECT crop, pool FROM crop_pools");
    const membersByPool = new Map();
    for (const r of memberRows) {
      if (!membersByPool.has(r.pool)) membersByPool.set(r.pool, []);
      membersByPool.get(r.pool).push(r.crop);
    }
    const pools = poolRows.map((p) => ({
      name: p.name,
      lang: p.lang_value,
      members: membersByPool.get(p.name) || [],
    }));

    // crops plantable straight from an item, no breeding required
    const plantable = new Map();
    for (const r of q("SELECT crop, item_desc, item_kind, mod_gate FROM alternate_seeds")) {
      if (!plantable.has(r.crop)) plantable.set(r.crop, []);
      plantable.get(r.crop).push({ desc: r.item_desc, kind: r.item_kind, gate: r.mod_gate });
    }

    const meta = {};
    for (const r of q("SELECT key, value FROM meta")) meta[r.key] = r.value;

    const graph = {
      crops: crops.map((c) => c.name),
      cropGate: Object.fromEntries(crops.map((c) => [c.name, c.mod_gate])),
      mutations,
      pools,
      plantable,
      meta,
      _fwdCache: {},
    };
    return graph;
  }

  // ---------------------------------------------------------------- crop types

  /**
   * Every crop that belongs to one spreading pool ("crop type", e.g. TENDRILLY
   * -> "tendrilly"), for the in-world spreading suggestions in the UI.
   * Returns null for an unknown pool. Members are alphabetical and carry the
   * same plantability info as steps do.
   */
  function cropsOfType(graph, poolName) {
    const pool = graph.pools.find((p) => p.name === poolName);
    if (!pool) return null;
    return {
      name: pool.name,
      label: pool.name.toLowerCase(),
      lang: pool.lang,
      members: pool.members
        .slice()
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
        .map((crop) => ({ crop, plantVia: (graph.plantable && graph.plantable.get(crop)) || [] })),
    };
  }

  // ------------------------------------------------------------ forward edges

  /**
   * Directed edges "from parent -> output". Deterministic mutations contribute
   * one edge per parent. Pool spreading (if enabled) contributes, for every
   * pool, an edge from each member to every other member.
   */
  function forwardEdges(graph, usePools) {
    const key = usePools ? "all" : "det";
    if (graph._fwdCache[key]) return graph._fwdCache[key];

    const edges = new Map(); // parent -> [edge]
    const push = (from, edge) => {
      if (!edges.has(from)) edges.set(from, []);
      edges.get(from).push(edge);
    };

    for (const m of graph.mutations) {
      for (const p of m.parents) {
        if (p === m.output) continue; // self edge, shouldn't exist; defensive
        push(p, {
          kind: "mutation",
          from: p,
          to: m.output,
          mutationId: m.id,
          otherParents: m.parents.filter((x) => x !== p),
          machineOnly: m.machineOnly,
          requirements: m.requirements,
          modGate: m.modGate,
        });
      }
    }

    if (usePools) {
      for (const pool of graph.pools) {
        // a pool step's partner is "any other member"; remember whether a
        // directly-plantable member could serve as that partner
        const partnerHint = (a) => pool.members.find((x) => x !== a && graph.plantable.has(x)) || null;
        for (const a of pool.members) {
          const partnerExample = partnerHint(a);
          for (const b of pool.members) {
            if (a === b) continue;
            push(a, {
              kind: "pool",
              from: a,
              to: b,
              pool: pool.name,
              machineOnly: false,
              requirements: null,
              modGate: null,
              partnerExample,
            });
          }
        }
      }
    }
    graph._fwdCache[key] = edges;
    return edges;
  }

  // ------------------------------------------------------------------ search

  /** BFS distances from `start` over forward edges. */
  function bfsDistances(graph, start, usePools) {
    const adj = forwardEdges(graph, usePools);
    const dist = new Map([[start, 0]]);
    const queue = [start];
    for (let head = 0; head < queue.length; head++) {
      const node = queue[head];
      for (const e of adj.get(node) || []) {
        if (!dist.has(e.to)) {
          dist.set(e.to, dist.get(node) + 1);
          queue.push(e.to);
        }
      }
    }
    return dist;
  }

  /**
   * Find up to `maxPaths` shortest paths from start to target.
   * Returns { status: 'ok'|'same'|'unknown'|'unreachable', paths: [...] }.
   */
  function findPaths(graph, start, target, opts) {
    const usePools = !!(opts && opts.usePools);
    const maxPaths = (opts && opts.maxPaths) || 5;
    const sampleCap = 200; // candidate chains kept before ranking
    const visitCap = 50000;

    if (!graph.crops.includes(start) || !graph.crops.includes(target)) return { status: "unknown", paths: [] };
    if (start === target) return { status: "same", paths: [{ steps: [], length: 0, extras: 0, plantableExtras: 0, bredExtras: 0, machineSteps: 0, usesPool: false }] };

    const dist = bfsDistances(graph, start, usePools);
    if (!dist.has(target)) return { status: "unreachable", paths: [] };

    // predecessor edges: those that lie on SOME shortest route (dist strictly decreases by 1)
    const preds = new Map(); // node -> [edge]
    const addPred = (edge) => {
      if (!preds.has(edge.to)) preds.set(edge.to, []);
      const list = preds.get(edge.to);
      for (const p of list) {
        if (p.kind === edge.kind && p.from === edge.from && p.mutationId === edge.mutationId && p.pool === edge.pool) return;
      }
      list.push(edge);
    };
    for (const [, edges] of forwardEdges(graph, usePools)) {
      for (const e of edges) {
        if (dist.has(e.from) && dist.has(e.to) && dist.get(e.from) + 1 === dist.get(e.to)) addPred(e);
      }
    }

    // walk backward from the target along the shortest-route DAG collecting chains
    const sequences = [];
    let visits = 0;
    const walk = (node, acc) => {
      if (sequences.length >= sampleCap || ++visits > visitCap) return;
      if (node === start) {
        sequences.push(acc.slice());
        return;
      }
      for (const e of preds.get(node) || []) {
        acc.push(e);
        walk(e.from, acc);
        acc.pop();
      }
    };
    walk(target, []);

    // group candidate chains by the crop sequence they realize; per consecutive
    // (from -> to) pair keep the best-quality edge
    const bySequence = new Map();
    for (const chain of sequences) {
      // `chain` was accumulated backward (target-side first); rebuild forward order
      const orderedCrops = chain.length
        ? [chain[chain.length - 1].from, ...chain.map((e) => e.to).reverse()]
        : [start];
      const seqKey = orderedCrops.join(">");
      if (!bySequence.has(seqKey)) bySequence.set(seqKey, new Map());
      const edgeChoices = bySequence.get(seqKey);
      for (const e of chain) {
        const k = e.from + "\u2192" + e.to;
        const cur = edgeChoices.get(k);
        if (!cur || edgeQuality(e) < edgeQuality(cur)) edgeChoices.set(k, e);
      }
    }

    const paths = [];
    for (const [seqKey, edgeChoices] of bySequence) {
      const chain = [...edgeChoices.values()];
      chain.sort((a, b) => dist.get(a.from) - dist.get(b.from));
      const steps = chain.map((e) => describeEdge(e, graph));
      const plantableExtras = steps.reduce((n, s) => n + s.ingredients.filter((i) => i.plantable).length, 0);
      const extras = steps.reduce((n, s) => n + s.ingredients.length, 0);
      paths.push({
        crops: seqKey.split(">"),
        steps,
        length: chain.length,
        extras,
        plantableExtras, // ingredients that can be planted straight from an item
        bredExtras: extras - plantableExtras, // ingredients that themselves need breeding
        machineSteps: chain.filter((e) => e.machineOnly).length,
        usesPool: chain.some((e) => e.kind === "pool"),
      });
    }
    paths.sort(
      (a, b) =>
        a.length - b.length ||
        a.bredExtras - b.bredExtras || // prioritize: fewer ingredients you must also breed
        a.extras - b.extras ||
        a.machineSteps - b.machineSteps ||
        a.steps[0].order - b.steps[0].order
    );
    return { status: "ok", paths: paths.slice(0, maxPaths), totalShortest: dist.get(target), candidates: bySequence.size };
  }

  /** Smaller = better choice for a (from -> to) pair. */
  function edgeQuality(e) {
    if (e.kind === "pool") return 1000; // prefer deterministic crosses when both exist
    return (
      (e.otherParents.length + 1) +
      (e.machineOnly ? 40 : 0) +
      (e.requirements ? 20 : 0) +
      e.mutationId / 1e6
    );
  }

  /** Turn an internal edge into a display-ready step (with plantability info). */
  function describeEdge(e, graph) {
    const viaOf = (crop) => (graph && graph.plantable && graph.plantable.get(crop)) || [];
    if (e.kind === "pool") {
      const partnerVia = e.partnerExample ? viaOf(e.partnerExample) : [];
      const typeLabel = e.pool.toLowerCase();
      return {
        from: e.from,
        to: e.to,
        kind: "pool",
        pool: e.pool,
        text: `Let ${e.from} spread with any other ${typeLabel} crop in-world`,
        ingredients: [
          {
            label: `any other ${typeLabel} crop (not ${e.from})`,
            // segments the UI renders in order; the one carrying `pool` is the
            // crop-type name, which the UI turns into a link to that type's crops
            labelSegments: [
              { text: "any other " },
              { text: typeLabel, pool: e.pool },
              { text: ` crop (not ${e.from})` },
            ],
            note: "probabilistic pool spreading",
            plantable: !!e.partnerExample,
            plantVia: partnerVia,
            partnerExample: e.partnerExample,
          },
        ],
        toPlantable: viaOf(e.to),
        machineOnly: false,
        catalysts: [],
        modGate: null,
        order: 500000 + hash31(e.from + e.to),
      };
    }
    return {
      from: e.from,
      to: e.to,
      kind: "mutation",
      mutationId: e.mutationId,
      text: `Cross ${e.from} × ${e.otherParents.join(" × ") || "?"} → ${e.to}`,
      ingredients: e.otherParents.map((p) => ({ label: p, note: null, plantable: graph.plantable.has(p), plantVia: viaOf(p) })),
      toPlantable: viaOf(e.to),
      machineOnly: e.machineOnly,
      catalysts: parseRequirements(e.requirements),
      modGate: e.modGate,
      order: e.mutationId,
    };
  }

  /** Humanize the verbatim-Java requirements column (best effort). */
  function parseRequirements(text) {
    if (!text) return [];
    const out = [];
    let m;
    const oreDict = /addOreDict\(\s*"([^"]+)"\s*,\s*(\d+)\s*\)/g;
    while ((m = oreDict.exec(text))) out.push({ label: `${m[2]}× ${m[1]}`, kind: "catalyst" });
    const item = /addItem\(\s*new ItemStack\(\s*(?:Blocks|Items)\.([A-Za-z0-9_]+)/g;
    while ((m = item.exec(text))) out.push({ label: m[1], kind: "catalyst" });
    if (out.length === 0) out.push({ label: text, kind: "raw" });
    return out;
  }

  function hash31(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
    return Math.abs(h);
  }

  const BreedingEngine = { loadGraph, findPaths, bfsDistances, parseRequirements, cropsOfType };

  if (typeof module !== "undefined" && module.exports) module.exports = BreedingEngine;
  else global.BreedingEngine = BreedingEngine;
})(typeof globalThis !== "undefined" ? globalThis : this);
