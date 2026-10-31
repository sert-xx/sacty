const { stripVTControlCharacters } = require("node:util");
function sanitize(line) {
  line = Array.from(stripVTControlCharacters(line))
    .filter((char) => char.codePointAt(0) >= 32 && char.codePointAt(0) !== 127)
    .join("");
  // Drop credential-bearing lines instead of trying to guess the value's boundaries.
  if (
    /authorization|cookie|api[-_ ]?key|secret|password|passwd|credential|(?:access|refresh|auth)[-_ ]?token|\btoken\b/i.test(
      line,
    )
  )
    return "[REDACTED]";
  return line
    .replace(
      /\b(?:sk-[A-Za-z0-9_-]+|gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g,
      "[REDACTED]",
    )
    .replace(/https?:\/\/[^\s"'<>]+/gi, (value) => {
      try {
        const url = new URL(value);
        if (url.username || url.password) {
          url.username = "REDACTED";
          url.password = "REDACTED";
        }
        if (url.search) url.search = "?REDACTED";
        if (url.hash) url.hash = "#REDACTED";
        return url.href;
      } catch {
        return "[REDACTED URL]";
      }
    });
}

function captureDiagnostics(child, { maxBytes = 64 * 1024, maxLineBytes = 8 * 1024 } = {}) {
  const lines = [];
  let retainedBytes = 0;
  const streams = [];
  let closed = false;
  const bounded = (values) => {
    const result = [...values];
    let size = result.reduce((total, line) => total + Buffer.byteLength(line) + 1, 0);
    while (size > maxBytes && result.length) size -= Buffer.byteLength(result.shift()) + 1;
    return result;
  };
  const retain = (line) => {
    if (!line.trim()) return;
    const safe = sanitize(line);
    lines.push(safe);
    retainedBytes += Buffer.byteLength(safe) + 1;
    while (retainedBytes > maxBytes && lines.length)
      retainedBytes -= Buffer.byteLength(lines.shift()) + 1;
  };
  for (const stream of [child.stdout, child.stderr]) {
    if (!stream) continue;
    const state = { pending: Buffer.alloc(0), dropping: false };
    streams.push(state);
    stream.on("data", (data) => {
      const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
      let start = 0;
      while (start < chunk.length) {
        const newline = chunk.indexOf(10, start);
        const end = newline === -1 ? chunk.length : newline;
        const part = chunk.subarray(start, end);
        if (!state.dropping) {
          if (state.pending.length + part.length > Math.min(maxLineBytes, maxBytes)) {
            state.pending = Buffer.alloc(0);
            state.dropping = true;
          } else state.pending = Buffer.concat([state.pending, part]);
        }
        if (newline === -1) break;
        retain(state.dropping ? "[truncated]" : state.pending.toString("utf8"));
        state.pending = Buffer.alloc(0);
        state.dropping = false;
        start = newline + 1;
      }
    });
  }
  child.once("close", () => {
    for (const state of streams) {
      retain(state.dropping ? "[truncated]" : state.pending.toString("utf8"));
      state.pending = Buffer.alloc(0);
      state.dropping = false;
    }
    closed = true;
  });
  return {
    text: () =>
      bounded([
        ...lines,
        ...streams
          .map((state) =>
            state.dropping ? "[truncated]" : sanitize(state.pending.toString("utf8")),
          )
          .filter(Boolean),
      ]).join("\n"),
    waitForClose: () =>
      new Promise((resolve) => {
        if (closed) {
          resolve();
          return;
        }
        const done = () => {
          clearTimeout(timer);
          child.off("close", done);
          resolve();
        };
        const timer = setTimeout(done, 1000);
        child.once("close", done);
      }),
  };
}
module.exports = { captureDiagnostics };
