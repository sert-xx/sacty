import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, realpathSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron } from "playwright";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const testRoot = mkdtempSync(join(tmpdir(), "sacty-desktop-test-"));
const home = join(testRoot, "home");
const sourceApp = process.env.SACTY_DESKTOP_APP
  ? resolve(process.env.SACTY_DESKTOP_APP, "../../..")
  : join(root, `dist/desktop/sacty-darwin-${process.arch}/sacty.app`);
const relocated = join(testRoot, "sacty.app");
cpSync(sourceApp, relocated, { recursive: true, verbatimSymlinks: true });
const env = { ...process.env, PATH: "/usr/bin:/bin", SACTY_HOME: home };
delete env.ELECTRON_RUN_AS_NODE;
delete env.NODE_PATH;
const runtime = join(relocated, "Contents/Resources/runtime");
const check =
  'import{createRequire}from"node:module";import{realpathSync,existsSync}from"node:fs";import{sep}from"node:path";const r=createRequire(process.cwd()+"/package.json");for(const n of ["@sacty/core","@sacty/daemon/config","@sacty/web/package.json","@sacty/cli/package.json"]){const p=realpathSync(r.resolve(n));if(!p.startsWith(realpathSync(process.cwd())+sep))throw Error("module outside bundle: "+n);}const{DEFAULT_AGENTS_PATH}=await import("@sacty/daemon/config");if(!existsSync(DEFAULT_AGENTS_PATH)||!realpathSync(DEFAULT_AGENTS_PATH).startsWith(realpathSync(process.cwd())+sep))throw Error("missing bundled defaults");console.log("bundled modules and defaults verified");';
console.log(
  execFileSync(join(runtime, "bin/node"), ["--input-type=module", "-e", check], {
    cwd: runtime,
    env,
    encoding: "utf8",
  }).trim(),
);
if (realpathSync(relocated).startsWith(realpathSync(root)))
  throw new Error("Test app must be outside the source repository");
const application = await _electron.launch({
  executablePath: join(relocated, "Contents/MacOS/sacty"),
  cwd: testRoot,
  env,
  timeout: 30_000,
});
try {
  const setup = await application.firstWindow();
  await setup.waitForSelector("#start");
  const invalid = await setup.evaluate(() => window.desktop.saveKey("invalid-key"));
  if (invalid.ok) throw new Error("Invalid API key accepted");
  if (process.env.SACTY_DESKTOP_SCREENSHOTS)
    await setup.screenshot({
      path: resolve(process.env.SACTY_DESKTOP_SCREENSHOTS, "desktop-setup.png"),
      fullPage: true,
    });
  await setup.click("#start");
  let screen;
  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) {
    screen = application.windows().find((page) => page.url().startsWith("http://127.0.0.1:4700"));
    if (screen) break;
    const status = await setup.locator("#status").innerText();
    if (await setup.locator("#start").isEnabled()) throw new Error(status);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!screen) throw new Error("Screen did not open");
  await screen.waitForLoadState("networkidle");
  const capabilities = await screen.evaluate(() => ({
    node: typeof window.require,
    bridge: typeof window.desktop,
  }));
  if (capabilities.node !== "undefined" || capabilities.bridge !== "undefined")
    throw new Error("Unexpected renderer privileges");
  // Observe browser hand-offs without opening real browser tabs during the test.
  await application.evaluate(({ shell }) => {
    globalThis.desktopTestLinks = [];
    shell.openExternal = async (url) => {
      globalThis.desktopTestLinks.push(url);
    };
  });
  const prUrl = "https://github.com/acme/example/pull/1";
  await screen.evaluate((url) => {
    const link = document.createElement("a");
    link.href = url;
    link.target = "_blank";
    link.textContent = "Review test link";
    document.body.append(link);
  }, prUrl);
  await screen.getByRole("link", { name: "Review test link" }).click();
  const linkDeadline = Date.now() + 5000;
  while (
    !(await application.evaluate(() =>
      globalThis.desktopTestLinks.includes("https://github.com/acme/example/pull/1"),
    ))
  ) {
    if (Date.now() > linkDeadline) throw new Error("PR link was not handed to the browser");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await screen.getByRole("link", { name: "Review test link" }).evaluate((link) => link.remove());
  const location = screen.url();
  await screen.evaluate(() => {
    window.location.href = "https://example.com";
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
  if (screen.url() !== location) throw new Error("External navigation was allowed");
  if (!existsSync(join(home, "config.yaml"))) throw new Error("Configuration not created");
  if (process.env.SACTY_DESKTOP_SCREENSHOTS)
    await screen.screenshot({
      path: resolve(process.env.SACTY_DESKTOP_SCREENSHOTS, "desktop-dashboard.png"),
    });
  console.log(
    "PASS: relocated packaged app, bundled modules/defaults/Node.js, new configuration, screen, IPC isolation, external browser hand-off",
  );
} finally {
  await application.close();
}
const listening = await new Promise((resolve) => {
  const socket = createConnection(4700, "127.0.0.1");
  socket.once("connect", () => {
    socket.destroy();
    resolve(true);
  });
  socket.once("error", () => resolve(false));
});
if (listening) throw new Error("Web process survived app shutdown");
console.log("PASS: application shutdown stops the web process");
