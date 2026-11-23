# CropsNH Breeding Path Finder — static web app

Single-page app over [`cropsnh_breeding.db`](../cropsnh_breeding.db). **No backend and
no network access are required at runtime.** The SQLite database and the sql.js wasm
binary are embedded in [`data.js`](data.js); the browser runs real SQL against the real
database file and does all pathfinding client-side.

## Run it

Open `index.html` directly in a browser (`file://` works — nothing is fetched), or, if
you prefer a normal origin:

```sh
python3 -m http.server 8000 --directory web
# → http://localhost:8000/
```

Pick a start and a target crop from the autocompleting dropdowns, hit **Find paths**.
The app shows up to 5 shortest breeding chains; expand any path for the step-by-step
crosses, extra ingredients to source, machine-only/catalyst/mod-gate badges, and
probabilistic pool-spreading routes (**enabled by default** — untick the checkbox to
restrict results to deterministic crosses only).

Ingredients (and outputs) that are **plantable directly from an item — no breeding
required** are marked with a 🌱 badge showing the item (e.g. `minecraft:wheat_seeds`,
oreDict `cropTomato`, `Thaumcraft:blockCustomPlant:3`); ingredients that themselves
need breeding are flagged "needs breeding". Tied-shortest paths are **prioritized so
fewer ingredients still need breeding**, and each path header summarizes the ratio
(e.g. "3/6 ingredients plantable"). Data comes from the `alternate_seeds` table,
parsed from every `CropCard` constructor's `addAlternateSeed(...)` calls.

An in-world spreading suggestion names the crop **type** it spreads with — "any other
`tendrilly` crop", underlined as a link. Click the type name to open a modal listing
every crop of that type, alphabetically, each with its 🌱 plantable item when it has
one. The crop being crossed is listed but greyed out — a pool partner must be a
different crop. The modal dismisses with the ✕ button, by clicking the dimmed area
outside it, or with `Esc`.

## Files

| File | Role |
|---|---|
| `index.html` | page shell + styles |
| `app.js` | DOM wiring only |
| `breeding-engine.js` | pure pathfinding logic (also unit-tested in Node) |
| `data.js` | **generated**: base64 of `cropsnh_breeding.db` + `vendor/sql-wasm.wasm` |
| `vendor/sql-wasm.js` / `.wasm` | vendored sql.js 1.13.0 |
| `test/engine.test.js` | Node harness exercising the browser's own files against the embedded DB |
| `test/smoke-jsdom.js` | drives the real page under jsdom, including the crop-type modal |

## Path semantics

A path chains crosses: each step breeds one crop already on the chain into the next;
any other parents the mutation needs are listed per step as ingredients to source.
Shortest = fewest steps; ties are prioritized by ingredients that must themselves be
bred (fewer is better — 🌱 plantable items are free), then fewer extra ingredients,
deterministic crosses over pool spreading, non-machine-only, lower id. Pool spreading
(two distinct crops sharing a pool → any other pool member) is on by default; untick
"include probabilistic in-world pool spreading" to exclude those edges.

## Tests

```sh
node web/test/engine.test.js                              # engine + embedded data, zero dependencies

npm i --prefix ../.tmp-run/jsdom-env jsdom@26             # jsdom stays outside the project (v31 dropped ResourceLoader)
NODE_PATH=../.tmp-run/jsdom-env/node_modules node web/test/smoke-jsdom.js
```

The jsdom harness boots the real `index.html` against the embedded database and drives
it: form search, path rendering/expansion, plantable badges, the pools toggle, and the
crop-type modal (open, ✕, outside click, `Esc`).

## Regenerating after database changes

```sh
python3 tools/build_breeding_db.py    # rebuild the SQLite graph from the Java sources
python3 tools/build_web_data.py       # re-embed db + wasm into web/data.js
node web/test/engine.test.js          # sanity-check engine + embedded data
```
