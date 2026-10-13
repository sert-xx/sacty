/**
 * エージェントとテストのコマンドの出力を、非ブロッキングになっても落ちない形で受け取る（PBI-64）。
 * コンテナの標準出力（パイプ）の開いたファイルの記述は、同じ出力を受け継いだプロセスすべてで共有されるので、
 * どれか1つ（Node.js のプロセスなど）が O_NONBLOCK にすると、ほかのプロセスの大きな書き込みが EAGAIN で失敗する
 * （Codex は panic して落ちる）。そこで、コマンドの標準出力・標準エラー出力は、コンテナの中の一時的な通常のファイル
 * （通常のファイルへの書き込みは EAGAIN にならない）に書かせ、この中継（イメージにある Node.js で動く）が、
 * そのファイルを読みながらコンテナの標準出力・標準エラー出力に流す。中継は EAGAIN のときは待って書き直す。
 *
 * - 出力の順番と中身は変えない。標準出力と標準エラー出力は別のまま
 * - コマンドが終わったら、残りを流し切ってから同じ終了コードで終わる（シグナルで終わったら 128 + 番号）
 * - 止める・中止のシグナルはコマンドに伝える
 * - 流した分は、ファイルから捨てる（穴を開ける）。ディスクとメモリが、出力の大きさに比例して増えないように
 * - 一時的なファイルを作れなければ、これまでどおり標準出力・標準エラー出力をそのまま渡して動かす
 * - コマンドが /dev/stdout などを ">" で開き直すと、標準出力が通常のファイルのとき（`コマンド > ファイル`）と同じく
 *   切り詰められ、まだ流していない分は失われる。気づいたときは、標準エラー出力で知らせ、その後の出力を流し続ける
 */

/** 中継の知らせ（中継の失敗・出力の切り詰め）の先頭（標準エラー出力に出す）。 */
export const RELAY_NOTICE_PREFIX = "[sacty] 出力の中継：";

/**
 * 流した分がこの大きさ（バイト）を超えるたびに、ファイルのその部分に穴を開けて捨てる（`fallocate` が無ければ捨てない。
 * コンテナを消せば消える）。
 */
export const RELAY_DISCARD_BYTES = 8 * 1024 * 1024;

/** 中継の本体（`node -e` で動かす）。引数は、コマンドとその引数。 */
export const OUTPUT_RELAY_SCRIPT = `
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const [command, ...args] = process.argv.slice(1);
const exitOf = (code, signal) => code ?? 128 + (os.constants.signals[signal] ?? 0);
let dir;
let streams;
try {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "sacty-output-"));
  streams = [1, 2].map((target) => {
    const file = path.join(dir, String(target));
    return { target, file, write: fs.openSync(file, "a"), read: fs.openSync(file, "r") };
  });
} catch {
  // 一時的なファイルを作れない（/tmp に書けないなど）。これまでどおり、そのまま渡す
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  streams = undefined;
}
let exited = false;
let exitCode = 1;
const finish = (code) => {
  exitCode = code;
  // 流し切るのは、コマンドが終わった時点までの出力。後ろで動き続けるプロセスが書き続けても、待ち続けない
  // （これまでも、コマンドが終わればコンテナは終わった）
  for (const stream of streams ?? []) stream.end = fs.fstatSync(stream.read).size;
  exited = true;
};
const cleanup = () => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
};
const fail = (error) => {
  try {
    fs.writeSync(2, ${JSON.stringify(RELAY_NOTICE_PREFIX)} + (error && error.message ? error.message : String(error)) + "\\n");
  } catch {}
  try {
    child.kill("SIGKILL");
  } catch {}
  cleanup();
  process.exit(1);
};
process.on("uncaughtException", fail);
const child = spawn(command, args, {
  stdio: streams ? ["inherit", streams[0].write, streams[1].write] : "inherit",
});
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(signal, () => child.kill(signal));
}
child.on("error", (error) => {
  // コマンドが見つからないなど。理由はコマンドの標準エラー出力と同じ順番で出す
  const text = command + ": " + error.message + "\\n";
  if (streams) fs.writeSync(streams[1].write, text);
  else process.stderr.write(text);
  finish(error.code === "ENOENT" ? 127 : 126);
});
child.on("exit", (code, signal) => finish(exitOf(code, signal)));
// 書けなかった（EAGAIN）ときは、少し待って書き直す。途中までしか書けなかったら、残りを書く
const writeAll = (fd, buffer, start, end, next) => {
  if (start >= end) return next();
  fs.write(fd, buffer, start, end - start, null, (error, written) => {
    if (error && error.code === "EAGAIN") return setTimeout(() => writeAll(fd, buffer, start, end, next), 10);
    if (error) return fail(error);
    writeAll(fd, buffer, start + written, end, next);
  });
};
// 流した分に穴を開けて、ディスクから捨てる。使えなければ、以後は捨てない
let discard = true;
const punch = (stream, from, to, next) => {
  if (!discard) return next();
  const proc = spawn("fallocate", ["--punch-hole", "--offset", String(from), "--length", String(to - from), stream.file], { stdio: "ignore" });
  proc.on("error", () => {
    discard = false;
    next();
  });
  proc.on("exit", (code) => {
    if (code !== 0) discard = false;
    next();
  });
};
const pump = (stream) =>
  new Promise((done) => {
    const buffer = Buffer.alloc(64 * 1024);
    let offset = 0;
    let discarded = 0;
    // 前に見たファイルの大きさ（書き込みは末尾に足すだけなので、小さくなったら切り詰められた）
    let seen = 0;
    let warned = false;
    const step = () => {
      // コマンドが終わってから読んで、もう無ければ流し切った
      const finished = exited;
      // ファイルが短くなった（コマンドが /dev/stdout などを ">" で開き直して切り詰めた）。まだ流していない分は
      // 失われているので、知らせてから先頭から読み直す（コマンドへの書き込みは O_APPEND なので、以後は末尾に続く）
      const size = fs.fstatSync(stream.read).size;
      if (size < seen) {
        offset = discarded = 0;
        if (!warned) {
          warned = true;
          fs.writeSync(streams[1].write, ${JSON.stringify(RELAY_NOTICE_PREFIX)} + (stream.target === 1 ? "標準出力" : "標準エラー出力") + "が開き直されて切り詰められたため、その前の出力の一部が失われたかもしれません（\\">\\" の代わりに \\">>\\" で書いてください）\\n");
        }
      }
      seen = size;
      if (finished && offset >= stream.end) return done();
      const length = finished ? Math.min(buffer.length, stream.end - offset) : buffer.length;
      fs.read(stream.read, buffer, 0, length, offset, (error, read) => {
        if (error) return fail(error);
        if (read === 0) return finished ? done() : setTimeout(step, 20);
        offset += read;
        writeAll(stream.target, buffer, 0, read, () => {
          if (offset - discarded < ${RELAY_DISCARD_BYTES}) return step();
          const from = discarded;
          discarded = offset;
          punch(stream, from, offset, step);
        });
      });
    };
    step();
  });
const waitExit = () =>
  new Promise((done) => {
    const check = () => (exited ? done() : setTimeout(check, 20));
    check();
  });
Promise.all(streams ? streams.map(pump) : [waitExit()]).then(() => {
  cleanup();
  process.exit(exitCode);
}, fail);
`;

/** コンテナで実行するコマンドを、出力の中継の下で動かすコマンドにする。 */
export function withOutputRelay(command: string[]): string[] {
  return ["node", "-e", OUTPUT_RELAY_SCRIPT, "--", ...command];
}
