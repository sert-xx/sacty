"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Hint } from "@/components/ui/hint";
import { useMessages } from "@/i18n/client";
import {
  DESKTOP_PREF_EVENT,
  desktopSupported,
  readDesktopPref,
  writeDesktopPref,
} from "@/lib/desktop-notifications";

type Availability = "unknown" | "unsupported" | "denied" | "ready";

const availability = (): Availability =>
  !desktopSupported() ? "unsupported" : Notification.permission === "denied" ? "denied" : "ready";

/**
 * sacty の設定の、ブラウザのデスクトップ通知。通知の許可はブラウザごとなので、On/Off もこのブラウザに持ち、切り替えたら
 * すぐに反映する（sacty の設定の保存は要らない）。On にするときに、ブラウザに通知の許可を求める。
 */
export function DesktopNotificationSettings() {
  const t = useMessages().settings;
  // ブラウザの状態は、描いた後に読む（サーバーの描画と食い違わないように）
  const [state, setState] = useState<Availability>("unknown");
  const [on, setOn] = useState(false);
  useEffect(() => {
    const sync = () => {
      setState(availability());
      setOn(readDesktopPref());
    };
    sync();
    window.addEventListener(DESKTOP_PREF_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(DESKTOP_PREF_EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);
  const granted = state === "ready" && on && Notification.permission === "granted";

  const toggle = async (checked: boolean) => {
    if (!checked) {
      writeDesktopPref(false);
      return;
    }
    // 許可を求めるのは、押したとき（ブラウザは、人の操作の無いときの求めを断る）
    const permission =
      Notification.permission === "default"
        ? await Notification.requestPermission()
        : Notification.permission;
    writeDesktopPref(permission === "granted");
    setState(availability());
  };

  return (
    <section
      aria-labelledby="desktop-notification-title"
      data-testid="desktop-notification"
      className="flex flex-col gap-3 rounded-xl border border-border bg-card p-5"
    >
      <h2 id="desktop-notification-title" className="text-[15px] font-semibold">
        {t.desktopTitle} <Hint text={t.desktopHint} />
      </h2>
      {state === "unsupported" && <p className="text-sm text-warn">{t.desktopUnsupported}</p>}
      {state === "denied" && <p className="text-sm text-warn">{t.desktopDenied}</p>}
      <label className="flex w-fit items-center gap-2 text-sm">
        <input
          type="checkbox"
          data-testid="desktop-notification-on"
          checked={on && state === "ready"}
          disabled={state !== "ready"}
          onChange={(e) => void toggle(e.target.checked)}
          className="size-4"
        />
        {t.desktopOn}
      </label>
      {granted && (
        <Button
          type="button"
          variant="outline"
          className="w-fit"
          onClick={() => new Notification(t.desktopTestTitle, { body: t.desktopTestBody })}
        >
          {t.desktopTest}
        </Button>
      )}
    </section>
  );
}
