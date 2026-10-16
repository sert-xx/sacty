"use client";

import { useActionState, useId } from "react";
import { type ImportProjectState, importProjectAction } from "@/app/actions";
import { Button } from "@/components/ui/button";
import { Hint } from "@/components/ui/hint";
import { useMessages } from "@/i18n/client";

const initial: ImportProjectState = {};

/** エクスポートしたプロジェクトの定義のファイルを、新しいプロジェクトとしてインポートする。 */
export function ImportProjectForm() {
  const [state, formAction, pending] = useActionState(importProjectAction, initial);
  const id = useId();
  const t = useMessages().forms.import;
  return (
    <form
      action={formAction}
      className="flex flex-col gap-3 rounded-xl border border-border bg-card p-5 text-sm"
    >
      <span className="flex flex-wrap items-center gap-1 leading-6">
        <label htmlFor={id}>{t.label}</label>
        <Hint text={t.hint} />
      </span>
      <input
        id={id}
        name="file"
        type="file"
        accept="application/json,.json"
        className="text-sm file:mr-3 file:rounded-md file:border file:border-input file:bg-card file:px-3 file:py-1.5 file:text-sm"
      />
      {state.message && (
        <p role="alert" className="leading-6 whitespace-pre-line text-warn">
          {state.message}
        </p>
      )}
      <Button type="submit" variant="outline" disabled={pending} className="w-fit">
        {t.submit}
      </Button>
    </form>
  );
}
