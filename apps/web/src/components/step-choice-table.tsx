"use client";

import type { StepKey } from "@sacty/core";
import { useMessages } from "@/i18n/client";
import {
  agentField,
  agentFromField,
  imageField,
  imageFromField,
  type StepChoices,
} from "@/lib/step-options";
import { useSelectValue } from "@/lib/use-select-value";

const SELECT =
  "h-9 w-full min-w-0 rounded-md border border-border bg-card px-2 font-mono text-sm disabled:opacity-60";

/**
 * 再開・差し戻しと一緒に変えられる工程の設定の1行（これから実行する工程）。options が undefined なら、候補を確かめられない
 * （設定を読めない）ので選ばせない。agent が undefined の工程（統合レビュー）は、エージェントを変えられない。
 */
export type StepChoiceSetting = {
  step: StepKey;
  image: string;
  imageOptions?: { name: string; description: string }[];
  agent?: {
    current?: string;
    options?: { id: string; model?: string; reasoningEffort?: string }[];
  };
};

/**
 * 工程を行に、イメージ・エージェントを列にした選択の表（再開の欄と、差し戻しのフォームで共通）。chosen は、エラーで
 * 戻ってきたときに人が選んでいた名前。idPrefix は、選択の id・data-testid の頭（`<頭>-image-<工程>` など）。
 */
export function StepChoiceTable({
  steps,
  chosen,
  idPrefix,
}: {
  steps: StepChoiceSetting[];
  chosen: { images?: StepChoices; agents?: StepChoices };
  idPrefix: string;
}) {
  const r = useMessages().parts.resume;
  return (
    // 幅は置き場所（再開の欄・差し戻しのフォームの狭い列）で違うので、画面ではなく表の幅で並べ方を変える
    <div className="@container flex flex-col gap-2">
      <div
        aria-hidden="true"
        className="hidden grid-cols-[8.5rem_minmax(0,1fr)_minmax(0,1fr)] gap-x-2 text-xs font-medium text-muted-foreground @xl:grid"
      >
        <span />
        <span>{r.stepImage}</span>
        <span>{r.stepAgent}</span>
      </div>
      <ul className="flex flex-col gap-3 @xl:gap-2">
        {steps.map((s) => (
          <StepChoiceRow
            key={s.step}
            setting={s}
            idPrefix={idPrefix}
            chosenImage={chosen.images?.[s.step]}
            chosenAgent={chosen.agents?.[s.step]}
          />
        ))}
      </ul>
    </div>
  );
}

/**
 * 工程の設定の1行。選択は非制御のまま（自動の更新で、選んでいる途中の値を消さない）、今の名前を初めに選んでおく。
 * 描いたときの今の名前も送り、Server Action は人が変えた工程だけをデーモンへ渡す（その間に変えた名前を戻さない）。
 * 今の名前が候補から消えていたら、空の選択にして送らない（選び直してもらう）。候補の出し方は、タスクの詳細の
 * StepImageForm・StepAgentForm と同じ（イメージは選んだものの説明、エージェントはモデルとリーズニングエフォート）。
 */
function StepChoiceRow({
  setting: s,
  idPrefix,
  chosenImage,
  chosenAgent,
}: {
  setting: StepChoiceSetting;
  idPrefix: string;
  chosenImage?: string;
  chosenAgent?: string;
}) {
  const m = useMessages();
  const r = m.parts.resume;
  const label = m.labels.step[s.step];
  const imageKnown = s.imageOptions?.some((o) => o.name === s.image);
  const initialImage = chosenImage ?? (imageKnown ? s.image : "");
  const [image, imageRef] = useSelectValue(initialImage);
  const imageNote = s.imageOptions?.find((o) => o.name === image)?.description;
  const agentCurrent = s.agent?.current;
  const agentKnown = s.agent?.options?.some((o) => o.id === agentCurrent);
  const initialAgent = chosenAgent ?? (agentKnown ? agentCurrent : "");
  const imageId = `${idPrefix}-image-${s.step}`;
  const agentId = `${idPrefix}-agent-${s.step}`;
  return (
    <li
      className="grid grid-cols-1 items-start gap-x-2 gap-y-1 @sm:grid-cols-2 @xl:grid-cols-[8.5rem_minmax(0,1fr)_minmax(0,1fr)]"
      data-testid={`${idPrefix}-${s.step}`}
    >
      <span className="flex min-h-9 items-center text-sm font-medium @sm:col-span-2 @xl:col-span-1">
        {label}
      </span>
      <div className="flex min-w-0 flex-col gap-1">
        {/* 狭い幅では列の見出しを出さないので、選択ごとに小さな見出しを出す */}
        <span aria-hidden="true" className="text-xs text-muted-foreground @xl:hidden">
          {r.stepImage}
        </span>
        {s.imageOptions ? (
          <>
            <input type="hidden" name={imageFromField(s.step)} value={s.image} />
            {/* 今の名前（タスクの詳細で変えた後）か、エラーで戻した選択が変わったら作り直す（非制御の選択は、初めの値が
                変わっても選択を変えないため）。イメージとエージェントで分け、変わった方だけを作り直す */}
            <select
              key={`${s.image}:${chosenImage ?? ""}`}
              id={imageId}
              name={imageField(s.step)}
              ref={imageRef}
              defaultValue={initialImage}
              aria-label={m.task.images.label(label)}
              aria-describedby={imageNote ? `${imageId}-note` : undefined}
              data-testid={imageId}
              className={SELECT}
            >
              {!imageKnown && (
                <option value="" disabled>
                  {s.image}
                </option>
              )}
              {s.imageOptions.map((o) => (
                <option key={o.name} value={o.name} title={o.description}>
                  {o.name}
                </option>
              ))}
            </select>
            {imageNote && (
              <p
                id={`${imageId}-note`}
                className="text-xs leading-5 wrap-anywhere text-muted-foreground"
              >
                {imageNote}
              </p>
            )}
          </>
        ) : (
          <span className="flex min-h-9 items-center font-mono text-sm">{s.image}</span>
        )}
      </div>
      <div className="flex min-w-0 flex-col gap-1">
        <span aria-hidden="true" className="text-xs text-muted-foreground @xl:hidden">
          {r.stepAgent}
        </span>
        {s.agent?.options ? (
          <>
            {agentCurrent && (
              <input type="hidden" name={agentFromField(s.step)} value={agentCurrent} />
            )}
            <select
              key={`${agentCurrent ?? ""}:${chosenAgent ?? ""}`}
              id={agentId}
              name={agentField(s.step)}
              defaultValue={initialAgent}
              aria-label={m.task.agents.label(label)}
              data-testid={agentId}
              className={SELECT}
            >
              {!agentKnown && (
                <option value="" disabled>
                  {agentCurrent ?? m.task.agents.unknown}
                </option>
              )}
              {s.agent.options.map((o) => (
                <option key={o.id} value={o.id}>
                  {m.task.agents.option(o.id, o.model, o.reasoningEffort)}
                </option>
              ))}
            </select>
          </>
        ) : (
          <span className="flex min-h-9 items-center font-mono text-sm text-muted-foreground">
            {s.agent ? (agentCurrent ?? m.task.agents.unknown) : "—"}
          </span>
        )}
      </div>
    </li>
  );
}
