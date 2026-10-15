"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** 実行中・実行待ちのあいだ、画面を一定間隔で最新にする。 */
export function AutoRefresh({
  active,
  intervalMs = 3_000,
}: {
  active: boolean;
  intervalMs?: number;
}) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => router.refresh(), intervalMs);
    return () => clearInterval(timer);
  }, [active, intervalMs, router]);
  return null;
}

/**
 * タブに戻ってきた（隠れていた画面がまた見えた）ときに、一度だけ画面を最新にする（PBI-98）。ほかのタブ・CLI・デーモンでの
 * 変化（承認・工程の完了など）を、ヘッダーのお知らせに反映するため。見えている間は問い合わせない。
 */
export function RefreshOnVisible() {
  const router = useRouter();
  useEffect(() => {
    const onChange = () => {
      if (document.visibilityState === "visible") router.refresh();
    };
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, [router]);
  return null;
}
