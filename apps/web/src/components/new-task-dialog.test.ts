import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { messagesFor } from "@/i18n";
import type { Locale } from "@/i18n/locale";
import type { RepositoryCandidates } from "@/lib/repository-candidates";

let locale: Locale = "ja";
vi.mock("@/i18n/client", () => ({ useMessages: () => messagesFor(locale) }));
vi.mock("@/app/actions", () => ({ createTaskAction: async () => ({}) }));

const { CandidatesProblems, CandidatesStatus } = await import("./new-task-dialog");

const render = (candidates: RepositoryCandidates) =>
  renderToStaticMarkup(
    createElement("div", null, [
      createElement(CandidatesProblems, { candidates, key: "p" }),
      createElement(CandidatesStatus, { candidates, key: "s" }),
    ]),
  );

describe("タスクの作成のダイアログの、リポジトリの候補（PBI-109）", () => {
  it("取得の途中・失敗・空を、ダイアログの中でわかるように出す（どれも URL を入力して作成できると添える）", () => {
    for (const lang of ["ja", "en"] as const) {
      locale = lang;
      const t = messagesFor(lang).forms.task;
      expect(render({ status: "loading" }), lang).toContain(t.repositoriesLoading);
      expect(render({ status: "loading" }), lang).toContain('role="status"');
      const failed = render({ status: "failed", message: "boom" });
      expect(failed, lang).toContain(t.repositoriesFailed("boom"));
      expect(failed, lang).toContain('role="alert"');
      expect(render({ status: "loaded", repositories: [], problems: [] }), lang).toContain(
        t.repositoriesEmpty,
      );
    }
    locale = "ja";
  });

  it("候補を読めなかった Org の理由は、今と同じく出す（空の文言は重ねない）", () => {
    const t = messagesFor("ja").forms.task;
    const problem = t.listFailed("acme", "gh に認証されていません");
    const html = render({ status: "loaded", repositories: [], problems: [problem] });
    expect(html).toContain(problem);
    expect(html).not.toContain(t.repositoriesEmpty);
    expect(html).not.toContain(t.repositoriesLoading);
  });

  it("候補が読めたら、状態の文言は出さない", () => {
    const t = messagesFor("ja").forms.task;
    const html = render({ status: "loaded", repositories: ["acme/api"], problems: [] });
    expect(html).not.toContain(t.repositoriesLoading);
    expect(html).not.toContain(t.repositoriesEmpty);
  });
});

const { StepFlowSummary, TaskStepSettings } = await import("./task-step-settings");

describe("タスクの作成の、タスクのイメージと進め方の工程ごとのエージェント（PBI-318）", () => {
  const loaded = {
    status: "loaded" as const,
    images: [
      { name: "default", description: "既定のイメージ" },
      { name: "java17", description: "Java 17・Maven" },
    ],
    agents: [
      { id: "codex_standard" },
      { id: "codex_advanced", model: "gpt-6.1-sol", reasoningEffort: "medium" },
    ],
    stepAgents: { requirements: "codex_standard" as const, design: "codex_standard" as const },
  };
  const settings = (props: Partial<Parameters<typeof TaskStepSettings>[0]> = {}) =>
    renderToStaticMarkup(
      createElement(TaskStepSettings, {
        plan: "split",
        options: loaded,
        image: "",
        agents: {},
        onImage: () => {},
        onAgent: () => {},
        onResetAll: () => {},
        onBack: () => {},
        ...props,
      }),
    );

  it("基本の入力には工程の並びと要約だけを出し、指定した工程に印を付ける", () => {
    const t = messagesFor("ja").forms.task;
    const none = renderToStaticMarkup(
      createElement(StepFlowSummary, {
        id: "n",
        plan: "standard",
        customized: [],
        onOpen: () => {},
      }),
    );
    expect(none).toContain(t.stepsSummaryDefault);
    expect(none).toContain(t.steps);
    expect(none).not.toContain("data-customized");
    const some = renderToStaticMarkup(
      createElement(StepFlowSummary, {
        id: "n",
        plan: "standard",
        customized: ["implement"],
        onOpen: () => {},
      }),
    );
    expect(some).toContain(t.stepsSummaryCustomized(undefined, 1));
    expect(some.match(/data-customized/g)).toHaveLength(1);
    // タスクのイメージだけを指定したときも、要約に出す（工程には印を付けない）
    const imageOnly = renderToStaticMarkup(
      createElement(StepFlowSummary, {
        id: "n",
        plan: "standard",
        image: "java17",
        customized: [],
        onOpen: () => {},
      }),
    );
    expect(imageOnly).toContain(t.stepsSummaryCustomized("java17", 0));
    expect(imageOnly).not.toContain("data-customized");
  });

  it("タスクのイメージを1つと、工程ごとのエージェント（既定は config.yaml で決まる名前）を出し、統合レビューのエージェントは選ばせない", () => {
    const t = messagesFor("ja").forms.task;
    const html = settings();
    expect(html).toContain(t.stepsTitle);
    expect(html).toContain(t.taskImage);
    expect(html).toContain(t.taskImageNote);
    expect(html).toContain(t.stepImageAuto);
    // イメージの選択は1つだけ（工程ごとには無い）
    expect(html.match(/data-testid="task-image"/g)).toHaveLength(1);
    expect(html).not.toContain("task-step-image-");
    expect(html).toContain(t.stepAgentDefault("codex_standard"));
    expect(html).toContain('value="java17"');
    expect(html).toContain('value="codex_advanced"');
    expect(html).toContain(t.stepAgentGuardian);
    expect(html).not.toContain('data-testid="task-step-agent-integrate"><option');
    // 何も指定していなければ、戻す操作は出さない（すべてを戻すボタンは押せない）
    expect(html).not.toContain(`：${t.stepReset}"`);
    expect(html).toMatch(new RegExp(`disabled=""[^>]*>${t.stepsResetAll}<`));
  });

  it("指定したタスクのイメージ・工程には、印・戻す操作・選んだものの説明を出す", () => {
    const t = messagesFor("ja").forms.task;
    const html = settings({ image: "java17", agents: { design: "codex_advanced" } });
    // タスクのイメージと、設計の工程
    expect(html.match(/data-customized="true"/g)).toHaveLength(2);
    expect(html).toContain(`aria-label="設計：${t.stepReset}"`);
    expect(html).not.toMatch(new RegExp(`disabled=""[^>]*>${t.stepsResetAll}<`));
    expect(html).toContain("Java 17・Maven");
    expect(html).toContain("gpt-6.1-sol・medium");
  });

  it("候補の読み込み中は選べず、読めなければ理由と、既定のまま作成できることを出す", () => {
    const t = messagesFor("ja").forms.task;
    const loading = settings({ options: { status: "loading" } });
    expect(loading).toContain(t.stepOptionsLoading);
    expect(loading).toMatch(/<select[^>]*disabled=""/);
    const failed = settings({ options: { status: "failed", message: "読めません" } });
    expect(failed).toContain(t.stepOptionsFailed("読めません"));
    expect(failed).toContain(t.stepOptionsFailedNote);
    // 前に選んだ値は、候補を読めなくても見せる
    expect(settings({ options: { status: "loading" }, image: "java17" })).toContain(
      'value="java17"',
    );
  });
});
