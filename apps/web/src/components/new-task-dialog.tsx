"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useMessages } from "@/i18n/client";

const initial: CreateTaskState = {};

/**
 * タスクの作成。作成先は、この画面を表示したときのプロジェクトに固定する
 * （入力中に別のタブでプロジェクトを切り替えても、表示していたプロジェクトに作るため）。
 */
export function NewTaskDialog({
  projectId,
  projectName,
  repositories,
  problems = [],
}: {
  projectId: string;
  projectName: string;
  /** 対象リポジトリの候補（プロジェクトの対象から。Org の対象は gh で読んだもの。PBI-25）。 */
  repositories: string[];
  /** 候補を読めなかった Org と、その理由。 */
  problems?: string[];
}) {
  const [state, formAction, pending] = useActionState(createTaskAction, initial);
  const t = useMessages().forms.task;
  // 作成先は、ダイアログを開いたときのプロジェクトに固定し、閉じるまで変えない
  // （入力中に画面が自動で更新され、別のタブで切り替えたプロジェクトが props で渡されても、
  // 書いている途中のタスクの作成先は変えないため）
  const [target, setTarget] = useState({ id: projectId, name: projectName, repositories });

  return (
    <Dialog
      onOpenChange={(open) => {
        if (open) setTarget({ id: projectId, name: projectName, repositories });
      }}
    >
      <DialogTrigger render={<Button size="lg" />}>{t.create}</DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <form action={formAction} className="flex flex-col gap-4">
          <input type="hidden" name="projectId" value={target.id} />
          <DialogHeader>
            <DialogTitle>{t.create}</DialogTitle>
            <DialogDescription>{t.description(target.name)}</DialogDescription>
          </DialogHeader>
          {problems.length > 0 && (
            <ul role="alert" className="flex flex-col gap-1 text-sm text-warn">
              {problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          )}
          {target.repositories.length === 0 ? (
            <p role="alert" className="text-sm text-warn">
              {t.noRepository}{" "}
              <Link href={`/projects/${target.id}`} className="underline">
                {t.projectSettings}
              </Link>
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              <Label htmlFor="task-repo">{t.repository}</Label>
              {/* Org の対象ではリポジトリが多いので、入力して絞り込めるようにする */}
              <Input
                id="task-repo"
                name="repo"
                list="task-repo-options"
                required
                autoComplete="off"
                defaultValue={
                  state.values?.repo ??
                  (target.repositories.length === 1 ? target.repositories[0] : "")
                }
                placeholder={t.repositoryPlaceholder}
                className="font-mono"
              />
              <datalist id="task-repo-options">
                {target.repositories.map((repo) => (
                  <option key={repo} value={repo} />
                ))}
              </datalist>
            </div>
          )}
          <div className="flex flex-col gap-2">
            <Label htmlFor="task-title">{t.title}</Label>
            <Input
              id="task-title"
              name="title"
              defaultValue={state.values?.title}
              aria-invalid={Boolean(state.fieldErrors?.title)}
              aria-describedby={state.fieldErrors?.title ? "task-title-error" : undefined}
              autoFocus
            />
            {state.fieldErrors?.title && (
              <p id="task-title-error" className="text-sm text-warn">
                {state.fieldErrors.title[0]}
              </p>
            )}
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="task-body">{t.body}</Label>
            <Textarea
              id="task-body"
              name="body"
              rows={6}
              className="max-h-72 overflow-y-auto"
              defaultValue={state.values?.body}
              placeholder={t.bodyPlaceholder}
              aria-invalid={Boolean(state.fieldErrors?.body)}
              aria-describedby={state.fieldErrors?.body ? "task-body-error" : undefined}
            />
            {state.fieldErrors?.body && (
              <p id="task-body-error" className="text-sm text-warn">
                {state.fieldErrors.body[0]}
              </p>
            )}
          </div>
          {state.message && (
            <p role="alert" className="text-sm text-warn">
              {state.message}
            </p>
          )}
          <DialogFooter>
            <DialogClose render={<Button variant="outline" type="button" />}>{t.close}</DialogClose>
            <Button type="submit" disabled={pending || target.repositories.length === 0}>
              {pending ? t.creating : t.submit}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
