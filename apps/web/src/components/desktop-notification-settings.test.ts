// @vitest-environment jsdom
import { act, type FC, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { I18nProvider } = await import("@/i18n/client");
const { DesktopNotificationSettings } = await import("./desktop-notification-settings");
const { messagesFor } = await import("@/i18n");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** ブラウザの Notification の代わり（許可の状態だけ）。 */
const FakeNotification = {
  permission: "denied" as NotificationPermission,
  requestPermission: async () => FakeNotification.permission,
};

let container: HTMLDivElement;
let root: Root;
const box = () =>
  container.querySelector<HTMLInputElement>('[data-testid="desktop-notification-on"]');

beforeEach(() => {
  localStorage.clear();
  FakeNotification.permission = "denied";
  vi.stubGlobal("Notification", FakeNotification);
  Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });
  container = document.createElement("div");
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
});

describe("sacty の設定のデスクトップ通知の欄", () => {
  it("拒否した後にサイトの設定で許可したら、画面に戻ったときに読み直し、読み直さなくても On にできる", async () => {
    const t = messagesFor("ja").settings;
    await act(async () => {
      root.render(
        h(
          I18nProvider as unknown as FC<{ locale: "ja" }>,
          { locale: "ja" },
          h(DesktopNotificationSettings),
        ),
      );
    });
    expect(container.textContent).toContain(t.desktopDenied);
    expect(box()?.disabled).toBe(true);
    // サイトの設定で許可して、画面に戻る
    FakeNotification.permission = "granted";
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(container.textContent).not.toContain(t.desktopDenied);
    expect(box()?.disabled).toBe(false);
    await act(async () => {
      box()?.click();
    });
    expect(box()?.checked).toBe(true);
    expect(localStorage.getItem("sacty-desktop-notifications")).toBe("on");
  });
});
