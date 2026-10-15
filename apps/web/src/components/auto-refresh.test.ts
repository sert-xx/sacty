import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// テストは DOM の無い環境で動くので、コンポーネントの描画（関数の呼び出し）と、その後の useEffect の実行を、React の
// 代わりにここでする（マウントと同じ順。アンマウントで、effect が返した後片付けを呼ぶ）
const effects: (() => undefined | (() => void))[] = [];
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useEffect: (effect: () => undefined | (() => void)) => {
    effects.push(effect);
  },
}));
const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

const { RefreshOnVisible } = await import("./auto-refresh");

/** コンポーネントをマウントし、アンマウントする関数を返す。 */
function mount(component: () => unknown): () => void {
  effects.length = 0;
  component();
  const cleanups = effects.map((effect) => effect());
  return () => {
    for (const cleanup of cleanups) cleanup?.();
  };
}

/** visibilityState を変えて visibilitychange を送れる document。 */
function fakeDocument() {
  const target = new EventTarget();
  const doc = {
    visibilityState: "visible" as DocumentVisibilityState,
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    set(state: DocumentVisibilityState) {
      doc.visibilityState = state;
      target.dispatchEvent(new Event("visibilitychange"));
    },
  };
  return doc;
}

describe("タブに戻ってきたときの更新（RefreshOnVisible。PBI-98 レビュー指摘）", () => {
  let doc: ReturnType<typeof fakeDocument>;
  beforeEach(() => {
    refresh.mockReset();
    doc = fakeDocument();
    vi.stubGlobal("document", doc);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("マウントした後、隠れた状態から見える状態に戻ると router.refresh() を1回呼ぶ。隠れるほうでは呼ばない", () => {
    const unmount = mount(RefreshOnVisible);
    // マウントしただけでは呼ばない
    expect(refresh).not.toHaveBeenCalled();
    doc.set("hidden");
    expect(refresh).not.toHaveBeenCalled();
    doc.set("visible");
    expect(refresh).toHaveBeenCalledTimes(1);

    // アンマウントした後は呼ばない
    unmount();
    doc.set("hidden");
    doc.set("visible");
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
