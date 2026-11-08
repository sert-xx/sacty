"use client";

import type { StepKey } from "@sacty/core";
import { useMessages } from "@/i18n/client";
import {
  agentField,
  agentFromField,
  IMAGE_FIELD,
  IMAGE_FROM_FIELD,
  type TaskChoices,
} from "@/lib/step-options";
import { useSelectValue } from "@/lib/use-select-value";

const SELECT =
  "h-9 w-full min-w-0 rounded-md border border-border bg-card px-2 font-mono text-sm disabled:opacity-60";

/**
 * 再開・差し戻しと一緒に変えられるタスクのイメージ（PBI-318）。current は今のタスクのイメージ（古い版の作業履歴で工程ごとの
 * イメージなら undefined）。options が undefined なら、候補を確かめられない（設定を読めない）ので選ばせない。
 */
export type TaskImageChoice = {
  current?: string;
  options?: { name: string; description: string }[];
};

/**
 * 再開・差し戻しと一緒に変えられる工程の設定の1行（これから実行する工程）。agent が undefined の工程（統合レビュー）は、
 * エージェントを変えられない。options が undefined なら、候補を確かめられないので選ばせない。
 */
export type StepChoiceSetting = {
  step: StepKey;
  agent?: {
    current?: string;
    options?: { id: string; model?: string; reasoningEffort?: string }[];
  };
};

/**
 * タスクのイメージの選択と、工程を行・エージェントを列にした選択の表（再開の欄と、差し戻しのフォームで共通）。chosen は、
 * エラーで戻ってきたときに人が選んでいた名前。idPrefix は、選択の id・data-testid の頭（`<頭>-image`・`<頭>-agent-<工程>`）。
 */
export function StepChoiceTable({
  image,
  steps,
  chosen,
  idPrefix,
}: {
  image: TaskImageChoice;
  steps: StepChoiceSetting[];
  chosen: Partial<TaskChoices>;
  idPrefix: string;
}) {
  const r = useMessages().parts.resume;
  return (
    // 幅は置き場所（再開の欄・差し戻しのフォームの狭い列）で違うので、画面ではなく表の幅で並べ方を変える
    <div className="@container flex flex-col gap-3">
      <TaskImageChoiceRow image={image} chosen={chosen.image} idPrefix={idPrefix} />
      {steps.length > 0 && (
        <div className="flex flex-col gap-2">
          <div
            aria-hidden="true"
            className="hidden grid-cols-[8.5rem_minmax(0,1fr)] gap-x-2 text-xs font-medium text-muted-foreground @sm:grid"
          >
            <span />
            <span>{r.stepAgent}</span>
          </div>
          <ul className="flex flex-col gap-3 @sm:gap-2">
            {steps.map((s) => (
              <StepChoiceRow
                key={s.step}
                setting={s}
                idPrefix={idPrefix}
                chosenAgent={chosen.agents?.[s.step]}
              />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/**
 * タスクのイメージの選択（PBI-318）。選択は非制御のまま（自動の更新で、選んでいる途中の値を消さない）、今の名前を初めに
 * 選んでおく。描いたときの今の名前も送り、Server Action は人が変えたときだけデーモンへ渡す（その間に変えた名前を戻さない）。
 * 今の名前が候補から消えていた・古い版の工程ごとのイメージなら、空の選択にして送らない（選び直してもらう）。
 */
function TaskImageChoiceRow({
  image,
  chosen,
  idPrefix,
}: {
  image: TaskImageChoice;
  chosen?: string;
  idPrefix: string;
}) {
  const m = useMessages();
  const r = m.parts.resume;
  const known = image.options?.some((o) => o.name === image.current);
  const initial = chosen ?? (known && image.current ? image.current : "");
  const [selected, selectRef] = useSelectValue(initial);
  const note = image.options?.find((o) => o.name === selected)?.description;
  const id = `${idPrefix}-image`;
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium">
        {r.taskImage}
      </label>
      {image.options ? (
        <>
          {image.current && <input type="hidden" name={IMAGE_FROM_FIELD} value={image.current} />}
          {/* 今の名前（タスクの詳細で変えた後）か、エラーで戻した選択が変わったら作り直す（非制御の選択は、初めの値が
              変わっても選択を変えないため） */}
          <select
            key={`${image.current ?? ""}:${chosen ?? ""}`}
            id={id}
            name={IMAGE_FIELD}
            ref={selectRef}
            defaultValue={initial}
            aria-describedby={note ? `${id}-note` : undefined}
            data-testid={id}
            className={SELECT}
          >
            {!known && (
              <option value="" disabled>
                {image.current ?? m.task.images.perStep}
              </option>
            )}
            {image.options.map((o) => (
              <option key={o.name} value={o.name} title={o.description}>
                {o.name}
              </option>
            ))}
          </select>
          {note && (
            <p id={`${id}-note`} className="text-xs leading-5 wrap-anywhere text-muted-foreground">
              {note}
            </p>
          )}
        </>
      ) : (
        <span className="flex min-h-9 items-center font-mono text-sm" data-testid={id}>
          {image.current ?? m.task.images.perStep}
        </span>
      )}
      <p className="text-xs leading-5 text-muted-foreground">{r.taskImageNote}</p>
    </div>
  );
}

/**
 * 工程のエージェントの1行。選択は非制御のまま、今の名前を初めに選んでおく。描いたときの今の名前も送る（タスクのイメージと
 * 同じ）。候補の出し方は、タスクの詳細の StepAgentForm と同じ（モデルとリーズニングエフォート）。
 */
function StepChoiceRow({
  setting: s,
  idPrefix,
  chosenAgent,
}: {
  setting: StepChoiceSetting;
  idPrefix: string;
  chosenAgent?: string;
}) {
  const m = useMessages();
  const label = m.labels.step[s.step];
  const agentCurrent = s.agent?.current;
  const agentKnown = s.agent?.options?.some((o) => o.id === agentCurrent);
  const initialAgent = chosenAgent ?? (agentKnown ? agentCurrent : "");
  const agentId = `${idPrefix}-agent-${s.step}`;
  return (
    <li
      className="grid grid-cols-1 items-start gap-x-2 gap-y-1 @sm:grid-cols-[8.5rem_minmax(0,1fr)]"
      data-testid={`${idPrefix}-${s.step}`}
    >
      <span className="flex min-h-9 items-center text-sm font-medium">{label}</span>
      <div className="flex min-w-0 flex-col gap-1">
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
