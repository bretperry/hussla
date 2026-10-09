/*
  Browser evidence for the UI: screenshots at 1280 and 390, console and scroll checks, and the front page's grid checks.
  In the app: nothing at runtime (it lives in src/test so it may import the fixtures); run it by hand (`pnpm ui:evidence`) before a UI PR. Not part of `pnpm check` because it needs Chromium.
  Used by: package.json (ui:evidence), the Phase 5 PR description.
  Uses: playwright-core with the Chromium at /opt/pw-browsers/chromium (never `playwright install`), src/test/fixture-server.mjs.

  Exit 0 only when every check passed. Checks:
  - no console errors, no failed requests, and no horizontal scroll, on every page at both widths;
  - front page at 1280: the lead and rail columns end within 4px of each other, and every section's rule starts on a column
    start and ends on a column end of the front page's 12 x 52px grid (64px margins, 48px gutters), within 1px;
  - the three front page states (day one, nothing to sign, no lead story) show what the spec says;
  - the billboard: every pitch (the longest the server allows included) fits its fixed box at both widths, turning to the
    next one never moves the page, and under prefers-reduced-motion the switch draws no outgoing layer.

  UI_EVIDENCE_OUT=<dir> writes the screenshots there instead of docs/screenshots/phase-5.
*/
// oxlint-disable eslint/no-console -- a command-line report; the console is its output
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { startFixtureServer } from "./fixture-server.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const outDir = process.env.UI_EVIDENCE_OUT ?? join(root, "docs", "screenshots", "phase-5");
const CHROMIUM = process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium";

// The front page grid at 1280: 64px margin, 12 columns of 52px, 48px gutters.
const MARGIN = 64;
const COLUMN = 52;
const GUTTER = 48;
const GRID_TOLERANCE = 1;
const COLUMN_END_TOLERANCE = 4;

const PAGES = [
  ["front", "/"],
  ["jobs", "/jobs"],
  ["job", "/jobs/northwind-staff-engineer-platform"],
  ["companies", "/companies"],
  ["compare", "/companies/compare?c=northwind-labs,fabrikam-cloud,contoso-payments"],
  ["company", "/companies/northwind-labs"],
  ["outbox", "/outbox"],
  ["answers", "/answers"],
  ["activity", "/activity"],
  ["settings", "/settings"],
  ["pitches", "/pitches?slot=1"],
];

const failures = [];
const check = (ok, message) => {
  if (!ok) failures.push(message);
  console.log(`${ok ? "ok  " : "FAIL"} ${message}`);
};

const build = spawnSync("pnpm", ["exec", "vite", "build"], { cwd: root, stdio: "inherit" });
if (build.status !== 0) process.exit(build.status ?? 1);
mkdirSync(outDir, { recursive: true });

const fixture = await startFixtureServer({ distDir: join(root, "dist") });
const browser = await chromium.launch({ executablePath: CHROMIUM, args: ["--no-sandbox"] });

const open = async (width, path, label) => {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  const problems = [];
  page.on("console", (message) => message.type() === "error" && problems.push(`console: ${message.text()}`));
  page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
  page.on("response", (response) => response.status() >= 400 && problems.push(`HTTP ${response.status()} ${response.url()}`));
  await page.goto(fixture.origin + path, { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  const scroll = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth }));
  check(problems.length === 0, `${label}: no console errors or failed requests ${problems.join(" | ")}`);
  check(scroll.scrollWidth <= scroll.innerWidth, `${label}: no horizontal scroll (${scroll.scrollWidth} <= ${scroll.innerWidth})`);
  return page;
};

for (const width of [1280, 390]) {
  for (const [name, path] of PAGES) {
    const page = await open(width, path, `${name} @${width}`);
    await page.screenshot({ path: join(outDir, `${name}-${width}.png`), fullPage: true });
    await page.close();
  }
}

// Front page grid checks at exactly 1280.
const front = await open(1280, "/", "front grid");
const geometry = await front.evaluate(() => {
  // Defined inside evaluate on purpose: the function is serialized into the page, so it cannot live at module scope.
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- runs in the browser
  const box = (element) => {
    const rect = element.getBoundingClientRect();
    return { left: rect.left, right: rect.right, bottom: rect.bottom + scrollY };
  };
  const groupBottom = (name) => Math.max(...[...document.querySelectorAll(`[data-col="${name}"]`)].map((element) => box(element).bottom));
  const lastContentBottom = (name) => {
    const cells = [...document.querySelectorAll(`[data-col="${name}"]`)];
    const leaf = cells.at(-1)?.querySelector(":scope > :last-child, :scope > div > :last-child") ?? null;
    return leaf === null ? null : box(leaf).bottom;
  };
  return {
    leadBottom: groupBottom("lead"),
    railBottom: groupBottom("rail"),
    leadContentBottom: lastContentBottom("lead"),
    railContentBottom: lastContentBottom("rail"),
    edges: [...document.querySelectorAll("[data-grid-edge]")].map((element) => ({ text: element.textContent, ...box(element) })),
  };
});
check(Math.abs(geometry.leadBottom - geometry.railBottom) <= COLUMN_END_TOLERANCE, `front: lead and rail columns end within ${COLUMN_END_TOLERANCE}px (${Math.round(geometry.leadBottom)} vs ${Math.round(geometry.railBottom)})`);
if (geometry.leadContentBottom !== null && geometry.railContentBottom !== null) {
  check(Math.abs(geometry.leadContentBottom - geometry.railContentBottom) <= COLUMN_END_TOLERANCE + 40, `front: the last lines of both columns sit near the shared bottom (${Math.round(geometry.leadContentBottom)} vs ${Math.round(geometry.railContentBottom)})`);
}
const starts = Array.from({ length: 12 }, (_, index) => MARGIN + index * (COLUMN + GUTTER));
const ends = starts.map((start) => start + COLUMN);
const near = (value, list) => list.some((candidate) => Math.abs(candidate - value) <= GRID_TOLERANCE);
// Lead, fact box, pitch, news and board; the briefing sits in the section bar and has no 2px rule.
check(geometry.edges.length >= 5, `front: ${geometry.edges.length} section rules found`);
for (const edge of geometry.edges) {
  check(near(edge.left, starts), `front: "${edge.text.slice(0, 28)}" starts on a column (${edge.left.toFixed(1)})`);
  check(near(edge.right, ends), `front: "${edge.text.slice(0, 28)}" ends on a column (${edge.right.toFixed(1)})`);
}
await front.close();

// The billboard at both widths: each pitch fits the box, and a turn never moves what sits below it.
for (const width of [1280, 390]) {
  const page = await open(width, "/", `billboard @${width}`);
  const billboard = page.getByRole("region", { name: "Pitch of the hour" });
  const measure = () =>
    page.evaluate(() => {
      const box = document.querySelector('[data-billboard="current"]')?.parentElement;
      const section = document.querySelector('[aria-label="Pitch of the hour"]');
      const news = document.querySelector('[aria-label="Latest news"]');
      return {
        overflow: box === null || box === undefined ? 1 : box.scrollHeight - box.clientHeight,
        height: box?.getBoundingClientRect().height ?? 0,
        sectionHeight: section?.getBoundingClientRect().height ?? 0,
        newsTop: (news?.getBoundingClientRect().top ?? 0) + scrollY,
        text: document.querySelector('[data-billboard="current"]')?.textContent.length ?? 0,
      };
    });
  const first = await measure();
  let longest = first.text;
  for (let turn = 0; turn < 4; turn += 1) {
    const now = await measure();
    longest = Math.max(longest, now.text);
    check(now.overflow <= 0, `billboard @${width}: a ${now.text}-character pitch fits its box (overflow ${now.overflow}px)`);
    check(now.height === first.height && now.sectionHeight === first.sectionHeight && now.newsTop === first.newsTop, `billboard @${width}: the box, its section and the news below stay put (${now.height} / ${now.sectionHeight} / ${Math.round(now.newsTop)})`);
    await billboard.getByRole("button", { name: "Next pitch" }).click();
    await page.mouse.move(0, 0); // leave the billboard so it isn't paused for the next measure
    await page.waitForTimeout(1000); // the 900ms cross-fade
  }
  check(longest >= 400, `billboard @${width}: the longest fixture pitch (${longest} characters with quotes) was among those measured`);
  await billboard.scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(outDir, `billboard-${width}.png`), fullPage: true });
  await page.close();
}
{
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
  const page = await context.newPage();
  await page.goto(fixture.origin + "/", { waitUntil: "networkidle" });
  const billboard = page.getByRole("region", { name: "Pitch of the hour" });
  await billboard.getByRole("button", { name: "Next pitch" }).click();
  check((await page.locator('[data-billboard="leaving"]').count()) === 0, "billboard, reduced motion: the switch draws no outgoing pitch");
  await context.close();
}
{
  const page = await open(1280, "/pitches?slot=1", "pitches compare");
  check((await page.getByRole("region", { name: "Compare versions" }).count()) === 1, "pitches: the open pitch shows the compare view");
  check((await page.locator("[data-side=after] ins").count()) > 0, "pitches: the compare view marks added words");
  await page.close();
}

// The three states from the spec.
fixture.state.mode = "empty";
const dayOne = await open(1280, "/", "day one");
// Visible only: the phone briefing is in the page too, hidden by CSS at this width.
check((await dayOne.locator("text=Nothing to sign").filter({ visible: true }).count()) === 1 && (await dayOne.locator("text=Review & sign").count()) === 0, "day one: the briefing says nothing to sign, with no button");
check((await dayOne.locator("text=Your first story starts with one job").count()) === 1, "day one: the lead story invites the first job");
check((await dayOne.locator("text=at a glance").count()) === 0, "day one: no fact box");
check((await dayOne.locator("text=Your pitches will rotate here").count()) === 1, "day one: the pitch slot says pitches will rotate here");
await dayOne.screenshot({ path: join(outDir, "front-day-one-1280.png"), fullPage: true });
await dayOne.close();

fixture.state.mode = "nothing-to-sign";
const quiet = await open(1280, "/", "nothing to sign");
check((await quiet.locator("text=Nothing to sign").filter({ visible: true }).count()) === 1 && (await quiet.getByRole("link", { name: "Review & sign" }).count()) === 0, "nothing to sign: the briefing says so, no button");
await quiet.close();

fixture.state.mode = "no-lead";
const noLead = await open(1280, "/", "no lead story");
check((await noLead.locator("text=at a glance").count()) === 0, "no lead story: the fact box is hidden");
check((await noLead.locator("h1").innerText()).includes("first story"), "no lead story: the lead slot shows the empty story");
await noLead.screenshot({ path: join(outDir, "front-no-lead-1280.png"), fullPage: true });
await noLead.close();

await browser.close();
await fixture.close();
console.log(failures.length === 0 ? "\nAll UI checks passed." : `\n${failures.length} UI check(s) failed.`);
process.exit(failures.length === 0 ? 0 : 1);
