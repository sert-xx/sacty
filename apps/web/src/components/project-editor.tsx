"use client";

import { type Project, type ProjectTarget, targetUrlProblem } from "@sacty/core";
import { RefreshCwIcon, XIcon } from "lucide-react";
import { startTransition, useActionState, useEffect, useId, useState, useTransition } from "react";
import {
  reloadGitHubAccountsAction,
  type SaveProjectState,
  saveProjectAction,
} from "@/app/actions";
import { ContextPreviewPanel } from "@/components/context-preview";
import { Button } from "@/components/ui/button";
import { Hint } from "@/components/ui/hint";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useMessages } from "@/i18n/client";
import type { GitHubAccounts, ProjectPlatforms } from "@/lib/daemon";
import { githubAccountChoices } from "@/lib/github-accounts";

const initial: SaveProjectState = {};

/** 画面で編集する、チケットの取り込み先の1行（PBI-52）。 */
type TicketRow = { platform: string; service: "jira-cloud" | "jira-server"; keys: string };

/** 画面で編集する、共用の compose の1行（PBI-70）。空の ref・説明は保存しない。 */
type SharedRow = { name: string; repo: string; ref: string; file: string; description: string };

type Exclusion = { org: string; repos: { repo: string; projectName: string }[] };

const SELECT =
  "h-9 rounded-md border border-input bg-card px-2 text-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none";

/**
 * プロジェクトの設定：名前、対象（Org・リポジトリ。PBI-25）、コンテキストリポジトリ、GitHub アカウント。Slack の通知は
 * sacty の設定にある（PBI-115）。
 */
export function ProjectEditor({
  project,
  exclusions = [],
  github: initialGithub,
  images = [],
  platforms: hostPlatforms = [],
  projectPlatforms,
}: {
  project?: Project;
  exclusions?: Exclusion[];
  /** gh にログイン済みのアカウント（PBI-13）。分からなければ、その理由。 */
  github?: GitHubAccounts;
  /** 対象で選べる、言語ごとのイメージ（config.yaml の images。PBI-41）。 */
  images?: { name: string; description: string }[];
  /** チケットの取り込み先に選べる接続先（gateway.platforms の名前。PBI-52）。 */
  platforms?: string[];
  /**
   * プロジェクトで使える外部 PF（ホストの PF と、保存したコンテキストの platforms.yaml の PF。PBI-74）。設定画面で
   * だけ渡す。あれば、一覧を出し、チケットの取り込み先にも選べるようにする。
   */
  projectPlatforms?: ProjectPlatforms;
}) {
  // チケットの取り込み先に選べる接続先は、プロジェクトで使える PF（分からなければ、ホストの PF）
  const platforms = projectPlatforms
    ? [...new Set([...hostPlatforms, ...projectPlatforms.platforms.map((p) => p.name)])]
    : hostPlatforms;
  const [state, formAction, pending] = useActionState(saveProjectAction, initial);
  // 設定を読み込んだときの版。保存するときに送り、その後にほかの保存で変わっていれば、上書きせずに知らせる（PBI-274）。
  // 自分が保存したら、その版に進める（画面の再取得では進めない。ほかの保存の内容を見ていないため）
  const [baseUpdatedAt, setBaseUpdatedAt] = useState(project?.updatedAt ?? "");
  useEffect(() => {
    if (state.updatedAt) setBaseUpdatedAt(state.updatedAt);
  }, [state.updatedAt]);
  // 前の画面が隠れて残ることがあるので、id は固定にせず画面ごとに作る
  const uid = useId();
  const messages = useMessages();
  const { editor: t, scope: scopeLabel } = messages.projects;
  // gh のアカウントは、画面から読み直せる（gh にログインし直したあと。編集中の入力は残す）
  const [github, setGithub] = useState(initialGithub);
  const [reloadingAccounts, startReloadAccounts] = useTransition();
  const reloadAccounts = () =>
    startReloadAccounts(async () => {
      setGithub(await reloadGitHubAccountsAction());
    });
  const accounts = github && "accounts" in github ? github.accounts : [];
  const [name, setName] = useState(project?.name ?? "");
  const [targets, setTargets] = useState<ProjectTarget[]>(project?.targets ?? []);
  // チケットの取り込み先（PBI-52）。キーは編集しやすいよう、カンマ区切りの文字列で持つ
  const [tickets, setTickets] = useState<TicketRow[]>(
    (project?.tickets ?? []).map((t) => ({ ...t, keys: t.keys.join(", ") })),
  );
  const updateTicket = (i: number, patch: Partial<TicketRow>) =>
    setTickets((list) => list.map((t, j) => (j === i ? { ...t, ...patch } : t)));
  const [contextRepo, setContextRepo] = useState(project?.context?.repo ?? "");
  // 共用の compose（PBI-70）
  const [shared, setShared] = useState<SharedRow[]>(
    (project?.sharedComposes ?? []).map((s) => ({
      name: s.name,
      repo: s.repo,
      ref: s.ref ?? "",
      file: s.file,
      description: s.description ?? "",
    })),
  );
  const updateShared = (i: number, patch: Partial<SharedRow>) =>
    setShared((list) => list.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  // GitHub のアカウントは、ホストごとに選ぶ（PBI-40）。対象のホストは必ず選び、コンテキストリポジトリのホストと
  // 保存済みのホストも選べる。空は「選ばない」（そのホストは、ホストの git の認証を使う）
  const [chosenAccounts, setChosenAccounts] = useState<Record<string, string>>(
    project?.githubAccounts ?? {},
  );
  const { hosts, githubAccounts, missing } = githubAccountChoices({
    targets,
    contextRepo,
    sharedRepos: shared.map((s) => s.repo),
    chosen: chosenAccounts,
    accounts,
  });
  // 設定画面（project あり）では、対象のホストのアカウントを選ぶまで保存させない
  const needsAccount = Boolean(project) && missing;
  const [contextRef, setContextRef] = useState(project?.context?.ref ?? "");
  // リポジトリの中のディレクトリ（モノレポの一部をコンテキストにする）。空ならリポジトリの根
  const [contextPath, setContextPath] = useState(project?.context?.path ?? "");
  const definition = JSON.stringify({
    name,
    targets,
    // コンテキストリポジトリは、空なら渡さない
    ...(contextRepo.trim()
      ? {
          context: {
            repo: contextRepo.trim(),
            ...(contextRef.trim() ? { ref: contextRef.trim() } : {}),
            ...(contextPath.trim() ? { path: contextPath.trim() } : {}),
          },
        }
      : {}),
    ...(hosts.length > 0 ? { githubAccounts } : {}),
    // チケットの取り込み先（PBI-52）。キーは、カンマか空白で区切って書く
    ...(tickets.length > 0
      ? {
          tickets: tickets.map((ticket) => ({
            platform: ticket.platform,
            service: ticket.service,
            keys: ticket.keys
              .split(/[\s,、]+/)
              .map((k) => k.trim())
              .filter(Boolean),
          })),
        }
      : {}),
    // 共用の compose（PBI-70）
    ...(shared.length > 0
      ? {
          sharedComposes: shared.map((s) => ({
            name: s.name.trim(),
            repo: s.repo.trim(),
            ...(s.ref.trim() ? { ref: s.ref.trim() } : {}),
            file: s.file.trim(),
            ...(s.description.trim() ? { description: s.description.trim() } : {}),
          })),
        }
      : {}),
  });

  const updateTarget = (i: number, patch: Partial<ProjectTarget>) =>
    setTargets((list) => list.map((t, j) => (j === i ? ({ ...t, ...patch } as ProjectTarget) : t)));

  return (
    <form
      // action に渡すと、送信の後に React がフォームをリセットし、プルダウン（GitHub アカウントや対象の単位）の
      // 表示だけが最初の選択肢に戻ってしまう（状態は変わらないので書き直されない）。送信は自分で呼び出す
      onSubmit={(e) => {
        e.preventDefault();
        const data = new FormData(e.currentTarget);
        startTransition(() => formAction(data));
      }}
      className="flex flex-col gap-6"
    >
      <input type="hidden" name="id" value={project?.id ?? ""} />
      <input type="hidden" name="baseUpdatedAt" value={baseUpdatedAt} />
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
              {t.targetsTitle} <Hint text={t.targetsHint} />
            </h2>
            <p className="text-sm leading-6 text-warn">{t.prNotice}</p>
            {targets.length === 0 && <p className="text-sm text-muted-foreground">{t.noTargets}</p>}
            <ul className="flex flex-col gap-2.5">
              {targets.map((target, i) => {
                const excluded =
                  target.scope === "org"
                    ? exclusions.find(
                        (e) =>
                          e.org.toLowerCase() ===
                          target.target.trim().replace(/\/+$/, "").toLowerCase(),
                      )
                    : undefined;
                // 読めない URL は、対象のホストにならず、アカウントの欄にも出ない。どこが違うのかをその場で示す
                const urlProblem = targetUrlProblem(target.scope, target.target);
                const imageDescription = images.find(
                  (image) => image.name === target.image,
                )?.description;
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
                        {target.scope === "org" ? t.orgTarget : t.repoTarget}
                        <Input
                          id={`${uid}-target-${i}-target`}
                          value={target.target}
                          className="font-mono"
                          placeholder={
                            target.scope === "org"
                              ? "https://github.com/acme"
                              : "https://github.com/acme/payments"
                          }
                          onChange={(e) => updateTarget(i, { target: e.target.value })}
                        />
                      </label>
                      {/* イメージ（PBI-41）。images を書いていて、選べるときだけ出す。説明が長いと選択肢も
                          長くなって崩れるので、選択肢は名前だけにして、選んだイメージの説明は行の下に折り返して出す */}
                      {(images.length > 0 || target.image) && (
                        <label className="flex min-w-48 flex-1 flex-col gap-1 text-xs text-muted-foreground">
                          {t.image}
                          <select
                            className={`${SELECT} w-full min-w-0`}
                            aria-describedby={
                              imageDescription ? `${uid}-target-${i}-image-description` : undefined
                            }
                            value={target.image ?? ""}
                            onChange={(e) =>
                              updateTarget(i, { image: e.target.value || undefined })
                            }
                          >
                            <option value="">{t.imageAuto}</option>
                            <option value="default">{t.imageDefault}</option>
                            {images.map((image) => (
                              <option key={image.name} value={image.name} title={image.description}>
                                {image.name}
                              </option>
                            ))}
                            {target.image &&
                              target.image !== "default" &&
                              !images.some((image) => image.name === target.image) && (
                                <option value={target.image}>{t.imageMissing(target.image)}</option>
                              )}
                          </select>
                        </label>
                      )}
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
                    {imageDescription && (
                      <p
                        id={`${uid}-target-${i}-image-description`}
                        className="text-xs leading-5 wrap-anywhere text-muted-foreground"
                      >
                        {t.imageDescription(imageDescription)}
                      </p>
                    )}
                    {urlProblem && (
                      <p role="alert" className="text-xs text-warn">
                        {messages.labels.text({ code: urlProblem })}
                      </p>
                    )}
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
            aria-labelledby="context"
            className="flex flex-col gap-3 rounded-xl border border-border bg-card p-5"
          >
            <h2 id="context" className="text-[15px] font-semibold">
              {t.contextTitle} <Hint text={t.contextHint} />
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
              <label
                htmlFor={`${uid}-context-path`}
                className="flex min-w-40 flex-1 flex-col gap-1 text-xs text-muted-foreground"
              >
                {t.contextPath}
                <Input
                  id={`${uid}-context-path`}
                  value={contextPath}
                  placeholder={t.contextPathPlaceholder}
                  disabled={!contextRepo.trim()}
                  onChange={(e) => setContextPath(e.target.value)}
                  className="font-mono"
                />
              </label>
            </div>
          </section>

          {/* コンテキストの合成の結果のプレビュー（PBI-76）。保存した設定でも、編集中の設定でも作れる */}
          <ContextPreviewPanel projectId={project.id} definition={definition} />

          {projectPlatforms && (
            <section
              aria-labelledby="platforms"
              className="flex flex-col gap-3 rounded-xl border border-border bg-card p-5"
            >
              <h2 id="platforms" className="text-[15px] font-semibold">
                {t.platformsTitle} <Hint text={t.platformsHint} />
              </h2>
              {projectPlatforms.error !== undefined && (
                <p role="alert" className="text-sm text-warn">
                  {t.platformsError} {messages.labels.text(projectPlatforms.error)}
                </p>
              )}
              {projectPlatforms.warnings.map((w, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: 警告は並びのまま出す
                <p key={i} className="text-sm text-warn">
                  {messages.labels.text(w)}
                </p>
              ))}
              {projectPlatforms.platforms.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t.platformsNone}</p>
              ) : (
                <ul className="flex flex-col gap-2.5">
                  {projectPlatforms.platforms.map((p) => (
                    <li
                      key={p.name}
                      className="flex flex-col gap-1 rounded-lg border border-border p-3 text-sm"
                    >
                      <div className="flex flex-wrap items-baseline gap-x-2">
                        <span className="font-mono font-semibold">{p.name}</span>
                        <span className="text-xs text-muted-foreground">
                          {p.from ? t.platformFrom(p.from) : t.platformFromHost}
                        </span>
                      </div>
                      {p.description && <p>{p.description}</p>}
                      <div className="text-xs text-muted-foreground">{t.platformAllow}</div>
                      <ul className="flex flex-col gap-0.5 font-mono text-xs break-all">
                        {p.allow.map((rule) => (
                          <li key={rule}>{rule}</li>
                        ))}
                      </ul>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}

          <section
            aria-labelledby="shared-compose"
            className="flex flex-col gap-3 rounded-xl border border-border bg-card p-5"
          >
            <h2 id="shared-compose" className="text-[15px] font-semibold">
              {t.sharedTitle} <Hint text={t.sharedHint} />
            </h2>
            <ul className="flex flex-col gap-2.5">
              {shared.map((row, i) => (
                <li
                  // biome-ignore lint/suspicious/noArrayIndexKey: 行は位置で編集する
                  key={i}
                  className="flex flex-col gap-2 rounded-lg border border-border p-3"
                >
                  <div className="flex flex-wrap items-end gap-2">
                    <label
                      htmlFor={`${uid}-shared-${i}-name`}
                      className="flex w-36 flex-col gap-1 text-xs text-muted-foreground"
                    >
                      {t.sharedName}
                      <Input
                        id={`${uid}-shared-${i}-name`}
                        value={row.name}
                        maxLength={40}
                        placeholder={t.sharedNamePlaceholder}
                        onChange={(e) => updateShared(i, { name: e.target.value })}
                        className="font-mono"
                      />
                    </label>
                    <label
                      htmlFor={`${uid}-shared-${i}-repo`}
                      className="flex min-w-64 flex-[2] flex-col gap-1 text-xs text-muted-foreground"
                    >
                      {t.sharedRepo}
                      <Input
                        id={`${uid}-shared-${i}-repo`}
                        value={row.repo}
                        placeholder={t.sharedRepoPlaceholder}
                        onChange={(e) => updateShared(i, { repo: e.target.value })}
                        className="font-mono"
                      />
                    </label>
                    <label
                      htmlFor={`${uid}-shared-${i}-ref`}
                      className="flex min-w-32 flex-1 flex-col gap-1 text-xs text-muted-foreground"
                    >
                      {t.sharedRef}
                      <Input
                        id={`${uid}-shared-${i}-ref`}
                        value={row.ref}
                        placeholder={t.sharedRefPlaceholder}
                        onChange={(e) => updateShared(i, { ref: e.target.value })}
                        className="font-mono"
                      />
                    </label>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-lg"
                      aria-label={t.removeShared(row.name)}
                      title={t.remove}
                      onClick={() => setShared((list) => list.filter((_, j) => j !== i))}
                    >
                      <XIcon aria-hidden="true" />
                    </Button>
                  </div>
                  <div className="flex flex-wrap items-end gap-2">
                    <label
                      htmlFor={`${uid}-shared-${i}-file`}
                      className="flex min-w-56 flex-1 flex-col gap-1 text-xs text-muted-foreground"
                    >
                      {t.sharedFile}
                      <Input
                        id={`${uid}-shared-${i}-file`}
                        value={row.file}
                        placeholder={t.sharedFilePlaceholder}
                        onChange={(e) => updateShared(i, { file: e.target.value })}
                        className="font-mono"
                      />
                    </label>
                    <label
                      htmlFor={`${uid}-shared-${i}-description`}
                      className="flex min-w-64 flex-[2] flex-col gap-1 text-xs text-muted-foreground"
                    >
                      {t.sharedDescription}
                      <Input
                        id={`${uid}-shared-${i}-description`}
                        value={row.description}
                        maxLength={1000}
                        placeholder={t.sharedDescriptionPlaceholder}
                        onChange={(e) => updateShared(i, { description: e.target.value })}
                      />
                    </label>
                  </div>
                </li>
              ))}
            </ul>
            <Button
              type="button"
              variant="outline"
              className="w-fit"
              disabled={shared.length >= 20}
              onClick={() =>
                setShared((list) => [
                  ...list,
                  { name: "", repo: "", ref: "", file: "", description: "" },
                ])
              }
            >
              {t.addShared}
            </Button>
          </section>

          <section
            aria-labelledby="github"
            className="flex flex-col gap-3 rounded-xl border border-border bg-card p-5"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 id="github" className="text-[15px] font-semibold">
                {t.githubTitle} <Hint text={t.githubHint} />
              </h2>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={reloadingAccounts}
                onClick={reloadAccounts}
              >
                <RefreshCwIcon
                  data-icon="inline-start"
                  className={reloadingAccounts ? "animate-spin" : undefined}
                />
                {reloadingAccounts ? t.githubReloading : t.githubReload}
              </Button>
            </div>
            {!hosts.some((h) => h.required) && (
              <p className="text-sm text-muted-foreground">{t.githubNoTargets}</p>
            )}
            {targets.some((target) => targetUrlProblem(target.scope, target.target)) && (
              <p className="text-sm text-warn">{t.githubUnreadableTargets}</p>
            )}
            {hosts.map(({ host, required, forContext, forShared }) => {
              const current = githubAccounts[host] ?? "";
              const onHost = accounts.filter((a) => a.host === host);
              return (
                <div key={host} className="flex flex-col gap-1.5">
                  <Label htmlFor={`${uid}-github-${host}`}>
                    {t.githubAccount(host)}
                    {!required && (
                      <span className="font-normal text-muted-foreground">
                        {forContext
                          ? t.githubForContext
                          : forShared
                            ? t.githubForShared
                            : t.githubOptional}
                      </span>
                    )}
                  </Label>
                  <select
                    id={`${uid}-github-${host}`}
                    value={current}
                    onChange={(e) =>
                      setChosenAccounts((chosen) => ({ ...chosen, [host]: e.target.value }))
                    }
                    className={`${SELECT} max-w-md`}
                  >
                    {required && !current && (
                      <option value="" disabled>
                        {t.githubChoose}
                      </option>
                    )}
                    {/* 対象ではないホストは、選ばない（ホストの git の認証を使う）こともできる */}
                    {!required && <option value="">{t.githubNone}</option>}
                    {onHost.map((a) => (
                      <option key={a.login} value={a.login}>
                        {a.state === "success" ? a.login : t.githubUnverified(a.login)}
                      </option>
                    ))}
                    {/* 選んでいたアカウントが gh からログアウトしていても、そのまま見えるようにする */}
                    {current && !onHost.some((a) => a.login === current) && (
                      <option value={current}>{t.githubNotLoggedIn(current)}</option>
                    )}
                  </select>
                </div>
              );
            })}
            {github && "error" in github && (
              <p role="alert" className="text-sm text-warn">
                {messages.labels.text(github.error)}
              </p>
            )}
            {/* Sacty が gh から読めたアカウントの一覧。ドメインが合うのに選べないときの切り分けに使う */}
            {github && "accounts" in github && (
              <details className="text-sm">
                <summary className="cursor-pointer text-muted-foreground">
                  {t.githubKnownTitle(accounts.length)}
                </summary>
                <div className="mt-2 flex flex-col gap-2">
                  <p className="text-muted-foreground">{t.githubKnownHint}</p>
                  {accounts.length === 0 ? (
                    <p>{t.githubKnownNone}</p>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-left">
                        <thead className="text-muted-foreground">
                          <tr>
                            <th className="py-1 pr-4 font-normal">{t.githubKnownHost}</th>
                            <th className="py-1 pr-4 font-normal">{t.githubKnownLogin}</th>
                            <th className="py-1 font-normal">{t.githubKnownState}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {accounts.map((a) => (
                            <tr key={`${a.host}/${a.login}`} className="border-t border-border">
                              <td className="py-1 pr-4 font-mono">{a.host}</td>
                              <td className="py-1 pr-4">
                                {a.login}
                                {a.active && (
                                  <span className="text-muted-foreground">
                                    {" "}
                                    ({t.githubStateActive})
                                  </span>
                                )}
                              </td>
                              <td className="py-1">
                                {a.state === "success" ? (
                                  t.githubStateOk
                                ) : (
                                  <span className="text-warn">
                                    {t.githubStateFailed(a.state)}
                                    {a.error && (
                                      <span className="block break-all text-xs text-muted-foreground">
                                        {a.error}
                                      </span>
                                    )}
                                  </span>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              </details>
            )}
          </section>

          <section
            aria-labelledby="tickets"
            className="flex flex-col gap-3 rounded-xl border border-border bg-card p-5"
          >
            <h2 id="tickets" className="text-[15px] font-semibold">
              {t.ticketsTitle} <Hint text={t.ticketsHint} />
            </h2>
            {platforms.length === 0 && (
              <p className="text-sm leading-6 text-muted-foreground">{t.ticketsNoPlatforms}</p>
            )}
            <ul className="flex flex-col gap-2.5">
              {tickets.map((ticket, i) => (
                <li
                  // biome-ignore lint/suspicious/noArrayIndexKey: 行は位置で編集する
                  key={i}
                  className="flex flex-wrap items-end gap-2 rounded-lg border border-border p-3"
                >
                  <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                    {t.ticketPlatform}
                    <select
                      className={SELECT}
                      value={ticket.platform}
                      onChange={(e) => updateTicket(i, { platform: e.target.value })}
                    >
                      {[...new Set([ticket.platform, ...platforms])].filter(Boolean).map((name) => (
                        <option key={name} value={name}>
                          {name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                    {t.ticketService}
                    <select
                      className={SELECT}
                      value={ticket.service}
                      onChange={(e) =>
                        updateTicket(i, { service: e.target.value as TicketRow["service"] })
                      }
                    >
                      <option value="jira-server">{t.ticketServiceServer}</option>
                      <option value="jira-cloud">{t.ticketServiceCloud}</option>
                    </select>
                  </label>
                  <label
                    htmlFor={`${uid}-ticket-${i}-keys`}
                    className="flex min-w-48 flex-1 flex-col gap-1 text-xs text-muted-foreground"
                  >
                    {t.ticketKeys}
                    <Input
                      id={`${uid}-ticket-${i}-keys`}
                      value={ticket.keys}
                      className="font-mono"
                      placeholder={t.ticketKeysPlaceholder}
                      onChange={(e) => updateTicket(i, { keys: e.target.value })}
                    />
                  </label>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-lg"
                    aria-label={t.removeTicket(ticket.platform)}
                    title={t.remove}
                    onClick={() => setTickets((list) => list.filter((_, j) => j !== i))}
                  >
                    <XIcon aria-hidden="true" />
                  </Button>
                </li>
              ))}
            </ul>
            <Button
              type="button"
              variant="outline"
              className="w-fit"
              disabled={platforms.length === 0}
              onClick={() =>
                setTickets((list) => [
                  ...list,
                  { platform: platforms[0] ?? "", service: "jira-server", keys: "" },
                ])
              }
            >
              {t.addTicket}
            </Button>
          </section>
        </>
      )}

      {state.message && (
        <p role="alert" className="text-sm leading-6 whitespace-pre-line text-warn">
          {state.message}
        </p>
      )}
      {/* 読み込んだ後にほかの保存で変わっていた。編集中の入力は、再読み込みするまで残す（PBI-274） */}
      {state.conflict && (
        <div className="flex flex-col gap-2">
          <p className="text-sm leading-6 text-muted-foreground">{t.reloadLatestNote}</p>
          <Button
            type="button"
            variant="outline"
            onClick={() => window.location.reload()}
            className="w-fit"
          >
            <RefreshCwIcon aria-hidden="true" />
            {t.reloadLatest}
          </Button>
        </div>
      )}
      {state.saved && !state.message && !state.contextError && (
        <p role="status" className="text-sm text-accent-foreground">
          {t.saved}
        </p>
      )}
      {/* 保存したが、コンテキストに誤りがある（PBI-76） */}
      {state.saved && state.contextError && (
        <p role="alert" className="text-sm leading-6 whitespace-pre-line text-warn">
          {t.savedContextError(state.contextError)}
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
