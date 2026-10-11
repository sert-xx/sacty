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
}: {
  projectId: string;
  projectName: string;
  /** 対象リポジトリの候補（プロジェクトのリポジトリの設定。PBI-21）。 */
  repositories: string[];
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
              <select
                id="task-repo"
                name="repo"
                defaultValue={state.values?.repo ?? target.repositories[0]}
                className="h-9 rounded-md border border-input bg-card px-2 font-mono text-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              >
                {target.repositories.map((repo) => (
                  <option key={repo} value={repo}>
                    {repo}
                  </option>
                ))}
              </select>
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
