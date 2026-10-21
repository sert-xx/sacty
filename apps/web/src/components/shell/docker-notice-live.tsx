"use client";

import { useMessages } from "@/i18n/client";
import type { DockerData } from "@/lib/docker-data";
import { useLiveData } from "@/lib/use-live-data";
import { DockerNoticeView } from "./docker-notice-view";

/** Docker の注意を取り直す間隔（PBI-148）。デーモンが確かめるのは1分ごとなので、それより短くする。 */
export const DOCKER_LIVE_INTERVAL_MS = 30_000;

/** Docker の注意の取り直し先。 */
export const DOCKER_LIVE_URL = "/live/docker";

/**
 * Docker とエージェントのイメージの注意（PBI-148）。共通の外枠は画面の移動で描き直されないので、開いている画面でも一定の間隔で
 * 取り直し、Docker を起動した・イメージを作ったら、リロードせずに消す。取り直せないときは、最後に取れた表示のまま。
 */
export function DockerNoticeLive({ initial }: { initial: DockerData }) {
  const messages = useMessages();
  const { data } = useLiveData(() => DOCKER_LIVE_URL, initial, undefined, DOCKER_LIVE_INTERVAL_MS);
  return (
    <DockerNoticeView
      problems={data.docker}
      t={messages.shell.docker}
      text={messages.labels.text}
    />
  );
}
