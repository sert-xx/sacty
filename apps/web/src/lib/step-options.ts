import { STEP_PLANS, StepKey, type StepPlan, stepAgentChangeable } from "@sacty/core";

/**
 * タスクの作成のダイアログで、進め方の工程ごとに選べるイメージ・エージェント。
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

/** 工程ごとの指定（イメージ・エージェント）。書いていない工程は、いつもどおり決める。 */
export type StepChoices = Partial<Record<StepKey, string>>;

/** 候補を返す画面のパス（apps/web/src/app/step-options/route.ts）。 */
export const STEP_OPTIONS_PATH = "/step-options";

/** フォームの項目の名前（工程ごと）。 */
export const imageField = (step: StepKey) => `image:${step}`;
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
 * 進め方の工程のうち、指定したもの（作成で送るもの）。進め方を選び直しても、工程ごとの指定は残し、今の進め方にある
 * 工程の分だけを使う（ほかの進め方に戻したときに、選び直さなくてよいように）。
 */
export function chosenForPlan(
  plan: StepPlan,
  images: StepChoices,
  agents: StepChoices,
): { images: StepChoices; agents: StepChoices } {
  const steps = planStepSettings(plan);
  return {
    images: Object.fromEntries(
      steps.flatMap(({ step }) => (images[step] ? [[step, images[step]]] : [])),
    ),
    agents: Object.fromEntries(
      steps.flatMap(({ step, agent }) => (agent && agents[step] ? [[step, agents[step]]] : [])),
    ),
  };
}

/** 指定した工程（イメージかエージェントのどちらかを指定した工程）。 */
export function customizedSteps(
  plan: StepPlan,
  images: StepChoices,
  agents: StepChoices,
): StepKey[] {
  const chosen = chosenForPlan(plan, images, agents);
  return STEP_PLANS[plan].filter((step) => chosen.images[step] || chosen.agents[step]);
}

/** フォームから、工程ごとの指定を読む（空欄は、指定しない）。 */
export function stepChoicesFrom(formData: FormData): {
  images: StepChoices;
  agents: StepChoices;
} {
  const read = (field: (step: StepKey) => string) =>
    Object.fromEntries(
      StepKey.options.flatMap((step) => {
        const value = formData.get(field(step));
        return typeof value === "string" && value !== "" ? [[step, value]] : [];
      }),
    ) as StepChoices;
  return { images: read(imageField), agents: read(agentField) };
}
