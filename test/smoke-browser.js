/* Browser smoke test: boots the app from file://, drives the two dropdowns,
 * asserts results render, captures screenshots.
 * Run: PLAYWRIGHT_BROWSERS_PATH=/home/elijah/projects/.tools/pw/browsers node smoke.js */
const { chromium } = require("playwright");
const OUT = process.env.OUT_DIR || require("os").tmpdir() + "/";

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1150, height: 1250 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });

  await page.goto(new URL("../index.html", "file://" + require("fs").realpathSync(require("path").join(__dirname, ".."))).href);
  await page.waitForFunction(() => document.getElementById("footer").textContent.includes("database:"), { timeout: 30000 });

  const optionCount = await page.$$eval("#cropList option", (o) => o.length);
  console.log("footer:", await page.textContent("#footer"));
  console.log("datalist options:", optionCount);
  if (optionCount !== 181) throw new Error("expected 181 datalist options");

  // deterministic search: Poppy -> CobaltOreBerry (has 5 equal shortest routes)
  await page.fill("#fromInput", "Poppy");
  await page.fill("#toInput", "Cobalt"); // partial input -> should resolve case-insensitively
  await page.click("#goBtn");
  await page.waitForSelector("details.path", { timeout: 10000 });
  const n = await page.$$eval("details.path", (d) => d.length);
  console.log("status:", await page.textContent("#status"));
  console.log("paths rendered:", n);
  if (n !== 5) throw new Error("expected 5 paths");
  console.log("step count of path 1:", await page.$$eval("details.path", (ds) => ds[0].querySelectorAll("ol.steps li").length));
  await page.screenshot({ path: OUT + "shot1-deterministic.png", fullPage: true });

  // pool-spreading toggle re-runs automatically: Poppy -> Rubyne should go 1-step
  await page.fill("#fromInput", "Poppy");
  await page.fill("#toInput", "Rubyne");
  await page.click("#goBtn");
  await page.waitForSelector("details.path");
  console.log("det status:", await page.textContent("#status"));
  await page.screenshot({ path: OUT + "shot2-single-path.png", fullPage: true });
  await page.check("#poolsChk");
  await page.waitForFunction(() => document.getElementById("status").textContent.includes("1 breeding step"), { timeout: 10000 });
  console.log("pool status:", await page.textContent("#status"));
  const poolBadge = await page.$eval("details.path", (d) => d.querySelector(".badge.pool") !== null);
  console.log("pool badge shown on expanded path:", poolBadge);
  await page.screenshot({ path: OUT + "shot3-pool.png", fullPage: true });

  // invalid input handling
  await page.fill("#fromInput", "Not A Crop");
  await page.click("#goBtn");
  await page.waitForFunction(() => document.getElementById("status").classList.contains("error"));
  console.log("invalid input ->", await page.textContent("#status"));

  await browser.close();
  if (errors.length) {
    console.error("PAGE ERRORS:\n" + errors.join("\n"));
    process.exit(1);
  }
  console.log("SMOKE TEST PASSED (no page errors)");
})().catch((e) => { console.error(e); process.exit(1); });
