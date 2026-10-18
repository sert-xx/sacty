"use client";

import { useMessages } from "@/i18n/client";
import type { UpdateData } from "@/lib/update-data";
import { useLiveData } from "@/lib/use-live-data";
import { UpdateNoticeView } from "./update-notice-view";

/**
 * 新しい版の知らせを取り直す間隔（PBI-135）。デーモンが GitHub に問い合わせるのは1日ごとなので、画面は頻繁に取り直さない。
 */
export const UPDATE_LIVE_INTERVAL_MS = 30_000;

/** 新しい版の知らせの取り直し先。 */
export const UPDATE_LIVE_URL = "/live/update";

/**
 * 新しい版の知らせ（PBI-135）。共通の外枠は画面の移動で描き直されないので、開いている画面でも一定の間隔で取り直し、
 * 知らせが現れる・消える（OFF にした・確かめられなくなった）のを、リロードせずに反映する（PR #147 レビュー指摘）。
 * 取り直せないとき（デーモンに届かない）は、最後に取れた表示のまま。
 */
export function UpdateNoticeLive({ initial }: { initial: UpdateData }) {
  const t = useMessages().shell.update;
  const { data } = useLiveData(() => UPDATE_LIVE_URL, initial, undefined, UPDATE_LIVE_INTERVAL_MS);
  return <UpdateNoticeView update={data.update ?? undefined} t={t} />;
}
