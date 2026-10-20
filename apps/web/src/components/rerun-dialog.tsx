"use client";

import { useActionState, useState } from "react";
import { type RerunTaskState, rerunTaskAction } from "@/app/actions";
import { CandidatesProblems, CandidatesStatus } from "@/components/new-task-dialog";
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

const initial: RerunTaskState = {};

/**
 * 中止したタスクを、最初からやり直す（再実行）。題・内容・補足・作業するリポジトリ（空欄ならリポジトリ無し）・イメージを
 * 直して、元のタスクを引き継いだ新しいタスクを作る。リポジトリの候補は、タスクの作成と同じく、開いたときに読む（PBI-109）。
 */
export function RerunDialog({
  taskId,
  projectId,
  title,
  body,
  repo,
  images,
}: {
  taskId: string;
  projectId: string;
  title: string;
  body: string;
  /** 元のタスクの作業したリポジトリ（無ければ空欄）。 */
  repo: string;
  /** 選べるイメージ（既定のイメージと images の名前）。読めなければ無い（いつもどおり決める）。 */
  images?: { name: string; description: string }[];
}) {
  const messages = useMessages();
  const t = messages.parts.rerun;
  const [state, formAction, pending] = useActionState(rerunTaskAction, initial);
  const [candidates, setCandidates] = useState<RepositoryCandidates>({ status: "loading" });
  const [loadCandidates] = useState(() => candidatesLoader());
  const repositories = candidates.status === "loaded" ? candidates.repositories : [];
  const values = state.values;
  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) return;
        loadCandidates(projectId, true, messages.forms.task.repositoriesNoAnswer, setCandidates);
      }}
    >
      <DialogTrigger
        render={
          <Button className="min-h-10 self-start" data-testid="rerun-open">
            {t.open}
          </Button>
        }
      />
      {/* 説明と補足が長くても、見出しと操作へ届くように、ダイアログの中で縦にスクロールする */}
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
        <form action={formAction} className="flex flex-col gap-4">
          <input type="hidden" name="taskId" value={taskId} />
          <DialogHeader>
            <DialogTitle>{t.title}</DialogTitle>
            <DialogDescription className="flex items-center gap-1">
              {t.description}
              <Hint text={t.descriptionHint} className="size-4" />
            </DialogDescription>
          </DialogHeader>
          <CandidatesProblems candidates={candidates} />
          <div className="flex flex-col gap-2">
            <span className="flex items-center gap-1">
              <Label htmlFor="rerun-repo">{t.repository}</Label>
              <Hint text={t.repositoryHint} />
            </span>
            <Input
              id="rerun-repo"
              name="repo"
              list="rerun-repo-options"
              autoComplete="off"
              defaultValue={values?.repo ?? repo}
              placeholder={messages.forms.task.repositoryPlaceholder}
              className="font-mono"
              data-testid="rerun-repo"
            />
            <datalist id="rerun-repo-options">
              {repositories.map((r) => (
                <option key={r} value={r} />
              ))}
            </datalist>
            <CandidatesStatus candidates={candidates} />
          </div>
          <div className="flex flex-col gap-2">
            <span className="flex items-center gap-1">
              <Label htmlFor="rerun-image">{t.image}</Label>
              <Hint text={t.imageHint} />
            </span>
            {images ? (
              <select
                id="rerun-image"
                name="image"
                defaultValue={values?.image ?? ""}
                data-testid="rerun-image"
                className="h-9 max-w-full min-w-0 rounded-md border border-border bg-card px-2 font-mono text-sm"
              >
                <option value="">{t.imageAuto}</option>
                {images.map((o) => (
                  <option key={o.name} value={o.name}>
                    {messages.task.images.option(o.name, o.description)}
                  </option>
                ))}
              </select>
            ) : (
              <p role="status" className="text-xs leading-5 text-muted-foreground">
                {t.imagesUnavailable}
              </p>
            )}
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="rerun-title">{t.titleLabel}</Label>
            <Input
              id="rerun-title"
              name="title"
              required
              defaultValue={values?.title ?? title}
              data-testid="rerun-title"
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="rerun-body">{t.body}</Label>
            <Textarea
              id="rerun-body"
              name="body"
              rows={6}
              className="max-h-72 overflow-y-auto"
              defaultValue={values?.body ?? body}
              data-testid="rerun-body"
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="rerun-note">{t.note}</Label>
            <Textarea
              id="rerun-note"
              name="note"
              rows={4}
              className="max-h-72 overflow-y-auto"
              defaultValue={values?.note}
              placeholder={t.notePlaceholder}
              autoFocus
              data-testid="rerun-note"
            />
          </div>
          {state.message && (
            <p role="alert" className="text-sm text-warn">
              {state.message}
            </p>
          )}
          <DialogFooter>
            <DialogClose render={<Button variant="outline" type="button" />}>{t.close}</DialogClose>
            <Button type="submit" disabled={pending} data-testid="rerun-submit">
              {pending ? t.submitting : t.submit}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
