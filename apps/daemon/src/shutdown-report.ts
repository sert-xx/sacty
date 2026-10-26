/**
 * 名前の付いた後処理がすべて終わるのを待つ。reportMs たっても終わっていなければ、まだ終わっていないものを表示する
 * （止まらない理由が端末でわかるように）。
 */
export async function waitNamed(
  tasks: Record<string, Promise<unknown>>,
  reportMs: number,
  log: (line: string) => void,
): Promise<void> {
  const pending = new Set(Object.keys(tasks));
  const report = setTimeout(() => {
    if (pending.size > 0) log(`[daemon] 後片付けを待っています：${[...pending].join("、")}`);
  }, reportMs).unref();
  try {
    await Promise.all(
      Object.entries(tasks).map(([name, task]) => task.finally(() => pending.delete(name))),
    );
  } finally {
    clearTimeout(report);
  }
}
