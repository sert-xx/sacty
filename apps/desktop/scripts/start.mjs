import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const electron = require("electron");
const root = fileURLToPath(new URL("../../../", import.meta.url));
const env = { ...process.env, SACTY_NODE: process.execPath };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, ["apps/desktop"], { cwd: root, env, stdio: "inherit" });
child.once("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.once("exit", (code) => {
  process.exitCode = code ?? 1;
});
