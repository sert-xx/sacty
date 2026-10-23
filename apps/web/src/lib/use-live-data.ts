"use client";

import { useEffect, useRef, useState } from "react";
import { fetchLive, LIVE_INTERVAL_MS, type LiveStale, pollWhileVisible } from "@/lib/live";

/**
 * 画面のサーバーが描いたときのデータ（initial）から始め、url から一定の間隔でデータだけを取り直す（PBI-108）。画面は
 * リロードしない。データが変わったときだけ描き直し、変わった所だけが画面に反映される。
 * 操作の後にサーバーが画面を描き直して initial が変われば、そちらを使う（取り直したデータより新しい）。
 * url は、取り直すたびに、いまのデータから決める。
 * stale は、直近の取り直しで更新できなかった（表示は最後に取れたデータのまま）ことと、その理由（画面の認証が無いか。
 * PBI-129）。更新できたら false に戻る。
 * missing は、直近の取り直しで対象が無かった（消えた・プロジェクトを削除した）こと。表示は最後のデータのまま残す。
 */
export function useLiveData<T>(
  url: (current: T) => string,
  initial: T,
  initialVersion?: string,
  intervalMs: number = LIVE_INTERVAL_MS,
): { data: T; stale: LiveStale; missing: boolean } {
  const [polled, setPolled] = useState<{ base: T; data: T; version: string }>();
  // 更新できなかったときの元のデータ（サーバーが描き直して initial が変われば、更新できない表示も消える）
  const [staleFor, setStaleFor] = useState<{ base: T; reason: "failed" | "signedOut" }>();
  const [missingFor, setMissingFor] = useState<T>();
  const missing = missingFor !== undefined && missingFor === initial;
  const stale: LiveStale =
    staleFor !== undefined && staleFor.base === initial ? staleFor.reason : false;
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
          // 取っている間に、サーバーが描き直した（initial が変わった）なら、結果（失敗も）を捨てる（PR #119 再レビュー指摘）
          if (latest.current.initial !== base) return;
          setStaleFor(
            next === "failed" || next === "signedOut" ? { base, reason: next } : undefined,
          );
          setMissingFor(next === "missing" ? base : undefined);
          if (typeof next === "object") setPolled({ base, data: next.data, version: next.version });
        },
      }),
    [intervalMs],
  );
  return { data, stale, missing };
}
