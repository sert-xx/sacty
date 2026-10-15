"use client";

import { useActionState } from "react";
import { type PrefetchSecretsState, prefetchSecretsAction } from "@/app/actions";
import { Button } from "@/components/ui/button";
import { useMessages } from "@/i18n/client";

const initial: PrefetchSecretsState = {};

/**
 * 秘密情報の取り出し直し（PBI-48）。sacty up の起動のときにまとめて取り出した秘密情報を、取り出し直す
 * （1Password にサインインし直した・参照を直したとき）。値は画面に出さない。
 */
export function SecretsSection() {
  const t = useMessages().settings;
  const [state, action, pending] = useActionState(prefetchSecretsAction, initial);
  return (
    <section
      aria-labelledby="secrets"
      className="flex flex-col gap-3 rounded-xl border border-border bg-card p-5"
    >
      <h2 id="secrets" className="text-[15px] font-semibold">
        {t.secretsTitle}{" "}
        <span className="text-[13px] font-normal text-muted-foreground">{t.secretsNote}</span>
      </h2>
      <p className="text-sm leading-6 whitespace-pre-line text-muted-foreground">{t.secretsHelp}</p>
      <form action={action}>
        <Button type="submit" variant="outline" disabled={pending} className="w-fit">
          {pending ? t.secretsFetching : t.secretsFetch}
        </Button>
      </form>
      {state.message && (
        <p role="alert" className="text-sm text-warn">
          {state.message}
        </p>
      )}
      {state.total !== undefined && (
        <div role="status" className="flex flex-col gap-1 text-sm">
          <p>{t.secretsResult(state.fetched ?? 0, state.total)}</p>
          {(state.problems ?? []).map((problem) => (
            <p key={problem} className="text-warn">
              {problem}
            </p>
          ))}
        </div>
      )}
    </section>
  );
}
