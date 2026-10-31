const { spawn, execFile } = require("node:child_process");
const { existsSync, readFileSync } = require("node:fs");
const { join, dirname, delimiter } = require("node:path");
const { homedir } = require("node:os");
const { promisify } = require("node:util");
const { text } = require("./messages.cjs");

const exec = promisify(execFile);

function runtimePaths(resources, developmentRoot, locale = "ja") {
  const root = resources ? join(resources, "runtime") : developmentRoot;
  const node = resources ? join(root, "bin", "node") : process.env.SACTY_NODE;
  if (!node || !existsSync(node)) throw new Error(text(locale, "nodeMissing"));
  return {
    root,
    node,
    cli: join(root, "packages/cli/bin/sacty.js"),
    imageArchive: join(root, "agent-image.tar.gz"),
    imageManifest: join(root, "desktop-manifest.json"),
    configTool: join(root, resources ? "desktop/config-tool.mjs" : "apps/desktop/config-tool.mjs"),
    env: {
      ...process.env,
      PATH: [
        dirname(node),
        process.env.PATH,
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/usr/bin",
        "/bin",
        "/usr/sbin",
        "/sbin",
        "/Applications/Docker.app/Contents/Resources/bin",
      ]
        .filter(Boolean)
        .join(delimiter),
    },
  };
}

function redact(text) {
  return text
    .replace(/(token=)[A-Za-z0-9_-]+/g, "$1[REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]+\b/g, "[REDACTED]");
}

// A printed URL is not evidence that Next.js is ready yet. Bound the entire wait.
async function waitForScreen(
  child,
  { timeout = 60_000, request = fetch, onLog = () => {}, locale = "ja" } = {},
) {
  let url;
  let buffer = "";
  let ended = false;
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), timeout);
  const onData = (chunk) => {
    buffer = (buffer + chunk.toString()).slice(-16_384);
    const match = buffer.match(/http:\/\/127\.0\.0\.1:4700\/auth\?token=[A-Za-z0-9_-]+(?=\s)/);
    if (match) url = match[0];
    onLog(redact(chunk.toString()));
  };
  const onExit = () => {
    ended = true;
    controller.abort();
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  child.once("exit", onExit);
  child.once("error", onExit);
  try {
    while (!controller.signal.aborted) {
      if (url) {
        try {
          // Do not follow the auth redirect here: Electron must receive the cookie itself.
          const response = await request(url, { redirect: "manual", signal: controller.signal });
          await response.body?.cancel();
          if ([200, 302, 303, 307, 308].includes(response.status)) return url;
        } catch {
          // The web process may still be starting.
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(text(locale, ended ? "startFailed" : "timeout"));
  } finally {
    clearTimeout(deadline);
    controller.abort();
    child.stdout.off("data", onData);
    child.stderr.off("data", onData);
    child.off("exit", onExit);
    child.off("error", onExit);
  }
}

async function stopChild(child) {
  if (!child || child.pid === undefined || child.exitCode !== null || child.signalCode !== null)
    return;
  await new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      child.off("exit", done);
      child.off("close", done);
      resolve();
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      done();
    }, 35_000);
    child.once("exit", done);
    child.once("close", done);
    child.kill("SIGTERM");
  });
}

async function prepare(
  paths,
  progress,
  signal,
  { locale = "ja", confirmMigration = async () => false } = {},
) {
  const options = { env: paths.env, cwd: paths.root, timeout: 15_000, signal };
  progress(text(locale, "checking"));
  try {
    await exec("docker", ["info", "--format", "{{.Architecture}}"], options);
  } catch {
    throw new Error(text(locale, "dockerFailed"));
  }
  try {
    await exec("gh", ["auth", "status"], options);
  } catch {
    throw new Error(text(locale, "githubFailed"));
  }
  const home = paths.env.SACTY_HOME || join(homedir(), ".sacty");
  if (!existsSync(join(home, "config.yaml"))) {
    progress(text(locale, "creatingConfig"));
    try {
      await exec(paths.node, [paths.cli, "config", "init"], options);
    } catch {
      throw new Error(text(locale, "configFailed"));
    }
  }
  const configCommand = async (args) => {
    try {
      return JSON.parse((await exec(paths.node, [paths.configTool, ...args], options)).stdout);
    } catch (error) {
      const code = error.stderr?.trim();
      throw new Error(
        text(
          locale,
          ["configFailed", "authRequired", "configChanged", "configSharedImage"].includes(code)
            ? code
            : "updateFailed",
        ),
      );
    }
  };
  const state = await configCommand(["inspect"]);
  if (state.migration && !(await confirmMigration(state.migration)))
    throw new Error(text(locale, "updateCancelled"));
  const images = [state.migration?.to ?? state.images[0], ...state.images.slice(1)];
  let bundledImage;
  if (paths.imageManifest && existsSync(paths.imageManifest)) {
    try {
      const manifest = JSON.parse(readFileSync(paths.imageManifest, "utf8"));
      if (manifest.architecture === (process.arch === "arm64" ? "arm64" : "amd64"))
        bundledImage = manifest.image;
    } catch {
      throw new Error(text(locale, "imageFailed"));
    }
  }
  let loaded = false;
  for (const image of images) {
    try {
      await exec("docker", ["image", "inspect", image], options);
    } catch {
      if (!loaded && image === bundledImage && existsSync(paths.imageArchive)) {
        progress(text(locale, "loadingImage"));
        try {
          await exec("docker", ["image", "load", "--input", paths.imageArchive], {
            ...options,
            timeout: 15 * 60_000,
            maxBuffer: 4 * 1024 * 1024,
          });
        } catch {
          throw new Error(text(locale, "imageFailed"));
        }
        loaded = true;
      }
      try {
        await exec("docker", ["image", "inspect", image], options);
      } catch {
        throw new Error(text(locale, "missingImage", { image }));
      }
    }
  }
  // Import and verify images before changing any user configuration.
  if (state.migration) await configCommand(["migrate", state.migration.snapshot]);
}

function launch(paths) {
  return spawn(paths.node, [paths.cli, "up"], {
    cwd: paths.root,
    env: paths.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

// Feed security's interactive command parser via stdin, never the process arguments.
async function saveApiKey(value, spawnProcess = spawn, locale = "ja") {
  if (typeof value !== "string" || !/^sk-[A-Za-z0-9_-]{10,1024}$/.test(value))
    throw new Error(text(locale, "keyInvalid"));
  await new Promise((resolve, reject) => {
    const child = spawnProcess("/usr/bin/security", ["-i"], { stdio: ["pipe", "ignore", "pipe"] });
    let failed = false;
    child.stderr.on("data", (data) => {
      if (/error|failed|SecKeychain|SecItem/i.test(data.toString())) failed = true;
    });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 && !failed ? resolve() : reject(new Error(text(locale, "keyFailed"))),
    );
    child.stdin.on("error", reject);
    child.stdin.end(`add-generic-password -U -s sacty -a openai-api-key -w ${value}\n`);
  });
}

module.exports = { runtimePaths, redact, waitForScreen, stopChild, prepare, launch, saveApiKey };
