"use client";

import type { Project, ProjectTarget } from "@sacty/core";
import { XIcon } from "lucide-react";
import { startTransition, useActionState, useId, useState } from "react";
import {
  type SaveProjectState,
  saveProjectAction,
  type TestNotificationState,
  testNotificationAction,
} from "@/app/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useMessages } from "@/i18n/client";
import type { GitHubAccounts } from "@/lib/daemon";
import { githubAccountChoices } from "@/lib/github-accounts";

const initial: SaveProjectState = {};

/** 画面で編集する、チケットの取り込み先の1行（PBI-52）。 */
type TicketRow = { platform: string; service: "jira-cloud" | "jira-server"; keys: string };

type Exclusion = { org: string; repos: { repo: string; projectName: string }[] };

const SELECT =
  "h-9 rounded-md border border-input bg-card px-2 text-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none";

/** プロジェクトの設定：名前、対象（Org・リポジトリ。PBI-25）、コンテキストリポジトリ、GitHub アカウント、通知。 */
export function ProjectEditor({
  project,
  exclusions = [],
  github,
  images = [],
  platforms = [],
}: {
  project?: Project;
  exclusions?: Exclusion[];
  /** gh にログイン済みのアカウント（PBI-13）。分からなければ、その理由。 */
  github?: GitHubAccounts;
  /** 対象で選べる、言語ごとのイメージ（config.yaml の images。PBI-41）。 */
  images?: { name: string; description: string }[];
  /** チケットの取り込み先に選べる接続先（gateway.platforms の名前。PBI-52）。 */
  platforms?: string[];
}) {
  const [state, formAction, pending] = useActionState(saveProjectAction, initial);
  // 前の画面が隠れて残ることがあるので、id は固定にせず画面ごとに作る
  const uid = useId();
  const messages = useMessages();
  const { editor: t, scope: scopeLabel } = messages.projects;
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
  // GitHub のアカウントは、ホストごとに選ぶ（PBI-40）。対象のホストは必ず選び、コンテキストリポジトリのホストと
  // 保存済みのホストも選べる。空は「選ばない」（そのホストは、ホストの git の認証を使う）
  const [chosenAccounts, setChosenAccounts] = useState<Record<string, string>>(
    project?.githubAccounts ?? {},
  );
  const { hosts, githubAccounts, missing } = githubAccountChoices({
    targets,
    contextRepo,
    chosen: chosenAccounts,
    accounts,
  });
  // 設定画面（project あり）では、対象のホストのアカウントを選ぶまで保存させない
  const needsAccount = Boolean(project) && missing;
  const [contextRef, setContextRef] = useState(project?.context?.ref ?? "");
  // Slack の通知先（PBI-38）
  const saved = project?.notification;
  const [notifyKind, setNotifyKind] = useState<"" | "slack-api" | "slack-webhook">(
    saved?.kind ?? "",
  );
  const [notifyUrl, setNotifyUrl] = useState(saved?.kind === "slack-api" ? saved.url : "");
  const [notifyChannel, setNotifyChannel] = useState(
    saved?.kind === "slack-api" ? saved.channel : "",
  );
  const [notifyToken, setNotifyToken] = useState(
    saved?.kind === "slack-api" ? (saved.token ?? "") : "",
  );
  const [notifyWebhook, setNotifyWebhook] = useState(
    saved?.kind === "slack-webhook" ? saved.webhook : "",
  );
  const [notifyLanguage, setNotifyLanguage] = useState<"ja" | "en">(saved?.language ?? "ja");
  const notification =
    notifyKind === "slack-api"
      ? {
          kind: notifyKind,
          url: notifyUrl.trim(),
          channel: notifyChannel.trim(),
          ...(notifyToken.trim() ? { token: notifyToken.trim() } : {}),
          language: notifyLanguage,
        }
      : notifyKind === "slack-webhook"
        ? { kind: notifyKind, webhook: notifyWebhook.trim(), language: notifyLanguage }
        : undefined;
  const [testState, testAction, testing] = useActionState<TestNotificationState, FormData>(
    testNotificationAction,
    {},
  );
  // 保存していない変更があれば、テストの通知は送れない（保存した設定で送るため）
  const notificationChanged =
    JSON.stringify(notification ?? null) !== JSON.stringify(saved ?? null);
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
    ...(hosts.length > 0 ? { githubAccounts } : {}),
    ...(notification ? { notification } : {}),
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
            <p className="text-sm leading-6 whitespace-pre-line text-muted-foreground">
              {t.targetsHelp}
            </p>
            <p className="text-sm leading-6 text-warn whitespace-pre-line">{t.prNotice}</p>
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
                      {/* イメージ（PBI-41）。images を書いていて、選べるときだけ出す */}
                      {(images.length > 0 || target.image) && (
                        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                          {t.image}
                          <select
                            className={SELECT}
                            value={target.image ?? ""}
                            onChange={(e) =>
                              updateTarget(i, { image: e.target.value || undefined })
                            }
                          >
                            <option value="">{t.imageAuto}</option>
                            <option value="default">{t.imageDefault}</option>
                            {images.map((image) => (
                              <option key={image.name} value={image.name}>
                                {image.name}（{image.description}）
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
              {t.contextTitle}{" "}
              <span className="text-[13px] font-normal text-muted-foreground">{t.contextNote}</span>
            </h2>
            <p className="text-sm leading-6 whitespace-pre-line text-muted-foreground">
              {t.contextHelp}
            </p>
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
          </section>

          <section
            aria-labelledby="github"
            className="flex flex-col gap-3 rounded-xl border border-border bg-card p-5"
          >
            <h2 id="github" className="text-[15px] font-semibold">
              {t.githubTitle}{" "}
              <span className="text-[13px] font-normal text-muted-foreground">{t.githubNote}</span>
            </h2>
            <p className="text-sm leading-6 whitespace-pre-line text-muted-foreground">
              {t.githubHelp}
            </p>
            {!hosts.some((h) => h.required) && (
              <p className="text-sm text-muted-foreground">{t.githubNoTargets}</p>
            )}
            {hosts.map(({ host, required, forContext }) => {
              const current = githubAccounts[host] ?? "";
              const onHost = accounts.filter((a) => a.host === host);
              return (
                <div key={host} className="flex flex-col gap-1.5">
                  <Label htmlFor={`${uid}-github-${host}`}>
                    {t.githubAccount(host)}
                    {!required && (
                      <span className="font-normal text-muted-foreground">
                        {forContext ? t.githubForContext : t.githubOptional}
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
                        {a.login}
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
          </section>

          <section
            aria-labelledby="tickets"
            className="flex flex-col gap-3 rounded-xl border border-border bg-card p-5"
          >
            <h2 id="tickets" className="text-[15px] font-semibold">
              {t.ticketsTitle}{" "}
              <span className="text-[13px] font-normal text-muted-foreground">{t.ticketsNote}</span>
            </h2>
            <p className="text-sm leading-6 whitespace-pre-line text-muted-foreground">
              {platforms.length > 0 ? t.ticketsHelp : t.ticketsNoPlatforms}
            </p>
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

          <section
            aria-labelledby="notification"
            className="flex flex-col gap-3 rounded-xl border border-border bg-card p-5"
          >
            <h2 id="notification" className="text-[15px] font-semibold">
              {t.notifyTitle}{" "}
              <span className="text-[13px] font-normal text-muted-foreground">{t.notifyNote}</span>
            </h2>
            <p className="text-sm leading-6 whitespace-pre-line text-muted-foreground">
              {t.notifyHelp}
            </p>
            <div className="flex flex-wrap items-end gap-2">
              <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                {t.notifyKind}
                <select
                  className={SELECT}
                  value={notifyKind}
                  onChange={(e) => setNotifyKind(e.target.value as typeof notifyKind)}
                >
                  <option value="">{t.notifyNone}</option>
                  <option value="slack-api">{t.notifyApi}</option>
                  <option value="slack-webhook">{t.notifyWebhook}</option>
                </select>
              </label>
              {notifyKind && (
                <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                  {t.notifyLanguage}
                  <select
                    className={SELECT}
                    value={notifyLanguage}
                    onChange={(e) => setNotifyLanguage(e.target.value as "ja" | "en")}
                  >
                    <option value="ja">日本語</option>
                    <option value="en">English</option>
                  </select>
                </label>
              )}
            </div>
            {notifyKind === "slack-api" && (
              <div className="flex flex-wrap items-end gap-2">
                <label
                  htmlFor={`${uid}-notify-url`}
                  className="flex min-w-72 flex-[2] flex-col gap-1 text-xs text-muted-foreground"
                >
                  {t.notifyUrl}
                  <Input
                    id={`${uid}-notify-url`}
                    value={notifyUrl}
                    placeholder="https://slack.com/api/chat.postMessage"
                    onChange={(e) => setNotifyUrl(e.target.value)}
                    className="font-mono"
                  />
                </label>
                <label
                  htmlFor={`${uid}-notify-channel`}
                  className="flex min-w-40 flex-1 flex-col gap-1 text-xs text-muted-foreground"
                >
                  {t.notifyChannel}
                  <Input
                    id={`${uid}-notify-channel`}
                    value={notifyChannel}
                    placeholder="#sacty"
                    onChange={(e) => setNotifyChannel(e.target.value)}
                    className="font-mono"
                  />
                </label>
                <label
                  htmlFor={`${uid}-notify-token`}
                  className="flex min-w-48 flex-1 flex-col gap-1 text-xs text-muted-foreground"
                >
                  {t.notifyToken}
                  <Input
                    id={`${uid}-notify-token`}
                    value={notifyToken}
                    placeholder={t.notifyTokenPlaceholder}
                    onChange={(e) => setNotifyToken(e.target.value)}
                    className="font-mono"
                  />
                </label>
              </div>
            )}
            {notifyKind === "slack-webhook" && (
              <label
                htmlFor={`${uid}-notify-webhook`}
                className="flex max-w-md flex-col gap-1 text-xs text-muted-foreground"
              >
                {t.notifyWebhookSecret}
                <Input
                  id={`${uid}-notify-webhook`}
                  value={notifyWebhook}
                  placeholder="slack-webhook-url"
                  onChange={(e) => setNotifyWebhook(e.target.value)}
                  className="font-mono"
                />
              </label>
            )}
            {saved && project && (
              <div className="flex flex-wrap items-center gap-3">
                <Button
                  type="button"
                  variant="outline"
                  className="w-fit"
                  disabled={testing || notificationChanged}
                  onClick={() => {
                    const data = new FormData();
                    data.set("projectId", project.id);
                    startTransition(() => testAction(data));
                  }}
                >
                  {t.notifyTest}
                </Button>
                {notificationChanged && (
                  <span className="text-xs text-muted-foreground">{t.notifySaveFirst}</span>
                )}
                {testState.sent && !testState.message && (
                  <span role="status" className="text-sm text-accent-foreground">
                    {t.notifySent}
                  </span>
                )}
                {testState.message && (
                  <span role="alert" className="text-sm whitespace-pre-line text-warn">
                    {testState.message}
                  </span>
                )}
              </div>
            )}
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
