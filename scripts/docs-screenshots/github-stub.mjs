// スクリーンショットを撮る間、GitHub の API（api.github.com）への問い合わせに、決まった答えを返す。
// capture.mjs が、sacty up の NODE_OPTIONS（--import）に入れる。デーモンと画面のプロセスが、起動のときに読み込む。
// - 実際の GitHub へ問い合わせない（架空のリポジトリの名前と架空のトークンを、外へ送らない）。
// - デーモンの PR の確認が PR の先頭を読めるので、タスクの詳細の「Sacty の AI のレビュー」が、ふだんの状態で写る
//   （読めないと「AI のレビューの状況は分かりません」になる）。
// 答えは、データを入れるスクリプトが SACTY_HOME に書いた、台帳のとおりの状態（seed-lib.mjs の githubAnswers）。
// 答えるのは、PR の確認が読むものだけ。書き込みと、知らない問い合わせには失敗を返してログに出す（デーモンが GitHub を
// 変えようとするのは、データが今の流れと合っていないとき）。
// GitHub のほかの宛先（デーモンと画面の間の通信など）は、そのまま通す。
import { readFileSync } from "node:fs";
import { join } from "node:path";

const API_HOST = "api.github.com";
/** seed-lib.mjs が書くファイル（同じ名前）。 */
const GITHUB_ANSWERS = "github-answers.json";

/** @type {{ pulls: { repo: string, number: number, state: string, head: string, draft: boolean, mergedBy?: string, mergeCommit?: string }[], running: { repo: string, commit: string }[] } | undefined} */
let answers;
function load() {
  if (answers) return answers;
  try {
    answers = JSON.parse(readFileSync(join(process.env.SACTY_HOME ?? "", GITHUB_ANSWERS), "utf8"));
  } catch {
    // 答えのファイルが無ければ、どの PR も無いと答える
    answers = { pulls: [], running: [] };
  }
  return answers;
}

const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

/** GitHub の API の答え。知らない問い合わせは undefined。 */
function answer(method, url) {
  const [, owner, name, path] = url.pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/(.+)$/) ?? [];
  if (method !== "GET" || !path) return undefined;
  const repo = `https://github.com/${owner}/${name}`.toLowerCase();
  const { pulls, running } = load();

  // PR の状態（開いているか・先頭のコミット・ドラフトか）
  const pull = path.match(/^pulls\/(\d+)$/);
  if (pull) {
    const found = pulls.find((p) => p.repo.toLowerCase() === repo && p.number === Number(pull[1]));
    if (!found) return json(404, { message: "Not Found" });
    const merged = found.state === "merged";
    return json(200, {
      number: found.number,
      html_url: `${found.repo}/pull/${found.number}`,
      state: found.state === "open" ? "open" : "closed",
      draft: found.draft,
      merged,
      mergeable: merged ? null : true,
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

const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const request = typeof input === "object" && "url" in input ? input : undefined;
  const url = new URL(request ? request.url : String(input));
  if (url.hostname !== API_HOST) return realFetch(input, init);
  const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
  const found = answer(method, url);
  if (found) return found;
  console.warn(
    `[github-stub] 答えを用意していない問い合わせです（データが今の流れと合っていないかもしれません）：${method} ${url.pathname}`,
  );
  return json(method === "GET" ? 404 : 403, {
    message: "Not available while taking screenshots",
  });
};
