/**
 * docker compose のサービス（PBI-47）に、コンテナの中から localhost のままでも接続できるようにする（PBI-60）。
 * コンテナの中で、コマンドの前に小さな TCP の転送（イメージにある Node.js で動く）を起動し、
 * `127.0.0.1:<ポート>`（と、使えれば `[::1]:<ポート>`）への接続を `<サービス名>:<ポート>` につなぐ。
 * コマンドは転送の子プロセスとして動かし、標準入出力はそのまま渡す（出力を変えない）。コマンドが終わったら、
 * 同じ終了コードで終わる（転送も止まる）。
 */

/**
 * localhost に転送するポートと、転送先のサービス。target は転送先のポート（無ければ port と同じ。
 * ホストに出すポートが違うとき（"15432:5432"）に使う）。
 */
export type LocalForward = { port: number; host: string; target?: number };

/** 転送しなかったポートの知らせの先頭（標準エラー出力に出す。デーモンのログに写すときの目印）。 */
export const FORWARD_NOTICE_PREFIX = "[sacty] localhost の転送：";

/**
 * 転送の本体（`node -e` で動かす）。引数は、転送の一覧（[待ち受けるポート, 転送先のホスト, 転送先のポート] の JSON）、
 * コマンド、その引数。待ち受けられないポート（すでに使われているなど）は転送せず、理由を標準エラー出力に出して続ける。
 */
export const FORWARD_SCRIPT = `
const net = require("net");
const os = require("os");
const { spawn } = require("child_process");
const [spec, command, ...args] = process.argv.slice(1);
const notice = (text) => process.stderr.write(${JSON.stringify(FORWARD_NOTICE_PREFIX)} + text + "\\n");
const listen = (address, listenPort, host, port) =>
  new Promise((done) => {
    const server = net.createServer({ allowHalfOpen: true }, (client) => {
      const upstream = net.connect({ host, port, allowHalfOpen: true });
      client.on("error", () => upstream.destroy());
      upstream.on("error", () => client.destroy());
      client.pipe(upstream);
      upstream.pipe(client);
    });
    server.once("error", (error) => done(error.code || String(error)));
    server.listen({ host: address, port: listenPort, exclusive: true }, () => {
      server.on("error", () => {});
      done(undefined);
    });
  });
(async () => {
  for (const [listenPort, host, port] of JSON.parse(spec)) {
    const error = await listen("127.0.0.1", listenPort, host, port);
    if (error) {
      notice(
        "127.0.0.1:" + listenPort + " を " + host + ":" + port + " に転送しません（" +
          (error === "EADDRINUSE" ? "すでに使われています" : error) + "）。" + host + ":" + port + " で接続してください",
      );
      continue;
    }
    // IPv6 の localhost（::1）。使えないコンテナ（IPv6 が無効など）では、何もしない
    await listen("::1", listenPort, host, port);
  }
  const child = spawn(command, args, { stdio: "inherit" });
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    process.on(signal, () => child.kill(signal));
  }
  child.on("error", (error) => {
    process.stderr.write(command + ": " + error.message + "\\n");
    process.exit(error.code === "ENOENT" ? 127 : 126);
  });
  child.on("exit", (code, signal) => {
    process.exit(code ?? 128 + (os.constants.signals[signal] ?? 0));
  });
})();
`;

/** コンテナで実行するコマンドを、転送を起動してから動かすコマンドにする。転送するものが無ければ、そのまま。 */
export function withLocalForwards(command: string[], forwards: readonly LocalForward[]): string[] {
  if (forwards.length === 0) return command;
  const spec = JSON.stringify(forwards.map((f) => [f.port, f.host, f.target ?? f.port]));
  return ["node", "-e", FORWARD_SCRIPT, "--", spec, ...command];
}

/** 標準エラー出力から、転送しなかったポートの知らせを取り出す（デーモンのログに写す）。 */
export function forwardNotices(stderr: string): string[] {
  return stderr.split("\n").filter((line) => line.startsWith(FORWARD_NOTICE_PREFIX));
}
