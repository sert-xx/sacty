#!/usr/bin/env node
// sacty のエージェント実行用イメージの drawio。draw.io Desktop（Electron）の CLI を、画面の無いコンテナで動かす。
// DISPLAY が無ければ、仮想の画面（Xvfb）を空いている番号で起動し、終わったら止める。Chromium のサンドボックスは
// コンテナ（no-new-privileges・権限を落とした node ユーザー）では使えないので --no-sandbox、GPU も無いので
// --disable-gpu で起動する。D-Bus が無いことの、動作に関係しないログ（ERROR:dbus/…）は標準エラー出力から除く。
// 引数は draw.io の CLI のまま（drawio -x -f png -e -b 10 -o out.drawio.png in.drawio など）。
"use strict";

const { spawn } = require("node:child_process");
const { constants } = require("node:os");

const DRAWIO = process.env.SACTY_DRAWIO_BIN || "/opt/drawio/drawio";
const NOISE = /ERROR:(?:dbus\/|bus\.cc)/;

/** 起動した子（中断されたときに止めるため）。 */
const children = { xvfb: undefined, drawio: undefined };
/** 中断された（シグナルを受けた）か。中断で止めた Xvfb の終了を、起動の失敗として扱わないため。 */
let interrupted = false;

function die(message, code = 1) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

/** Xvfb を空いている番号で起動し、その番号を返す（-displayfd で Xvfb に選ばせる）。 */
function startXvfb() {
  return new Promise((resolve, reject) => {
    const xvfb = spawn(
      "Xvfb",
      ["-displayfd", "3", "-screen", "0", "1920x1080x24", "-nolisten", "tcp"],
      { stdio: ["ignore", "ignore", "pipe", "pipe"] },
    );
    // 起動を待っている間に中断されても止められるように、すぐに覚える
    children.xvfb = xvfb;
    // 文字の途中で分かれたチャンクを壊さないように、UTF-8 として復号してから扱う
    xvfb.stderr.setEncoding("utf8");
    xvfb.stdio[3].setEncoding("utf8");
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      xvfb.kill("SIGKILL");
      reject(new Error(`仮想の画面（Xvfb）が起動しませんでした。${err.trim()}`));
    }, 15000);
    xvfb.stderr.on("data", (chunk) => {
      err = (err + chunk).slice(-4000);
    });
    xvfb.stdio[3].on("data", (chunk) => {
      out += chunk;
      const match = /^(\d+)\n/.exec(out);
      if (match) {
        clearTimeout(timer);
        resolve({ xvfb, display: `:${match[1]}` });
      }
    });
    xvfb.on("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`仮想の画面（Xvfb）を起動できませんでした：${error.message}`));
    });
    xvfb.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`仮想の画面（Xvfb）が終了しました（${code}）。${err.trim()}`));
    });
  });
}

/** draw.io を実行し、終了コードを返す。標準エラー出力は、D-Bus のログの行を除いて流す。 */
function runDrawio(env) {
  return new Promise((resolve) => {
    const child = spawn(DRAWIO, ["--no-sandbox", "--disable-gpu", ...process.argv.slice(2)], {
      env,
      stdio: ["inherit", "inherit", "pipe"],
    });
    children.drawio = child;
    child.stderr.setEncoding("utf8");
    let rest = "";
    child.stderr.on("data", (chunk) => {
      const lines = (rest + chunk).split("\n");
      rest = lines.pop() ?? "";
      for (const line of lines) if (!NOISE.test(line)) process.stderr.write(`${line}\n`);
    });
    child.on("error", (error) => {
      process.stderr.write(`draw.io を起動できませんでした（${DRAWIO}）：${error.message}\n`);
      resolve(127);
    });
    child.on("close", (code, signal) => {
      if (rest && !NOISE.test(rest)) process.stderr.write(rest);
      resolve(code ?? 128 + (constants.signals[signal] ?? 0));
    });
  });
}

/**
 * SIGINT・SIGTERM を受けたら、draw.io が動いていれば同じシグナルを送る（終われば Xvfb も止める）。まだ draw.io を
 * 起動していなければ（Xvfb の起動を待っている間など）、Xvfb を止めて終わるのを待ってから、シグナルの終了コードで終わる。
 */
function handleSignals() {
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      if (children.drawio) {
        children.drawio.kill(signal);
        return;
      }
      interrupted = true;
      const code = 128 + (constants.signals[signal] ?? 0);
      if (!children.xvfb) process.exit(code);
      stopXvfb(children.xvfb).then(() => process.exit(code));
    });
  }
}

async function main() {
  handleSignals();
  if (process.env.DISPLAY) return runDrawio(process.env);
  let started;
  try {
    started = await startXvfb();
  } catch (error) {
    // 中断で止めたときは、シグナルの処理が Xvfb の終了を待って終わる
    if (interrupted) return new Promise(() => {});
    die(`drawio: ${error.message}`);
  }
  if (interrupted) return new Promise(() => {});
  started.xvfb.removeAllListeners("exit");
  try {
    return await runDrawio({ ...process.env, DISPLAY: started.display });
  } finally {
    await stopXvfb(started.xvfb);
  }
}

/** Xvfb を止め、終わるまで待つ（残さないため。3秒で終わらなければ強制的に止める）。 */
function stopXvfb(xvfb) {
  return new Promise((resolve) => {
    if (xvfb.exitCode !== null || xvfb.signalCode !== null) return resolve();
    const timer = setTimeout(() => xvfb.kill("SIGKILL"), 3000);
    xvfb.on("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    xvfb.kill("SIGTERM");
  });
}

main().then((code) => process.exit(code));
