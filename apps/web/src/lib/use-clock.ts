"use client";

import { useEffect, useState } from "react";

/** 画面の時計を進める間隔（ミリ秒）。待っている時間・経過は分までなので、1分ごと。 */
export const CLOCK_INTERVAL_MS = 60_000;

/**
 * 画面の時計（1分ごとに進む）。データに「今」を入れると取り直しのたびに版が変わるので、画面で持つ。
 * anchorMs を渡すと、その時刻から数えた分の境目で進める（経過の表示が最大1分遅れて見えないように）。
 * anchorMs が変わったときは、すぐに今へ取り直す。
 */
export function useClock(anchorMs?: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (anchorMs === undefined) {
      const id = setInterval(() => setNow(Date.now()), CLOCK_INTERVAL_MS);
      return () => clearInterval(id);
    }
    // 起点から数えた次の分の境目まで待ち、以後は1分ごと
    setNow(Date.now());
    const into =
      (((Date.now() - anchorMs) % CLOCK_INTERVAL_MS) + CLOCK_INTERVAL_MS) % CLOCK_INTERVAL_MS;
    let interval: ReturnType<typeof setInterval> | undefined;
    const first = setTimeout(
      () => {
        setNow(Date.now());
        interval = setInterval(() => setNow(Date.now()), CLOCK_INTERVAL_MS);
      },
      Math.max(1, CLOCK_INTERVAL_MS - into),
    );
    return () => {
      clearTimeout(first);
      clearInterval(interval);
    };
  }, [anchorMs]);
  return now;
}
