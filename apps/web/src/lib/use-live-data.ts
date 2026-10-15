"use client";

import { useEffect, useRef, useState } from "react";
import { fetchLive, LIVE_INTERVAL_MS, pollWhileVisible } from "@/lib/live";

/**
 * 画面のサーバーが描いたときのデータ（initial）から始め、url から一定の間隔でデータだけを取り直す（PBI-108）。画面は
 * リロードしない。データが変わったときだけ描き直し、変わった所だけが画面に反映される。
 * 操作の後にサーバーが画面を描き直して initial が変われば、そちらを使う（取り直したデータより新しい）。
 * url は、取り直すたびに、いまのデータから決める。
 * stale は、直近の取り直しで更新できなかった（表示は最後に取れたデータのまま）こと。更新できたら false に戻る。
 */
export function useLiveData<T>(
  url: (current: T) => string,
  initial: T,
  initialVersion?: string,
  intervalMs: number = LIVE_INTERVAL_MS,
): { data: T; stale: boolean } {
  const [polled, setPolled] = useState<{ base: T; data: T; version: string }>();
  const [stale, setStale] = useState(false);
  const current = polled && polled.base === initial ? polled : undefined;
  const data = current ? current.data : initial;
  // 取り直しの処理（effect の中）から、いまの元のデータ・データ・版・取り直す先を読む
  const latest = useRef({ initial, data, version: current?.version ?? initialVersion, url });
  latest.current = { initial, data, version: current?.version ?? initialVersion, url };
  useEffect(
    () =>
      pollWhileVisible({
        doc: document,
        intervalMs,
        load: async () => {
          const { initial: base, data: now, version, url: target } = latest.current;
          const next = await fetchLive<T>(target(now), version);
          setStale(next === "failed");
          // 取っている間に、サーバーが描き直した（initial が変わった）なら捨てる
          if (typeof next === "object" && latest.current.initial === base) {
            setPolled({ base, data: next.data, version: next.version });
          }
        },
      }),
    [intervalMs],
  );
  return { data, stale };
}
