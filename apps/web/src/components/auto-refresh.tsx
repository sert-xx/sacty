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
  useEffect(() => watchVisible(document, () => router.refresh()), [router]);
  return null;
}

/** 隠れていた画面が見えるようになるたびに onVisible を呼ぶ（隠れるほうの変化では呼ばない）。返り値で止める。 */
export function watchVisible(
  doc: Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener">,
  onVisible: () => void,
): () => void {
  const onChange = () => {
    if (doc.visibilityState === "visible") onVisible();
  };
  doc.addEventListener("visibilitychange", onChange);
  return () => doc.removeEventListener("visibilitychange", onChange);
}
