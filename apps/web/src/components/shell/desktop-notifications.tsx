"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import {
  advanceFeed,
  claimDesktopItem,
  DESKTOP_INTERVAL_MS,
  DESKTOP_PREF_EVENT,
  DESKTOP_PREF_KEY,
  DESKTOP_TIMEOUT_MS,
  type DesktopFeed,
  type DesktopItem,
  desktopSupported,
  type FeedCursor,
  feedUrl,
  readDesktopPref,
  withDesktopLock,
} from "@/lib/desktop-notifications";

/**
 * ブラウザのデスクトップ通知を出す（画面には何も描かない）。このブラウザで On にしていて、通知が許可されている間だけ、
 * 最近の通知を一定の間隔で取り直す。タブが隠れている間も取り直す（気づいてほしいのは、ほかの作業をしている間なので）。
 * 通知を押すと、このタブを前に出してタスクの詳細を開く。同じブラウザの複数のタブでは、同じ通知を1回だけ出す。
 */
export function DesktopNotifications() {
  const router = useRouter();
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // 取り直しの世代。On/Off を変えたら進め、それより前に始めた取り直しの結果を捨てる（Off の間の通知を出さない）
    let generation = 0;
    let inflight: AbortController | undefined;
    let cursor: FeedCursor = {};
    const active = () =>
      desktopSupported() && readDesktopPref() && Notification.permission === "granted";
    const show = (boot: string, item: DesktopItem) => {
      const notification = new Notification(item.title, {
        body: item.body,
        tag: `sacty-${boot}-${item.seq}`,
      });
      notification.onclick = () => {
        window.focus();
        router.push(item.href);
        notification.close();
      };
    };
    const poll = async () => {
      timer = undefined;
      const mine = ++generation;
      inflight?.abort();
      inflight = undefined;
      if (stopped) return;
      if (!active()) {
        // Off の間は取り直さない。On に戻したら、その後の通知から出す
        cursor = {};
        return;
      }
      // 本文を読み終えるまでに期限を設ける（応答が来ないと、次の取り直しを予約できなくなるため）
      const controller = new AbortController();
      inflight = controller;
      const deadline = setTimeout(() => controller.abort(), DESKTOP_TIMEOUT_MS);
      try {
        const res = await fetch(feedUrl(cursor), {
          cache: "no-store",
          signal: controller.signal,
        });
        const feed = (await res.json()) as DesktopFeed | { unavailable: true };
        if (mine !== generation || stopped) return;
        if (!active()) {
          cursor = {};
        } else if ("boot" in feed) {
          const next = advanceFeed(cursor, feed);
          cursor = next.cursor;
          if (next.show.length > 0) {
            await withDesktopLock(() => {
              // 待っている間に Off にした・止めたなら出さない
              if (mine !== generation || stopped || !active()) return;
              for (const item of next.show) {
                if (claimDesktopItem(feed.boot, item.seq)) show(feed.boot, item);
              }
            });
          }
        }
      } catch {
        // 取れなくても（期限切れ・中断を含む）、次の間隔でまた取り直す
      } finally {
        clearTimeout(deadline);
        if (inflight === controller) inflight = undefined;
      }
      // 新しい世代の取り直しが始まっていれば、そちらが次を予約する
      if (mine === generation && !stopped)
        timer = setTimeout(() => void poll(), DESKTOP_INTERVAL_MS);
    };
    // On/Off を変えたら、取り直しの途中でも打ち切って、すぐに始め直す（Off なら止める）
    const restart = () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      cursor = {};
      void poll();
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key === null || event.key === DESKTOP_PREF_KEY) restart();
    };
    // 止まっている（通知の許可が無くなって止めた）ときだけ、始め直す。動いている取り直しは、そのまま続ける
    const resume = () => {
      if (timer === undefined && inflight === undefined) restart();
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") resume();
    };
    // On/Off を変えたら（ほかのタブで変えたときも）、すぐに取り直しを始める・止める
    window.addEventListener(DESKTOP_PREF_EVENT, restart);
    window.addEventListener("storage", onStorage);
    // 通知の許可を取り消して止めた後に、また許可したら始め直す（変わったことを知らせないブラウザでも、画面に戻ったときに）
    window.addEventListener("focus", resume);
    document.addEventListener("visibilitychange", onVisible);
    let permission: PermissionStatus | undefined;
    void navigator.permissions
      ?.query({ name: "notifications" })
      .then((status) => {
        if (stopped) return;
        permission = status;
        status.addEventListener("change", resume);
      })
      .catch(() => {});
    void poll();
    return () => {
      stopped = true;
      permission?.removeEventListener("change", resume);
      window.removeEventListener("focus", resume);
      document.removeEventListener("visibilitychange", onVisible);
      generation += 1;
      inflight?.abort();
      if (timer !== undefined) clearTimeout(timer);
      window.removeEventListener(DESKTOP_PREF_EVENT, restart);
      window.removeEventListener("storage", onStorage);
    };
  }, [router]);
  return null;
}
