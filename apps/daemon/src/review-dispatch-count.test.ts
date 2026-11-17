import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { countReviewDispatch } from "./review-dispatch-count.js";
import { TRUNCATED_EVENT } from "./session-logs.js";

/** 実行の記録の形だけを写した、架空の内容のファイルで確かめる（PBI-379）。 */
describe("PR のレビューが起動した担当の数を、実行の記録から数える（PBI-379）", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "sacty-dispatch-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const jsonl = (lines: unknown[]) => `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`;
  const put = (rel: string, content: string) => {
    const path = join(root, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    return path;
  };
  const agentDir = () => join(root, "agent");

  // Claude Code の形
  const toolUse = (id: string, name: string) => ({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "tool_use", id, name, input: {} }] },
  });
  const said = (text: string) => ({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text }] },
  });
  const init = (tools: string[]) => jsonl([{ type: "system", subtype: "init", tools }]);
  const claude = (parent: unknown[], tools: string[] | null = ["Task", "Bash"]) => {
    put("agent/projects/-workspace/s1.jsonl", jsonl(parent));
    return countReviewDispatch({
      runtime: "claude-code",
      agentDir: agentDir(),
      eventsPath: tools ? put("run.jsonl", init(tools)) : undefined,
    });
  };

  it("Claude Code：親のセッションの、担当を起動するツール（Agent・Task）の呼び出しを、ID で重複を除いて数える", async () => {
    const counted = await claude([
      toolUse("t1", "Skill"),
      toolUse("t2", "Agent"),
      toolUse("t3", "Task"),
      // 同じ呼び出しが、もう一度記録されている
      toolUse("t2", "Agent"),
      toolUse("t4", "Bash"),
    ]);
    expect(counted).toEqual({ subagents: 2, canDispatch: true });
  });

  it("Claude Code：担当を起動せずに本文を書いた実行は 0 件。担当を起動するツールが使えたことは、実行の出力の最初の出来事で確かめる", async () => {
    expect(await claude([toolUse("t1", "Skill"), toolUse("t2", "Bash"), said("総評")])).toEqual({
      subagents: 0,
      canDispatch: true,
    });
    // 「Agent」という語が本文にあるだけでは、数えない
    expect(await claude([said('"tool_use" の Agent は使いませんでした')])).toEqual({
      subagents: 0,
      canDispatch: true,
    });
  });

  it("Claude Code：使えるツールに担当を起動するツールが無い・最初の出来事が無い・出力が無いなら、手段があったとは確かめられない", async () => {
    const parent = [toolUse("t1", "Bash")];
    expect(await claude(parent, ["Bash", "Read"])).toEqual({ subagents: 0, canDispatch: false });
    expect(await claude(parent, null)).toEqual({ subagents: 0, canDispatch: false });
    put("agent/projects/-workspace/s1.jsonl", jsonl(parent));
    const events = put("run.jsonl", jsonl([{ type: "assistant" }, { type: "result" }]));
    expect(
      await countReviewDispatch({
        runtime: "claude-code",
        agentDir: agentDir(),
        eventsPath: events,
      }),
    ).toEqual({ subagents: 0, canDispatch: false });
    // ツールの一覧が配列でない
    const broken = put("run2.jsonl", jsonl([{ type: "system", subtype: "init", tools: "Task" }]));
    expect(
      await countReviewDispatch({
        runtime: "claude-code",
        agentDir: agentDir(),
        eventsPath: broken,
      }),
    ).toEqual({ subagents: 0, canDispatch: false });
  });

  it("Claude Code：担当ごとのセッションのファイルの数も数え、多い方を使う", async () => {
    put("agent/projects/-workspace/s1/subagents/agent-a.jsonl", jsonl([said("x")]));
    put("agent/projects/-workspace/s1/subagents/agent-b.jsonl", jsonl([said("y")]));
    // 担当でないファイル（大きなツールの結果）は数えない
    put("agent/projects/-workspace/s1/tool-results/r.jsonl", jsonl([said("z")]));
    expect(await claude([toolUse("t1", "Bash")])).toEqual({ subagents: 2, canDispatch: true });
  });

  it("Claude Code：親のセッションが無い・読めない行だけ・間を省いたファイルで 0 件なら、分からない", async () => {
    expect(
      await countReviewDispatch({
        runtime: "claude-code",
        agentDir: agentDir(),
        eventsPath: undefined,
      }),
    ).toEqual({ subagents: undefined, canDispatch: false });
    // 間を省いた（上限を超えた）ファイルで 0 件：省いた所に呼び出しがあったかもしれない
    expect(
      await claude([toolUse("t1", "Bash"), { type: TRUNCATED_EVENT, droppedBytes: 10 }]),
    ).toEqual({ subagents: undefined, canDispatch: false });
    // 目印の名前が、指示や差分の文字列の中にあるだけなら、間を省いたとは扱わない（0 件と数える）
    expect(
      await claude([toolUse("t1", "Bash"), said(`差分に ${TRUNCATED_EVENT} という文字列がある`)]),
    ).toEqual({ subagents: 0, canDispatch: true });
    // 間を省いていても、1 件でも見つかれば数える
    expect(
      await claude([toolUse("t1", "Agent"), { type: TRUNCATED_EVENT, droppedBytes: 10 }]),
    ).toEqual({ subagents: 1, canDispatch: true });
    // JSON として読めない行は飛ばす
    put(
      "agent/projects/-workspace/s1.jsonl",
      `{"tool_use" こわれた行\n${jsonl([toolUse("t9", "Agent")])}`,
    );
    expect(
      await countReviewDispatch({
        runtime: "claude-code",
        agentDir: agentDir(),
        eventsPath: put("run.jsonl", init(["Agent"])),
      }),
    ).toEqual({ subagents: 1, canDispatch: true });
  });

  it("Claude Code：親のセッションがシンボリックリンクなら辿らない（分からない）", async () => {
    const outside = put("outside.jsonl", jsonl([toolUse("t1", "Agent")]));
    mkdirSync(join(agentDir(), "projects", "-workspace"), { recursive: true });
    symlinkSync(outside, join(agentDir(), "projects", "-workspace", "s1.jsonl"));
    expect(
      await countReviewDispatch({
        runtime: "claude-code",
        agentDir: agentDir(),
        eventsPath: undefined,
      }),
    ).toEqual({ subagents: undefined, canDispatch: false });
  });

  // Codex の形
  const meta = (source: unknown) => ({ type: "session_meta", payload: { id: "th", source } });
  const turn = (extra: Record<string, unknown> = { multi_agent_version: "v2" }) => ({
    type: "turn_context",
    payload: { cwd: "/workspace", ...extra },
  });
  const call = (name: string, id: string) => ({
    type: "response_item",
    payload: { type: "function_call", name, id, arguments: "{}" },
  });
  const rollout = (name: string, lines: unknown[]) =>
    put(`agent/sessions/2026/01/02/rollout-2026-01-02T03-04-05-${name}.jsonl`, jsonl(lines));
  const codex = () =>
    countReviewDispatch({ runtime: "codex", agentDir: agentDir(), eventsPath: undefined });

  it("Codex：先頭の session_meta の source が exec の rollout（親）の中の spawn_agent だけを数える", async () => {
    rollout("parent", [
      meta("exec"),
      turn(),
      call("spawn_agent", "c1"),
      call("wait_agent", "c2"),
      call("spawn_agent", "c3"),
    ]);
    // 担当の rollout は、親の履歴（spawn_agent）を引き継いでいても数えない
    const child = { subagent: { thread_spawn: { parent_thread_id: "th", depth: 1 } } };
    rollout("child-1", [meta(child), turn(), call("spawn_agent", "c1"), call("spawn_agent", "c3")]);
    rollout("child-2", [meta(child), turn(), call("spawn_agent", "c1")]);
    expect(await codex()).toEqual({ subagents: 2, canDispatch: true });
  });

  it("Codex：spawn_agent が無ければ 0 件。親の turn_context に multi_agent_version が無ければ、手段があったとは確かめられない", async () => {
    rollout("parent", [meta("exec"), turn(), call("exec_command", "c1")]);
    expect(await codex()).toEqual({ subagents: 0, canDispatch: true });
    rollout("parent", [meta("exec"), turn({}), call("exec_command", "c1")]);
    expect(await codex()).toEqual({ subagents: 0, canDispatch: false });
  });

  it("Codex：親の rollout が無い（担当のものしか無い・rollout が無い）なら、分からない", async () => {
    expect(await codex()).toEqual({ subagents: undefined, canDispatch: false });
    rollout("child", [meta({ subagent: {} }), turn(), call("spawn_agent", "c1")]);
    expect(await codex()).toEqual({ subagents: undefined, canDispatch: false });
  });

  it("知らない種類のエージェント・セッションのファイルの場所が無いときは、分からない", async () => {
    put("agent/projects/-workspace/s1.jsonl", jsonl([toolUse("t1", "Bash")]));
    expect(
      await countReviewDispatch({ runtime: "stub", agentDir: agentDir(), eventsPath: undefined }),
    ).toEqual({ subagents: undefined, canDispatch: false });
    expect(
      await countReviewDispatch({
        runtime: "claude-code",
        agentDir: undefined,
        eventsPath: undefined,
      }),
    ).toEqual({ subagents: undefined, canDispatch: false });
  });
});
