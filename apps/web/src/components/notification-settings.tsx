"use client";

import { DEFAULT_MENTION_KINDS, NotificationKind, type SlackNotification } from "@sacty/core";
import { startTransition, useActionState, useId, useState } from "react";
import { type TestNotificationState, testNotificationAction } from "@/app/actions";
import { Button } from "@/components/ui/button";
import { Hint } from "@/components/ui/hint";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useMessages } from "@/i18n/client";

const SELECT =
  "h-9 max-w-full rounded-md border border-input bg-card px-2 text-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none";

/**
 * sacty の設定の、Slack の通知先（PBI-38。PBI-115 でプロジェクトの設定から移した）。入力は、sacty の設定のフォームに
 * JSON（name="notification"。空なら通知しない）で渡す。テストの通知は、保存した設定で送る。
 */
export function NotificationSettings({
  saved,
  problems = [],
}: {
  saved?: SlackNotification;
  /** 送れなかった理由（画面の言語の文。PBI-115）。通知を直す場所なので、ここにも出す。 */
  problems?: readonly string[];
}) {
  const t = useMessages().settings;
  // 前の画面が隠れて残ることがあるので、id は固定にせず画面ごとに作る
  const uid = useId();
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
  // 止める（送り先の設定は残す）
  const [notifyOff, setNotifyOff] = useState(saved?.off ?? false);
  const [notifyLanguage, setNotifyLanguage] = useState<"ja" | "en">(saved?.language ?? "ja");
  // メンション（PBI-69）。相手は編集しやすいよう、カンマか空白で区切った文字列で持つ
  const [mentionTargets, setMentionTargets] = useState(saved?.mention?.targets.join(", ") ?? "");
  const [mentionKinds, setMentionKinds] = useState<NotificationKind[]>(
    saved?.mention?.kinds ?? [...DEFAULT_MENTION_KINDS],
  );
  const mentionList = [
    ...new Set(
      mentionTargets
        .split(/[\s,、]+/)
        .map((m) => m.trim())
        .filter(Boolean),
    ),
  ];
  const mention =
    mentionList.length > 0
      ? {
          mention: {
            targets: mentionList,
            kinds: NotificationKind.options.filter((k) => mentionKinds.includes(k)),
          },
        }
      : {};
  const off = notifyOff ? { off: true as const } : {};
  const notification =
    notifyKind === "slack-api"
      ? {
          kind: notifyKind,
          url: notifyUrl.trim(),
          channel: notifyChannel.trim(),
          ...(notifyToken.trim() ? { token: notifyToken.trim() } : {}),
          language: notifyLanguage,
          ...mention,
          ...off,
        }
      : notifyKind === "slack-webhook"
        ? {
            kind: notifyKind,
            webhook: notifyWebhook.trim(),
            language: notifyLanguage,
            ...mention,
            ...off,
          }
        : undefined;
  const [testState, testAction, testing] = useActionState<TestNotificationState, FormData>(
    testNotificationAction,
    {},
  );
  // 保存していない変更があれば、テストの通知は送れない（保存した設定で送るため）
  const notificationChanged =
    JSON.stringify(notification ?? null) !== JSON.stringify(saved ?? null);

  return (
    <section
      aria-labelledby={`${uid}-notification`}
      className="flex flex-col gap-3 rounded-xl border border-border bg-card p-5"
    >
      <input
        type="hidden"
        name="notification"
        value={notification ? JSON.stringify(notification) : ""}
      />
      <h2 id={`${uid}-notification`} className="text-[15px] font-semibold">
        {t.notifyTitle} <Hint text={t.notifyHint} />
      </h2>
      {/* 送り先はすべてのプロジェクトで共通なので、見る人の範囲を確かめてもらう（PBI-115 レビュー指摘） */}
      <p
        data-testid="notification-audience"
        className="flex flex-wrap items-center gap-1 text-sm leading-6 text-warn"
      >
        {t.notifyAudience}
        <Hint text={t.notifyAudienceHint} />
      </p>
      {problems.length > 0 && (
        <div
          role="status"
          data-testid="notification-problems"
          className="flex flex-col gap-1 rounded-lg border border-warn-line bg-warn-soft p-3 text-sm text-warn"
        >
          {problems.map((p) => (
            <p key={p}>{p}</p>
          ))}
        </div>
      )}
      {notifyKind && (
        <span className="flex items-center gap-1">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              data-testid="notification-on"
              checked={!notifyOff}
              onChange={(e) => setNotifyOff(!e.target.checked)}
              className="size-4"
            />
            {t.notifyOn}
          </label>
          <Hint text={t.notifyOnHint} className="size-4" />
        </span>
      )}
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex min-w-0 max-w-full flex-col gap-1 text-xs text-muted-foreground">
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
          <label className="flex min-w-0 max-w-full flex-col gap-1 text-xs text-muted-foreground">
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
            className="flex w-full min-w-0 flex-col sm:w-auto sm:min-w-72 sm:flex-[2] gap-1 text-xs text-muted-foreground"
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
            className="flex w-full min-w-0 flex-col sm:w-auto sm:min-w-40 sm:flex-1 gap-1 text-xs text-muted-foreground"
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
          <div className="flex w-full min-w-0 flex-col sm:w-auto sm:min-w-48 sm:flex-1 gap-1 text-xs text-muted-foreground">
            <span className="flex items-center gap-1">
              <Label htmlFor={`${uid}-notify-token`} className="text-xs font-normal">
                {t.notifyToken}
              </Label>
              <Hint text={t.notifySecretHint} className="size-4" />
            </span>
            <Input
              id={`${uid}-notify-token`}
              value={notifyToken}
              placeholder={t.notifyTokenPlaceholder}
              onChange={(e) => setNotifyToken(e.target.value)}
              className="font-mono"
            />
          </div>
        </div>
      )}
      {notifyKind === "slack-webhook" && (
        <div className="flex max-w-md flex-col gap-1 text-xs text-muted-foreground">
          <span className="flex items-center gap-1">
            <Label htmlFor={`${uid}-notify-webhook`} className="text-xs font-normal">
              {t.notifyWebhookSecret}
            </Label>
            <Hint text={t.notifySecretHint} className="size-4" />
          </span>
          <Input
            id={`${uid}-notify-webhook`}
            value={notifyWebhook}
            placeholder="slack-webhook-url"
            onChange={(e) => setNotifyWebhook(e.target.value)}
            className="font-mono"
          />
        </div>
      )}
      {notifyKind && (
        <fieldset className="flex flex-col gap-2 rounded-lg border border-border p-3">
          <legend className="px-1 text-xs text-muted-foreground">{t.mentionTitle}</legend>
          <div className="flex max-w-xl flex-col gap-1 text-xs text-muted-foreground">
            <span className="flex items-center gap-1">
              <Label htmlFor={`${uid}-mention-targets`} className="text-xs font-normal">
                {t.mentionTargets}
              </Label>
              <Hint text={t.mentionHint} className="size-4" />
            </span>
            <Input
              id={`${uid}-mention-targets`}
              value={mentionTargets}
              placeholder="U0123ABCD, S0456EFGH, @here"
              onChange={(e) => setMentionTargets(e.target.value)}
              className="font-mono"
            />
          </div>
          <fieldset className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
            <legend className="float-left mr-1 text-xs text-muted-foreground">
              {t.mentionKinds}
            </legend>
            {NotificationKind.options.map((kind) => (
              <label key={kind} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={mentionKinds.includes(kind)}
                  onChange={(e) =>
                    setMentionKinds((current) =>
                      e.target.checked ? [...current, kind] : current.filter((k) => k !== kind),
                    )
                  }
                  className="size-4"
                />
                {t.mentionKind[kind]}
              </label>
            ))}
          </fieldset>
        </fieldset>
      )}
      {saved && (
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            variant="outline"
            className="w-fit"
            disabled={testing || notificationChanged}
            onClick={() => startTransition(() => testAction(new FormData()))}
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
  );
}
