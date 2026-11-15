// スクリーンショット用の架空のデータを書く道具（seed.mjs・seed-intro.mjs が使う）。
// 実際の AI・GitHub・Docker は使わない。作業履歴に、タスクの状態を作るイベントを直接書く。
// デーモンのビルド（npm run build）が要る。
//
// データは、今の実装が記録する流れで書く（docs/spec/tasks-and-steps.md・docs/spec/approval.md）。
// - タスクの開始時に、情報収集（gather）をする。実装する進め方に、前段の調査は無い（セキュリティ対応だけにある）。
// - 実装の後は、最終レビューをせずに（FinalReviewSkipped）実装の PR をドラフトで作り、PR のレビューの子タスク（reviewed）が
//   指摘なしにしたら、ドラフトを外す（PullRequestMarkedReady）。
// - sacty が作る PR（要求要件・設計・実装）には、レビューの子タスクがある。承認待ちの PR に子タスクが無いと、デーモンが
//   起動の後に作って実行し、撮る環境では失敗して「エラーで一時停止」が写る。
// 以前の版の流れの記録（FinalReviewed など）は、その記録を写す画面に要るときだけ、理由をコメントに書いて入れる。
// 書くのは、画面に出る状態と、デーモンの PR の確認が読む状態を作る記録だけ（実行ごとの細かい記録は書かない）。
// 流れが変わってデータが古くなると、撮る間にデーモンが作業履歴に書き足すか、GitHub を変えようとする。capture.mjs は、
// どちらかを見つけたら、画像を置き換えずに失敗にする（readActivity と、github-stub.mjs が断った問い合わせ）。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SqliteActivityStore } from "../../apps/daemon/dist/activity.js";
import { SqliteProjectStore } from "../../apps/daemon/dist/projects.js";
import { awaitingDeploymentCi, project } from "../../packages/core/dist/index.js";

const HOUR = 3_600_000;
/** 対象リポジトリの起点のコミット（すべてのタスクで同じにしている）。 */
const BASE_COMMIT = "4f2c9a1e7b3d";
/**
 * 撮る間の GitHub の答えを書くファイル（SACTY_HOME の下。github-stub.mjs が同じ名前で読む）。
 */
const GITHUB_ANSWERS = "github-answers.json";
/** github-stub.mjs が、断った GitHub の API への問い合わせを残すファイル（SACTY_HOME の下。同じ名前）。 */
const GITHUB_REFUSED = "github-refused.log";

/**
 * SACTY_HOME を開き、データを書く道具を返す。
 * @param {string} name 使い方の表示に出すスクリプトの名前
 * @param {string[]} [argv] `<SACTY_HOME> <ja|en>`
 */
export function openSeed(name, argv = process.argv.slice(2)) {
  const [home, lang = "ja"] = argv;
  if (!home) {
    console.error(`usage: ${name} <SACTY_HOME> <ja|en>`);
    process.exit(2);
  }
  const L = (ja, en) => (lang === "en" ? en : ja);
  mkdirSync(home, { recursive: true });

  const NOW = Date.now();
  let clock = NOW;
  const db = join(home, "sacty.db");
  const activity = new SqliteActivityStore(db, () => new Date(clock));
  const projects = new SqliteProjectStore(db, () => new Date(NOW - 30 * 24 * HOUR));

  let runSeq = 0;
  const usage = (input, output) => ({
    input,
    cacheRead: Math.round(input * 0.6),
    cacheWrite: 0,
    output,
  });

  /** タスクのイベントを書く道具。hoursAgo は、今から何時間前の出来事か。 */
  function task(id, projectId) {
    const add = (hoursAgo, actor, type, payload) => {
      clock = NOW - hoursAgo * HOUR;
      activity.append({ taskId: id, projectId, events: [{ actor, event: { type, payload } }] });
    };
    /** タスクブランチを作ったか（要求要件・設計の PR の前に、1回だけ作る）。 */
    let branched = false;
    /** 開始時に集めた情報（PR をレビューする子タスクが引き継ぐ）。 */
    let gathered;
    return {
      add,
      create(hoursAgo, title, body, extra = {}) {
        add(hoursAgo, "person", "TaskCreated", {
          title,
          body,
          start: "sacty",
          budgetCapUsd: 5,
          ...extra,
        });
      },
      /** 対象リポジトリの用意。記録するのは clone の URL（リポジトリの URL に .git を付けたもの）。 */
      repo(hoursAgo, url) {
        add(hoursAgo, "sacty", "RepositoryPrepared", {
          url: `${url}.git`,
          baseBranch: "main",
          baseCommit: BASE_COMMIT,
        });
      },
      /** タスクの開始時の情報収集（集めた情報のまとめ）。工程を選ぶ（plan）前に書く。 */
      gather(hoursAgo, brief, extra = {}) {
        gathered = { brief, sources: extra.sources ?? [] };
        add(hoursAgo, "gatherer", "InformationGathered", {
          brief,
          sources: [],
          agentId: "codex_lite",
          authMode: "api-key",
          model: "gpt-6-luna",
          usage: usage(30000, 1200),
          costUsd: 0.05,
          ...extra,
        });
      },
      plan(hoursAgo, plan, steps, reason, extra = {}) {
        add(hoursAgo, "orchestrator", "StepsChosen", {
          steps,
          plan,
          reason,
          agentId: "codex_lite",
          authMode: "api-key",
          model: "gpt-6-luna",
          usage: usage(18000, 900),
          costUsd: 0.03,
          ...extra,
        });
      },
      run(hoursAgo, step, output, cost, extra = {}) {
        const runId = `run-${id}-${++runSeq}`;
        const agent = { agentId: "codex_standard", authMode: extra.authMode ?? "api-key" };
        add(hoursAgo, "sacty", "AgentRunStarted", {
          runId,
          step,
          ...agent,
          model: "gpt-6.1-sol",
          reasoningEffort: "low",
        });
        add(hoursAgo - 0.3, "agent", "AgentRunCompleted", {
          runId,
          step,
          ...agent,
          usage: usage(Math.round(cost * 400000), Math.round(cost * 20000)),
          costUsd: cost,
          estimated: false,
          output,
          ...extra,
        });
      },
      fail(hoursAgo, step, reason, message) {
        const runId = `run-${id}-${++runSeq}`;
        add(hoursAgo, "sacty", "AgentRunStarted", {
          runId,
          step,
          agentId: "codex_standard",
          authMode: "api-key",
          model: "gpt-6.1-sol",
        });
        add(hoursAgo - 0.1, "sacty", "AgentRunFailed", {
          runId,
          step,
          agentId: "codex_standard",
          reason,
          message,
        });
        // 止まった理由の文は、失敗の記録（AgentRunFailed）にある
        add(hoursAgo - 0.1, "sacty", "TaskPaused", { reason });
      },
      submit(hoursAgo, step, submission = 1) {
        add(hoursAgo, "sacty", "StepSubmitted", { step, submission });
      },
      approve(hoursAgo, step, next) {
        add(hoursAgo, "person", "StepApproved", { step, next });
      },
      /**
       * 実装の PR。今の流れでは、実装の後に FinalReviewSkipped を書いてから、`{ awaitingReview: true, draft: true }` で書く
       * （ドラフトで作り、レビューの子タスクの指摘なしを待つ）。
       */
      pr(hoursAgo, repo, number, extra = {}) {
        add(hoursAgo, "sacty", "PullRequestPublished", {
          branch: `sacty/task-${id.slice(0, 8)}`,
          commit: "9e1d0c4b2a7f",
          url: `${repo}/pull/${number}`,
          number,
          repo,
          ...extra,
        });
      },
      /**
       * 要求要件・設計の PR（タスクブランチへの PR）。最初の PR の前に、タスクブランチを作る。提出の記録は、続けて submit で書く。
       * commit は PR に積んだコミット、base はそのときのタスクブランチの先頭（前の工程の PR をマージしたコミット。最初は起点）。
       */
      stepPr(hoursAgo, step, { repo, number, commit, base = BASE_COMMIT, ...extra }) {
        const branch = `sacty/task-${id.slice(0, 8)}`;
        if (!branched) add(hoursAgo, "sacty", "TaskBranchCreated", { branch, commit: BASE_COMMIT });
        branched = true;
        add(hoursAgo, "sacty", "StepPullRequestPublished", {
          step,
          branch: `${branch}-${step}-1`,
          commit,
          base,
          path: `docs/sacty/${id.slice(0, 8)}/${step}.md`,
          url: `${repo}/pull/${number}`,
          number,
          repo,
          ...extra,
        });
      },
      /**
       * 人が PR をマージした（PR の確認が記録する。承認の記録 approve を続けて書く）。
       * commit はマージされた PR の先頭で、sacty が出したコミット（submitted）と同じ（人は PR の中で直していない）。
       */
      merged(hoursAgo, number, { commit = "9e1d0c4b2a7f", ...extra } = {}) {
        add(hoursAgo, "person", "PullRequestMerged", {
          number,
          by: "acme-lead",
          commit,
          submitted: commit,
          mergeCommit: "b81f3e5d6c20",
          ...extra,
        });
      },
      /**
       * この PR をレビューする子タスク（指摘なしでレビューを投稿して完了したもの）を入れ、このタスクに記録する。
       * 子タスクは、リポジトリを用意し、このタスクが開始時に集めた情報を引き継いでから（集め直さない。このタスクに
       * まとめが無ければ、子タスクが集める）、工程（レビューだけ）が決まる。
       * commit は、このタスクが PR に積んだコミット（同じコミットなので、デーモンは再レビューを始めない）。
       * @param {number} hoursAgo 子タスクを作った時刻（PR を作った直後）
       * @param {{ id: string, step: "requirements" | "design" | "implement", repo: string, number: number,
       *   title: string, commit: string, baseCommit?: string, output?: string }} child title はこのタスクの題、
       *   baseCommit は PR の向き先の先頭（書かなければ起点のコミット）、output はレビューの本文
       */
      reviewed(
        hoursAgo,
        { id: childId, step, repo, number, title, commit, baseCommit = BASE_COMMIT, output },
      ) {
        const url = `${repo}/pull/${number}`;
        const r = task(childId, projectId);
        r.add(hoursAgo, "sacty", "TaskCreated", {
          title: `[PR #${number}] ${title}`,
          body: "",
          start: "github_pull_request",
          budgetCapUsd: 5,
          source: { kind: "github_pull_request", repo, number, url, review: "sacty" },
          reviewOf: { taskId: id, step },
        });
        add(hoursAgo, "sacty", "ReviewTaskCreated", { taskId: childId, step, repo, number });
        r.repo(hoursAgo - 0.005, repo);
        if (gathered) {
          r.add(hoursAgo - 0.01, "sacty", "GatheredInherited", { from: id, ...gathered });
        } else {
          r.gather(
            hoursAgo - 0.01,
            L(
              `## 目的と背景\n\nPR #${number} のレビュー。\n`,
              `## Goal and background\n\nReview of PR #${number}.\n`,
            ),
          );
        }
        // 撮るときの設定（capture.mjs の CONFIG）には images があるので、レビューの工程のイメージだけは、
        // オーケストレーターが選ぶ（既定のイメージ）
        r.add(hoursAgo - 0.02, "orchestrator", "StepsChosen", {
          steps: ["review"],
          plan: "review",
          reason: { code: "review.reviewOnlyImageChosen", params: { via: "sacty" } },
          image: "default",
          imageSource: "orchestrator",
          defaultImageReason: L(
            "検証に、既定のイメージに無いツールは要らないため",
            "The checks need no tool beyond the default image",
          ),
          agentId: "codex_lite",
          authMode: "api-key",
          model: "gpt-6-luna",
          usage: usage(12000, 300),
          costUsd: 0.02,
        });
        r.add(hoursAgo - 0.04, "sacty", "ReviewTargetResolved", {
          repo,
          number,
          url,
          title,
          headCommit: commit,
          baseCommit,
          author: "acme-dev",
        });
        r.run(
          hoursAgo - 0.06,
          "review",
          output ??
            L(
              "## 総評\n\n指摘はありません。受け入れ条件を満たし、テストも通っています。\n",
              "## Summary\n\nNo findings. The acceptance criteria are met and the tests pass.\n",
            ),
          0.24,
          { reviewVerdict: "no_findings" },
        );
        r.add(hoursAgo - 0.5, "sacty", "PullRequestReviewPosted", {
          url: `${url}#pullrequestreview-1`,
        });
      },
    };
  }

  /**
   * 作業履歴が投影できることを確かめ（デーモンの起動と同じ読み方）、撮る間の GitHub の答えを書き、タスクの一覧を出して閉じる。
   */
  function finish() {
    const tasks = project(activity.all());
    writeFileSync(join(home, GITHUB_ANSWERS), `${JSON.stringify(githubAnswers(tasks), null, 2)}\n`);
    console.log(`seeded ${tasks.size} tasks into ${db}`);
    for (const t of tasks.values()) console.log(`  ${t.status.padEnd(18)} ${t.title}`);
    activity.close();
    projects.close();
  }

  return { L, projects, task, usage, finish };
}

/**
 * 撮る間に GitHub の API が返す答え（github-stub.mjs が読む）。台帳のとおりの状態にして、デーモンの PR の確認が、直すものを
 * 見つけないようにする。
 * - pulls：sacty が作った PR。状態・先頭のコミット・ドラフトか・ベースブランチと競合しているかは、台帳に記録したまま
 * - running：マージの後の監視で CI/CD を待っているコミット（CI が実行中と答える）
 * PR のレビューとコメントは、答えに入れない（github-stub.mjs が、いつも無いと答える）。
 */
function githubAnswers(tasks) {
  const pulls = [];
  const running = [];
  const state = (s) => (s === "merged_outdated" ? "merged" : (s ?? "open"));
  const merge = (m) =>
    m
      ? { mergedBy: m.by, mergeCommit: m.mergeCommit, ...(m.commit ? { head: m.commit } : {}) }
      : {};
  for (const t of tasks.values()) {
    const pr = t.pullRequest;
    if (pr?.number && pr.repo) {
      const conflict = t.pullRequestConflict;
      pulls.push({
        repo: pr.repo,
        number: pr.number,
        state: state(t.pullRequestState),
        // 指摘なしでドラフトを外した PR の先頭は、指摘なしにしたコミット
        head: pr.reviewedCommit ?? pr.commit,
        draft: pr.draft === true,
        // ベースブランチとの競合を記録した PR は、競合している
        mergeable: !(conflict?.number === pr.number && conflict.commit === pr.commit),
        ...merge(t.pullRequestMerge),
      });
    }
    for (const p of t.stepPullRequests) {
      pulls.push({
        repo: p.repo,
        number: p.number,
        state: state(p.state),
        head: p.commit,
        draft: false,
        mergeable: true,
        ...merge(p.merge),
      });
    }
    if (awaitingDeploymentCi(t) && t.deployment?.commit) {
      running.push({ repo: t.deployment.repo, commit: t.deployment.commit });
    }
  }
  return { pulls, running };
}

/**
 * 作業履歴のイベント（古い順）。capture.mjs が、撮る間にデーモンが書き足していないかを確かめるのに使う。
 * @param {string} home SACTY_HOME
 * @returns {{ type: string, actor: string, task: string }[]} task はタスクの題
 */
export function readActivity(home) {
  const activity = new SqliteActivityStore(join(home, "sacty.db"));
  try {
    const events = activity.all();
    const tasks = project(events);
    return events.map((e) => ({
      type: e.type,
      actor: e.actor,
      task: tasks.get(e.taskId)?.title ?? e.taskId,
    }));
  } finally {
    activity.close();
  }
}

/**
 * 撮る間に、github-stub.mjs が断った GitHub の API への問い合わせ（書き込みと、答えを用意していない問い合わせ。重複は除く）。
 * capture.mjs が、撮る間にデーモンが GitHub を変えようとしていないかを確かめるのに使う。
 * @param {string} home SACTY_HOME
 * @returns {string[]}
 */
export function readRefused(home) {
  const file = join(home, GITHUB_REFUSED);
  if (!existsSync(file)) return [];
  return [...new Set(readFileSync(file, "utf8").split("\n").filter(Boolean))];
}
