"use client";

import { STEP_PLANS, type StepPlan, type Task } from "@sacty/core";
import Link from "next/link";
import { useActionState, useState } from "react";
import { type DeriveTaskState, deriveTaskAction } from "@/app/actions";
import { CardSection } from "@/components/card-section";
import {
  CandidatesProblems,
  CandidatesStatus,
  PLAN_ORDER,
  SELECT,
} from "@/components/new-task-dialog";
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
import { candidatesLoader, type RepositoryCandidates } from "@/lib/repository-candidates";

const initial: DeriveTaskState = {};

/** セキュリティのタスクの続きに選べる進め方（記録に入るレポート・範囲を、公開の場所に出さないため）。 */
const SECURITY_PLANS: readonly StepPlan[] = ["security-fix", "security-check"];

/**
 * 完了したタスクの、続きの作業のタスク（派生）。作ったタスクを並べ、新しく作るダイアログを出す。derived は、
 * このタスクから作ったタスク（読めなかったものは ID だけ）。
 */
export function DerivedTasksCard({
  task,
  derived,
  security,
}: {
  task: Task;
  derived: { id: string; title?: string }[];
  /** セキュリティの組み合わせのタスク（続きの進め方を、セキュリティの組み合わせに限る）。 */
  security: boolean;
}) {
  const t = useMessages().parts.derive;
  return (
    <CardSection id="derived-tasks" title={t.title} hint={t.hint}>
      <div className="flex flex-col gap-3">
        {derived.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t.none}</p>
        ) : (
          <ul className="flex flex-col gap-1 text-sm" data-testid="derived-tasks">
            {derived.map((d) => (
              <li key={d.id}>
                <Link
                  href={`/tasks/${encodeURIComponent(d.id)}`}
                  className="text-accent-foreground underline"
                >
                  {d.title ?? d.id}
                </Link>
              </li>
            ))}
          </ul>
        )}
        <DeriveDialog
          taskId={task.id}
          projectId={task.projectId}
          repo={task.source?.repo ?? task.repo ?? task.repository?.url ?? ""}
          security={security}
        />
      </div>
    </CardSection>
  );
}

/**
 * 続きのタスクを作るダイアログ。題・内容（続きで何をするか）・作業するリポジトリ（空欄ならリポジトリ無し）・進め方を
 * 決めて、元のタスクを指す新しいタスクを作る。リポジトリの候補は、タスクの作成と同じく、開いたときに読む。
 */
function DeriveDialog({
  taskId,
  projectId,
  repo,
  security,
}: {
  taskId: string;
  projectId: string;
  /** 元のタスクの作業したリポジトリ（無ければ空欄）。 */
  repo: string;
  security: boolean;
}) {
  const messages = useMessages();
  const t = messages.parts.derive;
  const [state, formAction, pending] = useActionState(deriveTaskAction, initial);
  const [candidates, setCandidates] = useState<RepositoryCandidates>({ status: "loading" });
  const [loadCandidates] = useState(() => candidatesLoader());
  const repositories = candidates.status === "loaded" ? candidates.repositories : [];
  const values = state.values;
  const plans = security ? SECURITY_PLANS : PLAN_ORDER;
  const [plan, setPlan] = useState<string>(values?.plan ?? "");
  // セキュリティのタスクの続きは、選ばなければ先頭（セキュリティ対応）になる
  const shown = plans.find((p) => p === plan) ?? (security ? plans[0] : undefined);
  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) return;
        loadCandidates(projectId, true, messages.forms.task.repositoriesNoAnswer, setCandidates);
      }}
    >
      <DialogTrigger
        render={
          <Button variant="outline" className="min-h-10 self-start" data-testid="derive-open">
            {t.open}
          </Button>
        }
      />
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
        <form action={formAction} className="flex flex-col gap-4">
          <input type="hidden" name="taskId" value={taskId} />
          <DialogHeader>
            <DialogTitle>{t.dialogTitle}</DialogTitle>
            <DialogDescription className="flex items-center gap-1">
              {t.description}
              <Hint text={t.descriptionHint} className="size-4" />
            </DialogDescription>
          </DialogHeader>
          <CandidatesProblems candidates={candidates} />
          <div className="flex flex-col gap-2">
            <span className="flex items-center gap-1">
              <Label htmlFor="derive-repo">{t.repository}</Label>
              <Hint text={t.repositoryHint} />
            </span>
            <Input
              id="derive-repo"
              name="repo"
              list="derive-repo-options"
              autoComplete="off"
              defaultValue={values?.repo ?? repo}
              placeholder={messages.forms.task.repositoryPlaceholder}
              className="font-mono"
              data-testid="derive-repo"
            />
            <datalist id="derive-repo-options">
              {repositories.map((r) => (
                <option key={r} value={r} />
              ))}
            </datalist>
            <CandidatesStatus candidates={candidates} />
          </div>
          <div className="flex flex-col gap-2">
            <span className="flex items-center gap-1">
              <Label htmlFor="derive-plan">{t.plan}</Label>
              {security && <Hint text={t.securityHint} />}
            </span>
            <select
              id="derive-plan"
              name="plan"
              className={`${SELECT} self-start`}
              value={plan}
              onChange={(e) => setPlan(e.target.value)}
              aria-describedby="derive-plan-note"
              data-testid="derive-plan"
            >
              {!security && <option value="">{t.planAuto}</option>}
              {plans.map((key) => (
                <option key={key} value={key}>
                  {messages.labels.plan[key]}
                </option>
              ))}
            </select>
            <p id="derive-plan-note" className="text-xs leading-5 text-muted-foreground">
              {shown
                ? STEP_PLANS[shown].map((step) => messages.labels.step[step]).join(" → ")
                : messages.forms.task.planAutoNote}
            </p>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="derive-title">{t.titleLabel}</Label>
            <Input
              id="derive-title"
              name="title"
              required
              defaultValue={values?.title}
              data-testid="derive-title"
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="derive-body">{t.body}</Label>
            <Textarea
              id="derive-body"
              name="body"
              rows={6}
              required
              className="max-h-72 overflow-y-auto"
              defaultValue={values?.body}
              placeholder={t.bodyPlaceholder}
              data-testid="derive-body"
            />
          </div>
          {state.message && (
            <p role="alert" className="text-sm text-warn">
              {state.message}
            </p>
          )}
          <DialogFooter>
            <DialogClose render={<Button variant="outline" type="button" />}>{t.close}</DialogClose>
            <Button type="submit" disabled={pending} data-testid="derive-submit">
              {pending ? t.submitting : t.submit}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
