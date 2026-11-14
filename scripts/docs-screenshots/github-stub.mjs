// スクリーンショットを撮る間、GitHub の API（api.github.com）への問い合わせに、決まった答えを返す。
// capture.mjs が、sacty up の NODE_OPTIONS（--import）に入れる。デーモンと画面のプロセスが、起動のときに読み込む。
// - GitHub の API には、実際には問い合わせない（架空のリポジトリの名前と架空のトークンを、外へ送らない）。
// - デーモンの PR の確認が PR の先頭を読めるので、タスクの詳細の「Sacty の AI のレビュー」が、ふだんの状態で写る
//   （読めないと「AI のレビューの状況は分かりません」になる）。
// 答えは、データを入れるスクリプトが SACTY_HOME に書いた、台帳のとおりの状態（seed-lib.mjs の githubAnswers）。
// 答えるのは、PR の確認が読むものだけ。PR の状態（開いているか・先頭のコミット・ドラフトか・競合しているか）と、
// 監視しているコミットの CI/CD は、データから決まる。PR のレビューとコメントは、いつも無いと答える（取り込む指摘のある
// データは、撮れない）。
// 書き込みと、答えを用意していない問い合わせは断り、ログと SACTY_HOME のファイルに残す。capture.mjs は、断った問い合わせが
// あれば撮影を失敗にする（デーモンが GitHub を変えようとするのは、データが今の実装の流れと合っていないとき）。
// GitHub の API のほかの宛先（デーモンと画面の間の通信など）は、そのまま通す。git の通信は差し替えない。
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

const API_HOST = "api.github.com";
/** seed-lib.mjs が書く、答えのファイル（同じ名前）。 */
const GITHUB_ANSWERS = "github-answers.json";
/** 断った問い合わせを残すファイル（capture.mjs が同じ名前で読む）。 */
const GITHUB_REFUSED = "github-refused.log";
const home = process.env.SACTY_HOME ?? "";

/**
 * @typedef {{ repo: string, number: number, state: string, head: string, draft: boolean, mergeable: boolean,
 *   mergedBy?: string, mergeCommit?: string }} Pull
 * @type {{ pulls: Pull[], running: { repo: string, commit: string }[] } | Error | undefined}
 */
let answers;
/** データを入れるスクリプトが書いた答え。読めなければ Error（どの問い合わせにも答えない）。 */
function load() {
  if (answers) return answers;
  try {
    answers = JSON.parse(readFileSync(join(home, GITHUB_ANSWERS), "utf8"));
  } catch (error) {
    answers = error instanceof Error ? error : new Error(String(error));
  }
  return answers;
}

const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

/** GitHub の API の答え。答えを用意していない問い合わせは undefined。 */
function answer(method, url, { pulls, running }) {
  const [, owner, name, path] = url.pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/(.+)$/) ?? [];
  if (method !== "GET" || !path) return undefined;
  const repo = `https://github.com/${owner}/${name}`.toLowerCase();

  // PR の状態（開いているか・先頭のコミット・ドラフトか・ベースブランチと競合しているか）
  const pull = path.match(/^pulls\/(\d+)$/);
  if (pull) {
    const found = pulls.find((p) => p.repo.toLowerCase() === repo && p.number === Number(pull[1]));
    if (!found) return json(404, { message: "Not Found" });
    const merged = found.state === "merged";
    return json(200, {
      number: found.number,
      // ドラフトの切り替え（GraphQL）に使う ID。切り替えは書き込みなので、断る
      node_id: `PR_${owner}_${name}_${found.number}`,
      html_url: `${found.repo}/pull/${found.number}`,
      state: found.state === "open" ? "open" : "closed",
      draft: found.draft,
      merged,
      mergeable: found.state === "open" ? found.mergeable : null,
      head: { sha: found.head },
      ...(merged
        ? { merged_by: { login: found.mergedBy }, merge_commit_sha: found.mergeCommit }
        : {}),
    });
  }
  // PR のレビュー・行へのコメント・通常のコメント：取り込む指摘は無い
  if (/^(pulls\/\d+\/(reviews|comments)|issues\/\d+\/comments)$/.test(path)) return json(200, []);

  // コミットの CI/CD：マージの後の監視で待っているコミットは、実行中
  const watching = (commit) =>
    running.some((r) => r.repo.toLowerCase() === repo && r.commit === commit);
  if (path === "actions/runs") {
    const commit = url.searchParams.get("head_sha") ?? "";
    const runs = watching(commit)
      ? [
          {
            id: 1,
            workflow_id: 1,
            run_attempt: 1,
            name: "CI",
            head_sha: commit,
            status: "in_progress",
            conclusion: null,
            html_url: `https://github.com/${owner}/${name}/actions/runs/1`,
          },
        ]
      : [];
    return json(200, { total_count: runs.length, workflow_runs: runs });
  }
  if (/^commits\/[^/]+\/check-runs$/.test(path))
    return json(200, { total_count: 0, check_runs: [] });
  if (/^commits\/[^/]+\/status$/.test(path)) return json(200, { state: "pending", statuses: [] });
  return undefined;
}

/** 断った問い合わせを、ログと、capture.mjs が読むファイルに残す。 */
function refuse(method, url, why) {
  const line = `${method} ${url.pathname}（${why}）`;
  console.warn(`[github-stub] GitHub の API への問い合わせを断りました：${line}`);
  try {
    appendFileSync(join(home, GITHUB_REFUSED), `${line}\n`);
  } catch {
    // 残せなくても、問い合わせは断る
  }
}

const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const request = typeof input === "object" && "url" in input ? input : undefined;
  const url = new URL(request ? request.url : String(input));
  if (url.hostname !== API_HOST) return realFetch(input, init);
  const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
  const loaded = load();
  if (loaded instanceof Error) {
    // 答えが無いまま「PR が無い」「CI が無い」と答えると、デーモンがそれを記録してしまう
    refuse(method, url, `答えのファイル ${GITHUB_ANSWERS} を読めません`);
    return json(503, { message: "No answers are prepared for the screenshots" });
  }
  const found = answer(method, url, loaded);
  if (found) return found;
  refuse(method, url, method === "GET" ? "答えを用意していません" : "書き込みです");
  return json(method === "GET" ? 404 : 403, {
    message: "Not available while taking screenshots",
  });
};
