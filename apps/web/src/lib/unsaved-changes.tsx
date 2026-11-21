"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef } from "react";
import { useMessages } from "@/i18n/client";

type Registry = { set: (dirty: boolean) => void; isDirty: () => boolean };

const NONE: Registry = { set: () => {}, isDirty: () => false };
const UnsavedContext = createContext<Registry>(NONE);

/**
 * 保存していない変更のある画面の有無を持つ。画面を描き直さないよう、値は ref に置く。
 */
export function UnsavedChangesProvider({ children }: { children: React.ReactNode }) {
  const dirty = useRef(false);
  const registry = useMemo<Registry>(
    () => ({
      set: (value) => {
        dirty.current = value;
      },
      isDirty: () => dirty.current,
    }),
    [],
  );
  return <UnsavedContext.Provider value={registry}>{children}</UnsavedContext.Provider>;
}

/**
 * フォームが、保存していない変更の有無を登録する。変更があるあいだ、閉じる・リロード・リンクの移動（`<a>`）を
 * ブラウザーの確認で確かめる（beforeunload）。画面から外れたら解く。
 */
export function useUnsavedChanges(dirty: boolean) {
  const registry = useContext(UnsavedContext);
  useEffect(() => {
    registry.set(dirty);
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      // 古いブラウザーは returnValue が要る
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      registry.set(false);
    };
  }, [dirty, registry]);
}

/**
 * Link の onNavigate に渡す。保存していない変更があれば確かめ、断られたら移動を止める。
 */
export function useLeaveGuard() {
  const registry = useContext(UnsavedContext);
  const message = useMessages().shell.leaveConfirm;
  return useCallback(
    (e: { preventDefault: () => void }) => {
      if (registry.isDirty() && !window.confirm(message)) e.preventDefault();
    },
    [registry, message],
  );
}
