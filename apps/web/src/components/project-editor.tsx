"use client";

import type { IssueSource, Project, RepositorySettings } from "@sacty/core";
import { useActionState, useId, useState } from "react";
import { type SaveProjectState, saveProjectAction } from "@/app/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const initial: SaveProjectState = {};

type Exclusion = { org: string; repos: { repo: string; projectName: string }[] };

const SELECT =
  "h-9 rounded-md border border-input bg-card px-2 text-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none";

/** プロジェクトの設定：名前、GitHub Issue の取り込み元、実装の対象リポジトリの設定。 */
export function ProjectEditor({
  project,
  exclusions = [],
}: {
  project?: Project;
  exclusions?: Exclusion[];
}) {
  const [state, formAction, pending] = useActionState(saveProjectAction, initial);
  // 前の画面が隠れて残ることがあるので、id は固定にせず画面ごとに作る
  const uid = useId();
  const [name, setName] = useState(project?.name ?? "");
  const [sources, setSources] = useState<IssueSource[]>(project?.sources ?? []);
  const [repos, setRepos] = useState<RepositorySettings[]>(project?.repositories ?? []);
  const definition = JSON.stringify({ name, sources, repositories: repos });

  const updateSource = (i: number, patch: Partial<IssueSource>) =>
    setSources((list) => list.map((s, j) => (j === i ? ({ ...s, ...patch } as IssueSource) : s)));
  const updateRepo = (i: number, patch: Partial<RepositorySettings>) =>
    setRepos((list) => list.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  return (
    <form action={formAction} className="flex flex-col gap-6">
      <input type="hidden" name="id" value={project?.id ?? ""} />
      <input type="hidden" name="definition" value={definition} />

      <section className="flex flex-col gap-2 rounded-xl border border-border bg-card p-5">
        <Label htmlFor={`${uid}-name`}>名前</Label>
        <Input
          id={`${uid}-name`}
          value={name}
          maxLength={80}
          onChange={(e) => setName(e.target.value)}
          className="max-w-md"
        />
      </section>

      {project && (
        <>
          <section
            aria-labelledby="sources"
            className="flex flex-col gap-3 rounded-xl border border-border bg-card p-5"
          >
            <h2 id="sources" className="text-[15px] font-semibold">
              GitHub Issue の取り込み元{" "}
              <span className="text-[13px] font-normal text-muted-foreground">
                ラベルの付いた、開いている Issue をタスクにします
              </span>
            </h2>
            <p className="text-sm leading-6 text-muted-foreground">
              同じ Org・同じリポジトリは、ほかのプロジェクトに登録できません。Org
              とその中のリポジトリが別のプロジェクトに登録されていれば、リポジトリの指定が優先します。
            </p>
            {sources.length === 0 && (
              <p className="text-sm text-muted-foreground">取り込み元はありません。</p>
            )}
            <ul className="flex flex-col gap-2.5">
              {sources.map((source, i) => {
                const excluded =
                  source.scope === "org"
                    ? exclusions.find((e) => e.org.toLowerCase() === source.target.toLowerCase())
                    : undefined;
                return (
                  <li
                    // biome-ignore lint/suspicious/noArrayIndexKey: 行は位置で編集する
                    key={i}
                    className="flex flex-col gap-2 rounded-lg border border-border p-3"
                  >
                    <div className="flex flex-wrap items-end gap-2">
                      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                        単位
                        <select
                          className={SELECT}
                          value={source.scope}
                          onChange={(e) =>
                            updateSource(i, { scope: e.target.value as IssueSource["scope"] })
                          }
                        >
                          <option value="org">Org</option>
                          <option value="repo">リポジトリ</option>
                        </select>
                      </label>
                      <label
                        htmlFor={`${uid}-src-${i}-target`}
                        className="flex min-w-48 flex-1 flex-col gap-1 text-xs text-muted-foreground"
                      >
                        {source.scope === "org" ? "Org" : "リポジトリ（owner/name）"}
                        <Input
                          id={`${uid}-src-${i}-target`}
                          value={source.target}
                          placeholder={source.scope === "org" ? "acme" : "acme/payments"}
                          onChange={(e) => updateSource(i, { target: e.target.value })}
                        />
                      </label>
                      <label
                        htmlFor={`${uid}-src-${i}-label`}
                        className="flex w-40 flex-col gap-1 text-xs text-muted-foreground"
                      >
                        ラベル
                        <Input
                          id={`${uid}-src-${i}-label`}
                          value={source.label}
                          placeholder="sacty"
                          onChange={(e) => updateSource(i, { label: e.target.value })}
                        />
                      </label>
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => setSources((list) => list.filter((_, j) => j !== i))}
                      >
                        削除
                      </Button>
                    </div>
                    {excluded && excluded.repos.length > 0 && (
                      <div className="text-xs leading-5 text-muted-foreground">
                        <p>除外されるリポジトリ（ほかのプロジェクトが担当）：</p>
                        <ul className="list-disc pl-5">
                          {excluded.repos.map((r) => (
                            <li key={r.repo}>
                              <span className="font-mono">{r.repo}</span>（{r.projectName}）
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
            <Button
              type="button"
              variant="outline"
              className="w-fit"
              onClick={() =>
                setSources((list) => [...list, { scope: "repo", target: "", label: "sacty" }])
              }
            >
              取り込み元を追加
            </Button>
          </section>

          <section
            aria-labelledby="repositories"
            className="flex flex-col gap-3 rounded-xl border border-border bg-card p-5"
          >
            <h2 id="repositories" className="text-[15px] font-semibold">
              リポジトリの設定{" "}
              <span className="text-[13px] font-normal text-muted-foreground">
                Issue から作ったタスクは、その Issue のリポジトリに実装します
              </span>
            </h2>
            {repos.length === 0 && (
              <p className="text-sm text-muted-foreground">リポジトリの設定はありません。</p>
            )}
            <ul className="flex flex-col gap-2.5">
              {repos.map((repo, i) => (
                <li
                  // biome-ignore lint/suspicious/noArrayIndexKey: 行は位置で編集する
                  key={i}
                  className="flex flex-wrap items-end gap-2 rounded-lg border border-border p-3"
                >
                  <label
                    htmlFor={`${uid}-repo-${i}-repo`}
                    className="flex min-w-48 flex-1 flex-col gap-1 text-xs text-muted-foreground"
                  >
                    リポジトリ（owner/name）
                    <Input
                      id={`${uid}-repo-${i}-repo`}
                      value={repo.repo}
                      placeholder="acme/payments"
                      onChange={(e) => updateRepo(i, { repo: e.target.value })}
                    />
                  </label>
                  <label
                    htmlFor={`${uid}-repo-${i}-branch`}
                    className="flex w-36 flex-col gap-1 text-xs text-muted-foreground"
                  >
                    ベースブランチ
                    <Input
                      id={`${uid}-repo-${i}-branch`}
                      value={repo.baseBranch}
                      onChange={(e) => updateRepo(i, { baseBranch: e.target.value })}
                    />
                  </label>
                  <label
                    htmlFor={`${uid}-repo-${i}-test`}
                    className="flex min-w-48 flex-1 flex-col gap-1 text-xs text-muted-foreground"
                  >
                    テストのコマンド
                    <Input
                      id={`${uid}-repo-${i}-test`}
                      value={repo.testCommand}
                      placeholder="npm ci && npm test"
                      onChange={(e) => updateRepo(i, { testCommand: e.target.value })}
                      className="font-mono"
                    />
                  </label>
                  <label className="flex h-9 items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={repo.pullRequest}
                      onChange={(e) => updateRepo(i, { pullRequest: e.target.checked })}
                      className="size-4 accent-primary"
                    />
                    PRを作る
                  </label>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setRepos((list) => list.filter((_, j) => j !== i))}
                  >
                    削除
                  </Button>
                </li>
              ))}
            </ul>
            <Button
              type="button"
              variant="outline"
              className="w-fit"
              onClick={() =>
                setRepos((list) => [
                  ...list,
                  { repo: "", baseBranch: "main", testCommand: "", pullRequest: true },
                ])
              }
            >
              リポジトリの設定を追加
            </Button>
          </section>
        </>
      )}

      {state.message && (
        <p role="alert" className="text-sm leading-6 whitespace-pre-line text-warn">
          {state.message}
        </p>
      )}
      {state.saved && !state.message && (
        <p role="status" className="text-sm text-accent-foreground">
          保存しました。
        </p>
      )}
      <Button type="submit" disabled={pending} className="min-h-11 w-fit px-6">
        {project ? "保存する" : "作成する"}
      </Button>
    </form>
  );
}
