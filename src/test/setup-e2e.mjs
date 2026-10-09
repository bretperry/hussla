/*
  End-to-end first run in a real browser against the e2e image: home page, fake Tailscale sign-in, Start over, "Make it mine", the wizard, a restart, the app.
  In the app: nothing at runtime; Phase 6's browser Done-when (`pnpm e2e:setup` after `docker build --target e2e -t hussla:e2e .`). Not in `pnpm check`: it needs Docker and Chromium.
  Used by: package.json (e2e:setup), the Phase 6 PR description.
  Uses: docker, playwright-core with the Chromium at /opt/pw-browsers/chromium, a CDP virtual authenticator (no real passkey), the image's fake Tailscale.

  Fixed ports (19484 home page, 19443 "tailnet", 19445 fake login) are a machine-wide resource: the
  run takes a lock directory and exits 75 if another run holds it. The container and its volume are
  this run's own (hussla-e2e-<pid>) and are removed at exit. Screenshots go to docs/screenshots/phase-6.
*/
// oxlint-disable eslint/no-console -- a command-line report; the console is its output
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const shots = join(root, "docs", "screenshots", "phase-6");
const CHROMIUM = process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium";
const IMAGE = process.env.HUSSLA_E2E_IMAGE ?? "hussla:e2e";
const NAME = `hussla-e2e-${process.pid}`;
const PORTS = { home: 19484, tailnet: 19443, login: 19445 };
const HOME = `http://localhost:${PORTS.home}`;

const docker = (...args) => execFileSync("docker", args, { encoding: "utf8" }).trim();

const start = () =>
  docker(
    "run", "-d", "--name", NAME, "-v", `${NAME}:/data`,
    "-p", `${PORTS.home}:8484`, "-p", `${PORTS.tailnet}:${PORTS.tailnet}`, "-p", `${PORTS.login}:${PORTS.login}`,
    "-e", `HUSSLA_FAKE_TAILNET_PORT=${PORTS.tailnet}`, "-e", `HUSSLA_FAKE_TAILNET_LOGIN_PORT=${PORTS.login}`,
    IMAGE,
  );

// A lock directory: mkdir is atomic, so only one run gets it.
const lock = join(tmpdir(), "hussla-setup-e2e.lock");
try {
  mkdirSync(lock);
} catch {
  console.error("setup-e2e: another run holds the ports (lock held); try again later");
  process.exit(75);
}

const cleanup = () => {
  spawnSync("docker", ["rm", "-f", NAME], { stdio: "ignore" });
  // The run's own throwaway volume.
  spawnSync("docker", ["volume", "rm", NAME], { stdio: "ignore" });
  rmSync(lock, { recursive: true, force: true });
};

const failures = [];
const check = (ok, message) => {
  if (!ok) failures.push(message);
  console.log(`${ok ? "ok  " : "FAIL"} ${message}`);
};

let browser;
try {
  mkdirSync(shots, { recursive: true });
  start();
  browser = await chromium.launch({ executablePath: CHROMIUM });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  const errors = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`${message.text()} (${message.location().url})`);
  });

  // 1. The home-network page on a fresh volume: only the Tailscale step.
  await page.goto(HOME, { waitUntil: "domcontentloaded" }).catch(() => undefined);
  await page.waitForSelector("#connect", { timeout: 30_000 });
  await page.screenshot({ path: join(shots, "home-connect-390.png"), fullPage: true });
  check(!(await page.content()).toLowerCase().includes("setup code"), "the fresh home page shows no setup code");

  // 2. The sign-in link (the fake's login page), then back: the page moves on by itself.
  const loginHref = await page.locator("#connect").getAttribute("href");
  check(loginHref?.includes(`:${PORTS.login}/login`) === true, `the page links to the Tailscale login (${loginHref})`);
  await page.goto(loginHref ?? "", { waitUntil: "domcontentloaded" });
  await page.goto(HOME, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#make-it-mine", { timeout: 30_000 });
  check(!(await page.content()).includes("link="), "the home page's GET holds no first-run link");

  // The page's own forms, posted by the browser itself: each one is refused unless Chromium sends
  // this page's Origin, which a Referrer-Policy of no-referrer turns into "null" (PR #13's blocker).
  const homeReply = await page.request.get(HOME);
  check(homeReply.headers()["referrer-policy"] === "same-origin", `the home page's Referrer-Policy is same-origin (${homeReply.headers()["referrer-policy"]})`);
  const formPost = async (selector, path) => {
    const [request] = await Promise.all([
      page.waitForRequest((sent) => sent.method() === "POST" && new URL(sent.url()).pathname === path, { timeout: 15_000 }),
      page.locator(selector).click(),
    ]);
    const reply = await request.response();
    check(request.headers().origin === HOME, `the browser's POST ${path} carries this page's Origin (${request.headers().origin})`);
    check(reply?.status() === 303, `POST ${path} from the page answers 303 (${reply?.status()})`);
  };

  // 2b. Start over (a real form POST), then the same person signs in again: a fresh window opens.
  await formPost("#start-over", "/start-over");
  await page.waitForSelector("#connect", { timeout: 30_000 });
  await page.goto((await page.locator("#connect").getAttribute("href")) ?? "", { waitUntil: "domcontentloaded" });
  await page.goto(HOME, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#make-it-mine", { timeout: 30_000 });
  check(true, "after Start over and a new sign-in, Make it mine is back");
  await page.screenshot({ path: join(shots, "home-make-it-mine-390.png"), fullPage: true });

  // 3. "Make it mine" (a form POST that redirects to the one-use link) with a virtual authenticator standing in for Face ID.
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
  await Promise.all([page.waitForURL(/\/setup\?link=/, { timeout: 15_000 }), formPost("#make-it-mine", "/make-it-mine")]);
  check(true, "the button's POST sends the browser to the first-run link");
  await page.getByRole("button", { name: "Make it mine" }).click();
  await page.getByText(/Step 2 of 7/).waitFor({ timeout: 15_000 });
  check(true, "the first passkey was made from the link; the wizard is at step 2");
  await page.screenshot({ path: join(shots, "wizard-mail-390.png"), fullPage: true });

  // 4. Skip one step, restart the container, and the wizard picks up at step 3.
  await page.getByRole("button", { name: "Skip this step" }).click();
  await page.getByText(/Step 3 of 7/).waitFor({ timeout: 10_000 });
  docker("restart", NAME);
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const reply = await page.request.get(`http://localhost:${PORTS.tailnet}/api/setup`).catch(() => null);
    if (reply?.ok() === true) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByText(/Step 3 of 7/).waitFor({ timeout: 15_000 });
  check(true, "a restart keeps the wizard's progress");

  // 5. Skip the rest: the app opens, and stays open on a reload.
  await page.getByRole("button", { name: "Skip the rest" }).click();
  await page.getByRole("navigation", { name: "Sections" }).waitFor({ timeout: 15_000 });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("navigation", { name: "Sections" }).waitFor({ timeout: 15_000 });
  check(true, "after the wizard the app opens");
  await page.screenshot({ path: join(shots, "app-after-setup-390.png"), fullPage: true });

  // 6. The home page now says it's ready, with neither the first-run link nor Start over (a passkey exists).
  await page.goto(HOME, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#address", { timeout: 15_000 });
  check((await page.locator("#make-it-mine, #start-over").count()) === 0, "the first-run link and Start over are gone once a passkey exists");
  await page.screenshot({ path: join(shots, "home-ready-390.png"), fullPage: true });

  check(errors.length === 0, `no console errors${errors.length === 0 ? "" : `: ${errors.join(" | ")}`}`);
} catch (error) {
  failures.push(String(error));
  console.log(`FAIL ${String(error)}`);
  console.log(spawnSync("docker", ["logs", NAME], { encoding: "utf8" }).stderr.split("\n").slice(-25).join("\n"));
} finally {
  await browser?.close();
  cleanup();
}

console.log(failures.length === 0 ? "setup-e2e: all passed" : `setup-e2e: ${failures.length} failed`);
process.exit(failures.length === 0 ? 0 : 1);
