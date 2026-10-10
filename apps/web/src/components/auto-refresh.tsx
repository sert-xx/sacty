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
