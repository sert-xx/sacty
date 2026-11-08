import { STEP_PLANS, StepKey, type StepPlan, stepAgentChangeable } from "@sacty/core";

/**
 * タスクの作成のダイアログで選べる、タスクのイメージ（PBI-318）と、進め方の工程ごとのエージェント。
 *
 * 候補は、ダイアログの「工程ごとに設定」を開いたときに読む（普段は既定のまま作るので、ダイアログを開くたび・画面の自動の
 * 更新のたびには読まない）。
 */
export type StepOptions =
  | { status: "idle" }
  | { status: "loading" }
  | {
      status: "loaded";
      /** 既定のイメージ（default）と、config.yaml の images（説明つき）。 */
      images: { name: string; description: string }[];
      /** config.yaml の agents（モデル・リーズニングエフォートつき）。 */
      agents: { id: string; model?: string; reasoningEffort?: string }[];
      /** config.yaml で決まる、工程ごとのエージェントの名前（指定しないときに使うもの）。 */
      stepAgents: Partial<Record<StepKey, string>>;
    }
  | { status: "failed"; message: string };

/** 工程ごとの指定（エージェント）。書いていない工程は、いつもどおり決める。 */
export type StepChoices = Partial<Record<StepKey, string>>;

/** 人が選んだタスクのイメージ（PBI-318）と、工程ごとのエージェント。イメージが無ければ、いつもどおり決める。 */
export type TaskChoices = { image?: string; agents: StepChoices };

/** 候補を返す画面のパス（apps/web/src/app/step-options/route.ts）。 */
export const STEP_OPTIONS_PATH = "/step-options";

/** フォームの項目の名前（タスクのイメージは1つ、エージェントは工程ごと）。 */
export const IMAGE_FIELD = "image";
export const agentField = (step: StepKey) => `agent:${step}`;

/**
 * 候補を読む。失敗しても投げず、理由を返す（noAnswer は、理由を受け取れなかったときの文言）。
 */
export async function fetchStepOptions(
  noAnswer: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Extract<StepOptions, { status: "loaded" | "failed" }>> {
  try {
    const res = await fetchImpl(STEP_OPTIONS_PATH, { cache: "no-store" });
    const body = (await res.json().catch(() => undefined)) as
      | { images?: unknown; agents?: unknown; stepAgents?: unknown; message?: unknown }
      | undefined;
    if (!res.ok || !body || !Array.isArray(body.images) || !Array.isArray(body.agents)) {
      return {
        status: "failed",
        message: typeof body?.message === "string" ? body.message : noAnswer,
      };
    }
    return {
      status: "loaded",
      images: body.images as { name: string; description: string }[],
      agents: body.agents as { id: string; model?: string; reasoningEffort?: string }[],
      stepAgents:
        body.stepAgents && typeof body.stepAgents === "object"
          ? (body.stepAgents as Partial<Record<StepKey, string>>)
          : {},
    };
  } catch {
    return { status: "failed", message: noAnswer };
  }
}

/**
 * 工程ごとの設定を開くたびに候補を読む（読み込み中・読めたなら読み直さない。読めなかったなら読み直す）。ダイアログを
 * 開き直したら cancel で前の読み込みの結果を捨てる（遅れて届いた結果で、今の状態を上書きしない）。
 */
export function stepOptionsLoader(load = fetchStepOptions) {
  let latest = 0;
  let state: StepOptions["status"] = "idle";
  const start = (noAnswer: string, set: (options: StepOptions) => void): void => {
    if (state === "loading" || state === "loaded") return;
    const current = ++latest;
    state = "loading";
    set({ status: "loading" });
    void load(noAnswer).then((result) => {
      if (latest !== current) return;
      state = result.status;
      set(result);
    });
  };
  start.cancel = () => {
    latest++;
    state = "idle";
  };
  return start;
}

/** 工程ごとに、どれを指定できるか（エージェントは、ゴールガーディアンが行う統合レビューを除く）。 */
export function planStepSettings(plan: StepPlan): { step: StepKey; agent: boolean }[] {
  return STEP_PLANS[plan].map((step) => ({ step, agent: stepAgentChangeable(step) }));
}

/**
 * 進め方の工程のうち、エージェントを指定したもの（作成で送るもの）。進め方を選び直しても、工程ごとの指定は残し、今の
 * 進め方にある工程の分だけを使う（ほかの進め方に戻したときに、選び直さなくてよいように）。
 */
export function chosenForPlan(plan: StepPlan, agents: StepChoices): StepChoices {
  return Object.fromEntries(
    planStepSettings(plan).flatMap(({ step, agent }) =>
      agent && agents[step] ? [[step, agents[step]]] : [],
    ),
  );
}

/** エージェントを指定した工程。 */
export function customizedSteps(plan: StepPlan, agents: StepChoices): StepKey[] {
  const chosen = chosenForPlan(plan, agents);
  return STEP_PLANS[plan].filter((step) => chosen[step]);
}

/** フォームから、タスクのイメージと工程ごとのエージェントを読む（空欄は、指定しない）。 */
export function stepChoicesFrom(formData: FormData): TaskChoices {
  const agents = Object.fromEntries(
    StepKey.options.flatMap((step) => {
      const value = formData.get(agentField(step));
      return typeof value === "string" && value !== "" ? [[step, value]] : [];
    }),
  ) as StepChoices;
  const image = formData.get(IMAGE_FIELD);
  return { ...(typeof image === "string" && image !== "" ? { image } : {}), agents };
}

/** 再開の欄で、描いたときの今の名前を送る項目の名前（タスクのイメージは1つ、エージェントは工程ごと）。 */
export const IMAGE_FROM_FIELD = "image-from";
export const agentFromField = (step: StepKey) => `agent-from:${step}`;

/**
 * 再開・差し戻しの欄の選択から、人が変えたものだけを返す（描いたときの今の名前と同じものは除く）。触っていないものの
 * 古い名前を送り、その間にタスクの詳細で変えた名前を黙って戻さないため。
 */
export function changedStepChoices(formData: FormData): TaskChoices {
  const { image, agents } = stepChoicesFrom(formData);
  return {
    ...(image !== undefined && formData.get(IMAGE_FROM_FIELD) !== image ? { image } : {}),
    agents: Object.fromEntries(
      Object.entries(agents).filter(
        ([step, name]) => formData.get(agentFromField(step as StepKey)) !== name,
      ),
    ) as StepChoices,
  };
}
