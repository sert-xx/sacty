import { describe, expect, it, vi } from "vitest";
import {
  candidatesLoader,
  fetchRepositoryCandidates,
  repositoryCandidatesPath,
} from "./repository-candidates";

const reply = (status: number, body: unknown) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe("ダイアログを開いたときの候補の読み込み（PBI-109）", () => {
  type Result = Awaited<ReturnType<typeof fetchRepositoryCandidates>>;
  const deferred = () => {
    let resolve!: (r: Result) => void;
    const promise = new Promise<Result>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  };
  const loaded = (repositories: string[]): Result => ({
    status: "loaded",
    repositories,
    problems: [],
  });

  it("開くたびに1回だけ読み、読んでいる途中を出してから結果を出す", async () => {
    const first = deferred();
    const load = vi.fn(() => first.promise);
    const open = candidatesLoader(load);
    const set = vi.fn();
    open("p1", true, "no", set);
    expect(load).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledWith("p1", "no");
    expect(set).toHaveBeenLastCalledWith({ status: "loading" });
    first.resolve(loaded(["acme/api"]));
    await first.promise;
    await Promise.resolve();
    expect(set).toHaveBeenLastCalledWith(loaded(["acme/api"]));
  });

  it("開き直したときは、前に開いたときの遅れて届いた結果で上書きしない", async () => {
    const slow = deferred();
    const fast = deferred();
    const load = vi.fn().mockReturnValueOnce(slow.promise).mockReturnValueOnce(fast.promise);
    const open = candidatesLoader(load);
    const set = vi.fn();
    open("p1", true, "no", set);
    open("p1", true, "no", set);
    fast.resolve(loaded(["acme/new"]));
    await fast.promise;
    slow.resolve(loaded(["acme/old"]));
    await slow.promise;
    await Promise.resolve();
    expect(set).toHaveBeenLastCalledWith(loaded(["acme/new"]));
    expect(set).not.toHaveBeenCalledWith(loaded(["acme/old"]));
  });

  it("対象の無いプロジェクトでは読まない（前の読み込みの結果も捨てる）", async () => {
    const slow = deferred();
    const load = vi.fn().mockReturnValueOnce(slow.promise);
    const open = candidatesLoader(load);
    const set = vi.fn();
    open("p1", true, "no", set);
    set.mockClear();
    open("p2", false, "no", set);
    slow.resolve(loaded(["acme/api"]));
    await slow.promise;
    await Promise.resolve();
    expect(load).toHaveBeenCalledTimes(1);
    expect(set).not.toHaveBeenCalled();
  });
});

describe("リポジトリの候補を読む（PBI-109）", () => {
  it("プロジェクトの ID を符号化したパスを、キャッシュせずに読む", async () => {
    const fetchImpl = reply(200, { repositories: ["acme/api"], problems: ["x"] });
    expect(await fetchRepositoryCandidates("p 1", "no", fetchImpl)).toEqual({
      status: "loaded",
      repositories: ["acme/api"],
      problems: ["x"],
    });
    expect(fetchImpl).toHaveBeenCalledWith("/projects/p%201/repositories", { cache: "no-store" });
    expect(repositoryCandidatesPath("a/b")).toBe("/projects/a%2Fb/repositories");
  });

  it("失敗したときは投げず、サーバーの理由か、受け取れなかったことを返す", async () => {
    expect(await fetchRepositoryCandidates("p1", "no", reply(503, { message: "down" }))).toEqual({
      status: "failed",
      message: "down",
    });
    const notJson = vi.fn(
      async () => new Response("<html>", { status: 500 }),
    ) as unknown as typeof fetch;
    expect(await fetchRepositoryCandidates("p1", "no", notJson)).toEqual({
      status: "failed",
      message: "no",
    });
    const offline = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    expect(await fetchRepositoryCandidates("p1", "no", offline)).toEqual({
      status: "failed",
      message: "no",
    });
    // 形の違う応答は、候補として使わない
    expect(await fetchRepositoryCandidates("p1", "no", reply(200, { repositories: "x" }))).toEqual({
      status: "failed",
      message: "no",
    });
  });
});
