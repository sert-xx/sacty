"use client";

import { useMessages } from "@/i18n/client";
import type { ContextImagesData } from "@/lib/context-images-data";
import { useLiveData } from "@/lib/use-live-data";
import { ContextImagesNoticeView } from "./context-images-notice-view";

/** コンテキストのイメージの作成の状況を取り直す間隔（PBI-325）。作成中のログを追えるよう、短めにする。 */
export const CONTEXT_IMAGES_LIVE_INTERVAL_MS = 5_000;

/** コンテキストのイメージの作成の状況の取り直し先。 */
export const CONTEXT_IMAGES_LIVE_URL = "/live/context-images";

/**
 * コンテキストのイメージの作成の状況（PBI-325）。共通の外枠は画面の移動で描き直されないので、開いている画面でも一定の
 * 間隔で取り直し、作り終えたらリロードせずに消す。取り直せないときは、最後に取れた表示のまま。
 */
export function ContextImagesNoticeLive({ initial }: { initial: ContextImagesData }) {
  const messages = useMessages();
  const { data } = useLiveData(
    () => CONTEXT_IMAGES_LIVE_URL,
    initial,
    undefined,
    CONTEXT_IMAGES_LIVE_INTERVAL_MS,
  );
  return (
    <ContextImagesNoticeView
      projects={data.contextImages}
      t={messages.shell.contextImages}
      text={messages.labels.text}
    />
  );
}
