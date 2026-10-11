"use client";

import { INTAKE_LABEL, type Project, type ProjectTarget } from "@sacty/core";
import { XIcon } from "lucide-react";
import { useActionState, useId, useState } from "react";
import { type SaveProjectState, saveProjectAction } from "@/app/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useMessages } from "@/i18n/client";
import type { GitHubAccounts } from "@/lib/daemon";

const initial: SaveProjectState = {};

type Exclusion = { org: string; repos: { repo: string; projectName: string }[] };

const SELECT =
  "h-9 rounded-md border border-input bg-card px-2 text-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none";

/** プロジェクトの設定：名前、対象（Org・リポジトリ。PBI-25）、GitHub アカウント、コンテキストリポジトリ。 */
export function ProjectEditor({
  project,
  exclusions = [],
  github,
}: {
  project?: Project;
  exclusions?: Exclusion[];
  /** gh にログイン済みのアカウント（PBI-13）。分からなければ、その理由。 */
  github?: GitHubAccounts;
}) {
  const [state, formAction, pending] = useActionState(saveProjectAction, initial);
  // 前の画面が隠れて残ることがあるので、id は固定にせず画面ごとに作る
  const uid = useId();
  const messages = useMessages();
  const { editor: t, scope: scopeLabel } = messages.projects;
  const accounts = github && "accounts" in github ? github.accounts : [];
  // GitHub のアカウントは必ず選ぶ。まだ選んでいなければ、gh のアクティブなアカウントを選んでおく
  // （保存すると、そのアカウントに固定される。gh で切り替えても変わらない）
  const [githubAccount, setGithubAccount] = useState(
    project?.githubAccount ?? accounts.find((a) => a.active)?.login ?? "",
  );
  // 設定画面（project あり）では、アカウントを選ぶまで保存させない
  const needsAccount = Boolean(project) && !githubAccount;
  const [name, setName] = useState(project?.name ?? "");
  const [targets, setTargets] = useState<ProjectTarget[]>(project?.targets ?? []);
  const [contextRepo, setContextRepo] = useState(project?.context?.repo ?? "");
  const [contextRef, setContextRef] = useState(project?.context?.ref ?? "");
  const definition = JSON.stringify({
    name,
    targets,
    // コンテキストリポジトリは、空なら渡さない
    ...(contextRepo.trim()
      ? {
          context: {
            repo: contextRepo.trim(),
            ...(contextRef.trim() ? { ref: contextRef.trim() } : {}),
          },
        }
      : {}),
    ...(githubAccount ? { githubAccount } : {}),
  });

  const updateTarget = (i: number, patch: Partial<ProjectTarget>) =>
    setTargets((list) => list.map((t, j) => (j === i ? ({ ...t, ...patch } as ProjectTarget) : t)));

  return (
    <form action={formAction} className="flex flex-col gap-6">
      <input type="hidden" name="id" value={project?.id ?? ""} />
      <input type="hidden" name="definition" value={definition} />

      <section className="flex flex-col gap-2 rounded-xl border border-border bg-card p-5">
        <Label htmlFor={`${uid}-name`}>{t.name}</Label>
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
            aria-labelledby="targets"
            className="flex flex-col gap-3 rounded-xl border border-border bg-card p-5"
          >
            <h2 id="targets" className="text-[15px] font-semibold">
              {t.targetsTitle}{" "}
              <span className="text-[13px] font-normal text-muted-foreground">{t.targetsNote}</span>
            </h2>
            <p className="text-sm leading-6 text-muted-foreground">{t.targetsHelp(INTAKE_LABEL)}</p>
            <p className="text-sm leading-6 text-warn">{t.prNotice}</p>
            {targets.length === 0 && <p className="text-sm text-muted-foreground">{t.noTargets}</p>}
            <ul className="flex flex-col gap-2.5">
              {targets.map((target, i) => {
                const excluded =
                  target.scope === "org"
                    ? exclusions.find((e) => e.org.toLowerCase() === target.target.toLowerCase())
                    : undefined;
                return (
                  <li
                    // biome-ignore lint/suspicious/noArrayIndexKey: 行は位置で編集する
                    key={i}
                    className="flex flex-col gap-2 rounded-lg border border-border p-3"
                  >
                    <div className="flex flex-wrap items-end gap-2">
                      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                        {t.scope}
                        <select
                          className={SELECT}
                          value={target.scope}
                          onChange={(e) =>
                            updateTarget(i, { scope: e.target.value as ProjectTarget["scope"] })
                          }
                        >
                          <option value="org">{scopeLabel.org}</option>
                          <option value="repo">{scopeLabel.repo}</option>
                        </select>
                      </label>
                      <label
                        htmlFor={`${uid}-target-${i}-target`}
                        className="flex min-w-48 flex-1 flex-col gap-1 text-xs text-muted-foreground"
                      >
                        {target.scope === "org" ? scopeLabel.org : t.repoTarget}
                        <Input
                          id={`${uid}-target-${i}-target`}
                          value={target.target}
                          placeholder={target.scope === "org" ? "acme" : "acme/payments"}
                          onChange={(e) => updateTarget(i, { target: e.target.value })}
                        />
                      </label>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-lg"
                        aria-label={t.removeTarget(target.target)}
                        title={t.remove}
                        onClick={() => setTargets((list) => list.filter((_, j) => j !== i))}
                      >
                        <XIcon aria-hidden="true" />
                      </Button>
                    </div>
                    {excluded && excluded.repos.length > 0 && (
                      <div className="text-xs leading-5 text-muted-foreground">
                        <p>{t.excluded}</p>
                        <ul className="list-disc pl-5">
                          {excluded.repos.map((r) => (
                            <li key={r.repo}>
                              <span className="font-mono">{r.repo}</span>
                              {t.excludedBy(r.projectName)}
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
              onClick={() => setTargets((list) => [...list, { scope: "repo", target: "" }])}
            >
              {t.addTarget}
            </Button>
          </section>

          <section
            aria-labelledby="github"
            className="flex flex-col gap-3 rounded-xl border border-border bg-card p-5"
          >
            <h2 id="github" className="text-[15px] font-semibold">
              {t.githubTitle}{" "}
              <span className="text-[13px] font-normal text-muted-foreground">{t.githubNote}</span>
            </h2>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${uid}-github`}>{t.githubAccount}</Label>
              <select
                id={`${uid}-github`}
                value={githubAccount}
                onChange={(e) => setGithubAccount(e.target.value)}
                className={`${SELECT} max-w-md`}
              >
                {!githubAccount && (
                  <option value="" disabled>
                    {t.githubChoose}
                  </option>
                )}
                {accounts.map((a) => (
                  <option key={a.login} value={a.login}>
                    {a.login}
                  </option>
                ))}
                {/* 選んでいたアカウントが gh からログアウトしていても、そのまま見えるようにする */}
                {githubAccount && !accounts.some((a) => a.login === githubAccount) && (
                  <option value={githubAccount}>{t.githubNotLoggedIn(githubAccount)}</option>
                )}
              </select>
            </div>
            {github && "error" in github && (
              <p role="alert" className="text-sm text-warn">
                {messages.labels.text(github.error)}
              </p>
            )}
            <p className="text-xs text-muted-foreground">{t.githubHelp}</p>
          </section>

          <section
            aria-labelledby="context"
            className="flex flex-col gap-3 rounded-xl border border-border bg-card p-5"
          >
            <h2 id="context" className="text-[15px] font-semibold">
              {t.contextTitle}{" "}
              <span className="text-[13px] font-normal text-muted-foreground">{t.contextNote}</span>
            </h2>
            <div className="flex flex-wrap items-end gap-2">
              <label
                htmlFor={`${uid}-context-repo`}
                className="flex min-w-64 flex-[2] flex-col gap-1 text-xs text-muted-foreground"
              >
                {t.contextRepo}
                <Input
                  id={`${uid}-context-repo`}
                  value={contextRepo}
                  placeholder={t.contextRepoPlaceholder}
                  onChange={(e) => setContextRepo(e.target.value)}
                  className="font-mono"
                />
              </label>
              <label
                htmlFor={`${uid}-context-ref`}
                className="flex min-w-40 flex-1 flex-col gap-1 text-xs text-muted-foreground"
              >
                {t.contextRef}
                <Input
                  id={`${uid}-context-ref`}
                  value={contextRef}
                  placeholder={t.contextRefPlaceholder}
                  // ブランチ・タグは、リポジトリを設定したときだけ使う
                  disabled={!contextRepo.trim()}
                  onChange={(e) => setContextRef(e.target.value)}
                  className="font-mono"
                />
              </label>
            </div>
            <p className="text-xs leading-5 text-muted-foreground">{t.contextHelp}</p>
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
          {t.saved}
        </p>
      )}
      {needsAccount && (
        <p role="alert" className="text-sm text-warn">
          {t.githubRequired}
        </p>
      )}
      <Button type="submit" disabled={pending || needsAccount} className="min-h-11 w-fit px-6">
        {project ? t.save : t.create}
      </Button>
    </form>
  );
}
