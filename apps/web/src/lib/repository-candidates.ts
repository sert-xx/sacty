/**
 * タスクの作成のダイアログで使う、対象リポジトリの候補（PBI-109）。
 *
 * 候補は、ダイアログを開いたときに読む（Org の対象は gh で GitHub に問い合わせるので、遅いことがある）。画面の描画では
 * 読まないので、「タスクを作成」ボタンは候補を待たずに出て、画面の自動の更新のたびに GitHub に問い合わせ直さない。
 */
export type RepositoryCandidates =
  | { status: "loading" }
  | { status: "loaded"; repositories: string[]; problems: string[] }
  | { status: "failed"; message: string };

/** 候補を返す画面のパス（apps/web/src/app/projects/[id]/repositories/route.ts）。 */
export function repositoryCandidatesPath(projectId: string): string {
  return `/projects/${encodeURIComponent(projectId)}/repositories`;
}

/**
 * 候補を読む。失敗しても投げず、理由を返す（noAnswer は、理由を受け取れなかったときの文言）。
 * 返す文言（読めなかった Org の理由など）は、画面の言語でサーバーが作る。
 */
export async function fetchRepositoryCandidates(
  projectId: string,
  noAnswer: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Exclude<RepositoryCandidates, { status: "loading" }>> {
  try {
    const res = await fetchImpl(repositoryCandidatesPath(projectId), { cache: "no-store" });
    const body = (await res.json().catch(() => undefined)) as
      | { repositories?: unknown; problems?: unknown; message?: unknown }
      | undefined;
    if (!res.ok || !body || !Array.isArray(body.repositories)) {
      return {
        status: "failed",
        message: typeof body?.message === "string" ? body.message : noAnswer,
      };
    }
    return {
      status: "loaded",
      repositories: body.repositories.filter((r): r is string => typeof r === "string"),
      problems: Array.isArray(body.problems)
        ? body.problems.filter((p): p is string => typeof p === "string")
        : [],
    };
  } catch {
    return { status: "failed", message: noAnswer };
  }
}

/**
 * ダイアログを開くたびに候補を読む（開いたときだけ読む。画面の自動の更新では読まない）。開き直したときは、前に開いたときの
 * 読み込みの結果を捨てる（遅れて届いた結果で、今の候補を上書きしない）。対象の無いプロジェクトでは読まない。
 */
export function candidatesLoader(load = fetchRepositoryCandidates) {
  let latest = 0;
  return (
    projectId: string,
    hasTargets: boolean,
    noAnswer: string,
    set: (candidates: RepositoryCandidates) => void,
  ): void => {
    const current = ++latest;
    if (!hasTargets) return;
    set({ status: "loading" });
    void load(projectId, noAnswer).then((result) => {
      if (latest === current) set(result);
    });
  };
}
