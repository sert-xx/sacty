"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import {
  advanceFeed,
  claimDesktopItem,
  DESKTOP_INTERVAL_MS,
  DESKTOP_PREF_EVENT,
  DESKTOP_PREF_KEY,
  type DesktopFeed,
  desktopSupported,
  type FeedCursor,
  feedUrl,
  readDesktopPref,
} from "@/lib/desktop-notifications";

/**
 * ブラウザのデスクトップ通知を出す（画面には何も描かない）。このブラウザで On にしていて、通知が許可されている間だけ、
 * 最近の通知を一定の間隔で取り直す。タブが隠れている間も取り直す（気づいてほしいのは、ほかの作業をしている間なので）。
 * 通知を押すと、このタブを前に出してタスクの詳細を開く。
 */
export function DesktopNotifications() {
  const router = useRouter();
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let loading = false;
    let cursor: FeedCursor = {};
    const active = () =>
      desktopSupported() && readDesktopPref() && Notification.permission === "granted";
    const poll = async () => {
      timer = undefined;
      if (stopped) return;
      if (!active()) {
        // Off の間は取り直さない。On に戻したら、その後の通知から出す
        cursor = {};
        return;
      }
      loading = true;
      try {
        const res = await fetch(feedUrl(cursor), { cache: "no-store" });
        const feed = (await res.json()) as DesktopFeed | { unavailable: true };
        if (!stopped && "boot" in feed && active()) {
          const next = advanceFeed(cursor, feed);
          cursor = next.cursor;
          for (const item of next.show) {
            if (!claimDesktopItem(feed.boot, item.seq)) continue;
            const notification = new Notification(item.title, {
              body: item.body,
              tag: `sacty-${feed.boot}-${item.seq}`,
            });
            notification.onclick = () => {
              window.focus();
              router.push(item.href);
              notification.close();
            };
          }
        }
      } catch {
        // 取れなくても、次の間隔でまた取り直す
      } finally {
        loading = false;
      }
      if (!stopped) timer = setTimeout(() => void poll(), DESKTOP_INTERVAL_MS);
    };
    // 取り直しの途中なら、終わった後の次の間隔で On/Off を読み直す（取り直しを重ねない）
    const restart = () => {
      if (loading) return;
      if (timer !== undefined) clearTimeout(timer);
      void poll();
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key === null || event.key === DESKTOP_PREF_KEY) restart();
    };
    // On/Off を変えたら（ほかのタブで変えたときも）、すぐに取り直しを始める・止める
    window.addEventListener(DESKTOP_PREF_EVENT, restart);
    window.addEventListener("storage", onStorage);
    void poll();
    return () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      window.removeEventListener(DESKTOP_PREF_EVENT, restart);
      window.removeEventListener("storage", onStorage);
    };
  }, [router]);
  return null;
}
