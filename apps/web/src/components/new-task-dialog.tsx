"use client";

import { STEP_PLANS, type StepKey, type StepPlan, type TaskTemplate } from "@sacty/core";
import Link from "next/link";
import { type Ref, useActionState, useEffect, useRef, useState } from "react";
import { type CreateTaskState, createTaskAction } from "@/app/actions";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Hint } from "@/components/ui/hint";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useMessages } from "@/i18n/client";
import { projectSettingsPath } from "@/lib/paths";
import { candidatesLoader, type RepositoryCandidates } from "@/lib/repository-candidates";
import {
  agentField,
  chosenForPlan,
  customizedSteps,
  imageField,
  type StepChoices,
  type StepOptions,
  stepOptionsLoader,
} from "@/lib/step-options";
import { StepFlowSummary, TaskStepSettings } from "./task-step-settings";

const initial: CreateTaskState = {};

const SELECT =
  "h-9 rounded-md border border-input bg-card px-2 text-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none";

/** 選択肢に並べる進め方の順（実装する組み合わせ → 実装しない組み合わせ）。 */
const PLAN_ORDER: readonly StepPlan[] = [
  "standard",
  "skip-design",
  "direct",
  "bugfix",
  "split",
  "investigate",
  "review",
  "document",
  "operation",
  "design-only",
  "security-check",
  "security-fix",
];

/**
 * タスクの作成。作成先は、この画面を表示したときのプロジェクトに固定する
 * （入力中に別のタブでプロジェクトを切り替えても、表示していたプロジェクトに作るため）。
 */
export function NewTaskDialog({
  projectId,
  projectName,
  hasTargets,
}: {
  projectId: string;
  projectName: string;
  /**
   * プロジェクトに対象があるか。候補が無くても（読めなかったなど）、対象があれば名前を入力できる
   * （対象の範囲かどうかはデーモンが確かめる）。
   */
  hasTargets: boolean;
}) {
  const [state, formAction, pending] = useActionState(createTaskAction, initial);
  const messages = useMessages();
  const t = messages.forms.task;
  // 作成先は、ダイアログを開いたときのプロジェクトに固定し、閉じるまで変えない
  // （入力中に画面が自動で更新され、別のタブで切り替えたプロジェクトが props で渡されても、
  // 書いている途中のタスクの作成先は変えないため）
  const [target, setTarget] = useState({ id: projectId, name: projectName, hasTargets });
  // 対象リポジトリの候補（プロジェクトの対象から。Org の対象は gh で読む。PBI-25）。画面の描画では読まず、
  // ダイアログを開いたときに読む（ボタンを候補を待たずに出し、画面の自動の更新のたびに GitHub に問い合わせないため。PBI-109）
  const [candidates, setCandidates] = useState<RepositoryCandidates>({ status: "loading" });
  const [loadCandidates] = useState(() => candidatesLoader());
  const repositories = candidates.status === "loaded" ? candidates.repositories : [];
  // タスクのテンプレート（PBI-90）。選ぶと、リポジトリを選ぶだけのフォームになる（題と説明は sacty が決める）
  // 送信の後も選んだままにする（理由を返したときも、同じフォームのまま直せる）
  const [template, setTemplate] = useState<TaskTemplate | "">("");
  // 工程の組み合わせ（進め方）。空なら自動（オーケストレーターが選ぶ）。送信の後も選んだままにする
  const [plan, setPlan] = useState<StepPlan | "">("");
  // 進め方の工程ごとのイメージ・エージェント。基本の入力とは別の画面（工程ごとの設定）で選ぶ。進め方を選び直しても
  // 工程ごとに残し、今の進め方の工程の分だけを送る。送信の後も選んだままにする
  const [view, setView] = useState<"main" | "steps">("main");
  const [stepImages, setStepImages] = useState<StepChoices>({});
  const [stepAgents, setStepAgents] = useState<StepChoices>({});
  // 選べるイメージ・エージェント。工程ごとの設定を開いたときに読む（既定のまま作るときは読まない）
  const [stepOptions, setStepOptions] = useState<StepOptions>({ status: "idle" });
  const [loadStepOptions] = useState(() => stepOptionsLoader());
  // 画面を切り替えたら、移った先の見出し（戻ったときは、開いたボタン）にフォーカスを移す
  const stepsHeading = useRef<HTMLHeadingElement>(null);
  const stepsOpener = useRef<HTMLButtonElement>(null);
  const switched = useRef(false);
  useEffect(() => {
    if (!switched.current) return;
    switched.current = false;
    (view === "steps" ? stepsHeading.current : stepsOpener.current)?.focus();
  }, [view]);
  const show = (next: "main" | "steps") => {
    switched.current = true;
    setView(next);
    if (next === "steps") loadStepOptions(t.repositoriesNoAnswer, setStepOptions);
  };
  const choose =
    (set: (update: (prev: StepChoices) => StepChoices) => void) => (step: StepKey, name: string) =>
      set((prev) => {
        const { [step]: _removed, ...rest } = prev;
        return name ? { ...rest, [step]: name } : rest;
      });
  const customizable = !template && plan !== "";
  const chosen = plan ? chosenForPlan(plan, stepImages, stepAgents) : { images: {}, agents: {} };

  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) return;
        setTarget({ id: projectId, name: projectName, hasTargets });
        setTemplate("");
        setPlan("");
        setView("main");
        setStepImages({});
        setStepAgents({});
        // 候補は、開き直すたびに読み直す（config.yaml を直した後に、古い候補を見せない）
        setStepOptions({ status: "idle" });
        loadStepOptions.cancel();
        // 対象が無ければ読まない（候補は無く、プロジェクトの設定を案内する）
        loadCandidates(projectId, hasTargets, t.repositoriesNoAnswer, setCandidates);
      }}
    >
      <DialogTrigger render={<Button size="lg" />}>{t.create}</DialogTrigger>
      <DialogContent className="sm:max-w-xl">
        <form action={formAction} className="flex flex-col gap-4">
          <input type="hidden" name="projectId" value={target.id} />
          {/* 工程ごとの指定は、別の画面で選び、ここから送る（画面を切り替えても、入力中の題・内容を残すため、どちらの画面も消さずに隠す） */}
          {customizable &&
            Object.entries(chosen.images).map(([step, name]) => (
              <input
                key={`image:${step}`}
                type="hidden"
                name={imageField(step as StepKey)}
                value={name}
              />
            ))}
          {customizable &&
            Object.entries(chosen.agents).map(([step, name]) => (
              <input
                key={`agent:${step}`}
                type="hidden"
                name={agentField(step as StepKey)}
                value={name}
              />
            ))}
          <div hidden={customizable && view === "steps"} className="flex flex-col gap-4">
            <DialogHeader>
              <DialogTitle>{t.create}</DialogTitle>
              <DialogDescription className="flex items-center gap-1">
                {t.description(target.name)}
                <Hint text={t.descriptionHint} className="size-4" />
              </DialogDescription>
            </DialogHeader>
            {target.hasTargets && <CandidatesProblems candidates={candidates} />}
            <TaskFields
              idPrefix="task"
              projectId={target.id}
              hasTargets={target.hasTargets}
              candidates={candidates}
              template={template}
              onTemplate={setTemplate}
              plan={plan}
              onPlan={setPlan}
              steps={{
                customized: plan ? customizedSteps(plan, stepImages, stepAgents) : [],
                onOpen: () => show("steps"),
                openRef: stepsOpener,
              }}
              // 候補が1つなら入れておく
              repoDefault={state.values?.repo ?? (repositories.length === 1 ? repositories[0] : "")}
              titleDefault={state.values?.title}
              bodyDefault={state.values?.body}
              titleError={state.fieldErrors?.title?.[0]}
              bodyError={state.fieldErrors?.body?.[0]}
              autoFocus
            />
            {state.message && (
              <p role="alert" className="text-sm text-warn">
                {state.message}
              </p>
            )}
            <DialogFooter>
              <DialogClose render={<Button variant="outline" type="button" />}>
                {t.close}
              </DialogClose>
              <Button type="submit" disabled={pending || !target.hasTargets}>
                {pending ? t.creating : t.submit}
              </Button>
            </DialogFooter>
          </div>
          {customizable && (
            <div hidden={view !== "steps"}>
              <TaskStepSettings
                plan={plan}
                options={stepOptions}
                images={stepImages}
                agents={stepAgents}
                onImage={choose(setStepImages)}
                onAgent={choose(setStepAgents)}
                onResetAll={() => {
                  setStepImages({});
                  setStepAgents({});
                }}
                onBack={() => show("main")}
                headingRef={stepsHeading}
              />
            </div>
          )}
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * タスクの内容の項目（テンプレート・対象リポジトリ・進め方・題・内容）。タスクの作成のダイアログと、スケジュールタスクの
 * 作成・編集で使う（同じ項目を同じ規則で選ぶ）。idPrefix は、同じ画面に2つ置いても項目の ID を重ねないため。
 */
export function TaskFields({
  idPrefix,
  projectId,
  hasTargets,
  candidates,
  template,
  onTemplate,
  plan,
  onPlan,
  steps,
  repoDefault,
  titleDefault,
  bodyDefault,
  titleError,
  bodyError,
  autoFocus,
}: {
  idPrefix: string;
  projectId: string;
  hasTargets: boolean;
  candidates: RepositoryCandidates;
  template: TaskTemplate | "";
  onTemplate: (template: TaskTemplate | "") => void;
  plan: StepPlan | "";
  onPlan: (plan: StepPlan | "") => void;
  /**
   * 進め方の工程ごとの設定（タスクの作成のダイアログだけ）。指定した工程と、工程ごとの設定を開く操作。無ければ、工程の
   * 並びだけを出す（スケジュールタスク）。
   */
  steps?: {
    customized: readonly StepKey[];
    onOpen: () => void;
    openRef?: Ref<HTMLButtonElement>;
  };
  repoDefault?: string;
  titleDefault?: string;
  bodyDefault?: string;
  titleError?: string;
  bodyError?: string;
  autoFocus?: boolean;
}) {
  const messages = useMessages();
  const t = messages.forms.task;
  const repositories = candidates.status === "loaded" ? candidates.repositories : [];
  return (
    <>
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 text-sm font-medium">{t.template}</legend>
        <div className="flex flex-wrap items-center gap-1 self-start rounded-md border border-input p-0.5">
          {(
            [
              ["", t.templateNone],
              ["sacty-setup", t.templateSetup],
              ["security-check", t.templateSecurityCheck],
            ] as const
          ).map(([value, label]) => (
            <label
              key={value || "none"}
              className={`cursor-pointer rounded px-3 py-1 text-sm has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring ${
                template === value ? "bg-muted font-semibold" : "text-muted-foreground"
              }`}
            >
              <input
                type="radio"
                name="template"
                value={value}
                checked={template === value}
                className="sr-only"
                onChange={() => onTemplate(value)}
              />
              {label}
            </label>
          ))}
        </div>
        {template === "sacty-setup" && (
          <p
            data-testid="template-setup-hint"
            className="flex flex-wrap items-center gap-1 text-xs leading-5 text-muted-foreground"
          >
            {t.templateSetupNote}
            <Hint text={t.templateSetupHint} className="size-4" />
          </p>
        )}
        {template === "security-check" && (
          <p
            data-testid="template-security-hint"
            className="flex flex-wrap items-center gap-1 text-xs leading-5 text-muted-foreground"
          >
            {t.templateSecurityCheckNote}
            <Hint text={t.templateSecurityCheckHint} className="size-4" />
          </p>
        )}
      </fieldset>
      {!hasTargets ? (
        <p role="alert" className="text-sm text-warn">
          {t.noRepository}{" "}
          <Link href={projectSettingsPath(projectId)} className="underline">
            {t.projectSettings}
          </Link>
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          <span className="flex items-center gap-1">
            <Label htmlFor={`${idPrefix}-repo`}>
              {template ? t.repositoryRequired : t.repository}
            </Label>
            <Hint text={template ? t.templateRepositoryHint : t.repositoryHint} />
          </span>
          {/* Org の対象ではリポジトリが多いので、入力して絞り込めるようにする */}
          {/* 空欄なら、リポジトリを指定せずに作る（PBI-73） */}
          <Input
            id={`${idPrefix}-repo`}
            name="repo"
            list={`${idPrefix}-repo-options`}
            autoComplete="off"
            required={template !== ""}
            // 候補が届く前に入力していれば、入力を残す（React は、入力していないときだけ defaultValue の変化を
            // 表示に反映する）
            defaultValue={repoDefault}
            placeholder={t.repositoryPlaceholder}
            className="font-mono"
          />
          <datalist id={`${idPrefix}-repo-options`}>
            {repositories.map((repo) => (
              <option key={repo} value={repo} />
            ))}
          </datalist>
          <CandidatesStatus candidates={candidates} />
        </div>
      )}
      {/* テンプレートでは、題と説明を入力させない（PBI-90） */}
      {!template && (
        <>
          <div className="flex flex-col gap-2">
            <span className="flex items-center gap-1">
              <Label htmlFor={`${idPrefix}-plan`}>{t.plan}</Label>
              <Hint text={t.planHint} />
            </span>
            <select
              id={`${idPrefix}-plan`}
              name="plan"
              className={`${SELECT} self-start`}
              value={plan}
              onChange={(e) => onPlan(e.target.value as StepPlan | "")}
              aria-describedby={`${idPrefix}-plan-note`}
            >
              <option value="">{t.planAuto}</option>
              {PLAN_ORDER.map((key) => (
                <option key={key} value={key}>
                  {messages.labels.plan[key]}
                </option>
              ))}
            </select>
            {plan && steps ? (
              <StepFlowSummary
                id={`${idPrefix}-plan-note`}
                plan={plan}
                customized={steps.customized}
                onOpen={steps.onOpen}
                openRef={steps.openRef}
              />
            ) : (
              <p
                id={`${idPrefix}-plan-note`}
                data-testid={`${idPrefix}-plan-note`}
                className="text-xs leading-5 text-muted-foreground"
              >
                {plan
                  ? STEP_PLANS[plan].map((step) => messages.labels.step[step]).join(" → ")
                  : t.planAutoNote}
              </p>
            )}
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor={`${idPrefix}-title`}>{t.title}</Label>
            <Input
              id={`${idPrefix}-title`}
              name="title"
              defaultValue={titleDefault}
              aria-invalid={Boolean(titleError)}
              aria-describedby={titleError ? `${idPrefix}-title-error` : undefined}
              autoFocus={autoFocus}
            />
            {titleError && (
              <p id={`${idPrefix}-title-error`} className="text-sm text-warn">
                {titleError}
              </p>
            )}
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor={`${idPrefix}-body`}>{t.body}</Label>
            <Textarea
              id={`${idPrefix}-body`}
              name="body"
              rows={6}
              className="max-h-72 overflow-y-auto"
              defaultValue={bodyDefault}
              placeholder={t.bodyPlaceholder}
              aria-invalid={Boolean(bodyError)}
              aria-describedby={bodyError ? `${idPrefix}-body-error` : undefined}
            />
            {bodyError && (
              <p id={`${idPrefix}-body-error`} className="text-sm text-warn">
                {bodyError}
              </p>
            )}
          </div>
        </>
      )}
    </>
  );
}

/** 候補を読めなかった Org と、その理由（ダイアログの上に出す。PBI-25）。 */
export function CandidatesProblems({ candidates }: { candidates: RepositoryCandidates }) {
  if (candidates.status !== "loaded" || candidates.problems.length === 0) return null;
  return (
    <ul role="alert" className="flex flex-col gap-1 text-sm text-warn">
      {candidates.problems.map((p) => (
        <li key={p}>{p}</li>
      ))}
    </ul>
  );
}

/** 候補の読み込みの途中・失敗・空（PBI-109）。どの状態でも、URL を入力して作成できる。 */
export function CandidatesStatus({ candidates }: { candidates: RepositoryCandidates }) {
  const t = useMessages().forms.task;
  if (candidates.status === "loading") {
    return (
      <p role="status" className="text-xs leading-5 text-muted-foreground">
        {t.repositoriesLoading}
      </p>
    );
  }
  if (candidates.status === "failed") {
    return (
      <p role="alert" className="text-xs leading-5 text-warn">
        {t.repositoriesFailed(candidates.message)}
      </p>
    );
  }
  // 読めなかった Org があれば、その理由（上に出す）で足りる
  if (candidates.repositories.length === 0 && candidates.problems.length === 0) {
    return (
      <p role="status" className="text-xs leading-5 text-muted-foreground">
        {t.repositoriesEmpty}
      </p>
    );
  }
  return null;
}
