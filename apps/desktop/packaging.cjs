const {
  readdirSync,
  readlinkSync,
  symlinkSync,
  unlinkSync,
  realpathSync,
  existsSync,
} = require("node:fs");
const { dirname, join, relative, resolve, isAbsolute } = require("node:path");

function inside(root, path) {
  const rel = relative(root, path);
  return !isAbsolute(rel) && rel !== ".." && !rel.startsWith("../");
}

// fs.cp (used by Packager) can turn relative npm links into absolute staging paths.
// Repair the final output, after all copies/moves, rather than repairing its source.
function finalizeRuntime(runtime, stagingRuntime) {
  runtime = realpathSync(runtime);
  stagingRuntime = realpathSync(stagingRuntime);
  const links = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        const linkTarget = resolve(dirname(path), readlinkSync(path));
        const target = existsSync(linkTarget) ? realpathSync(linkTarget) : linkTarget;
        const relocated = inside(stagingRuntime, target)
          ? join(runtime, relative(stagingRuntime, target))
          : target;
        if (!inside(runtime, relocated))
          throw new Error(`同梱範囲外へのリンクです: ${relative(runtime, path)}`);
        unlinkSync(path);
        symlinkSync(relative(dirname(path), relocated), path);
        links.push(path);
      } else if (entry.isDirectory()) walk(path);
    }
  };
  walk(runtime);
  for (const path of links) {
    if (!inside(runtime, realpathSync(path)))
      throw new Error(`同梱範囲外へ解決されるリンクです: ${relative(runtime, path)}`);
  }
  if (!existsSync(join(runtime, "config/agents.yaml")))
    throw new Error("既定エージェントの設定が同梱されていません。");
}

module.exports = { finalizeRuntime };
