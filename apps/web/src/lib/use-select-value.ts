"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * 非制御の select の、いま選んでいる値を追う（選んだイメージの説明を出すため）。select を制御にすると、画面の自動の更新で
 * 選んでいる途中の値を消してしまうので（PBI-108）、値は select から読む。選び直し・フォームのリセット（送信の後に React が
 * 初期値に戻す）・付け直し（ダイアログの開き直し）・初期値の変更（React が非制御の select の選択を変える）のどれの後も、
 * 実際の選択に合わせる。返す ref を select に付ける。
 */
export function useSelectValue(initial: string) {
  const [value, setValue] = useState(initial);
  const element = useRef<HTMLSelectElement | null>(null);
  const ref = useCallback((select: HTMLSelectElement | null) => {
    element.current = select;
    if (!select) return;
    const sync = () => setValue(select.value);
    // reset のイベントは、値を戻す前に起きるので、戻した後に読む
    const afterReset = () => setTimeout(sync);
    const form = select.form;
    sync();
    select.addEventListener("change", sync);
    form?.addEventListener("reset", afterReset);
    return () => {
      select.removeEventListener("change", sync);
      form?.removeEventListener("reset", afterReset);
      element.current = null;
    };
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: 初期値が変わり、React が選択を変えた後に読み直す
  useEffect(() => {
    if (element.current) setValue(element.current.value);
  }, [initial]);
  return [value, ref] as const;
}
