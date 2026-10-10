"use client";

import { useActionState } from "react";
import { type DecideChangeState, decideChangeAction } from "@/app/actions";
import { Button } from "@/components/ui/button";
import { useMessages } from "@/i18n/client";

const initial: DecideChangeState = {};

/** ゴールガーディアンが判定できなかった変更の申し出を、人間が判断するフォーム。 */
export function ChangeDecisionForm({
  taskId,
  proposalId,
  requirements,
}: {
  taskId: string;
  proposalId: string;
  /** 要求要件の変更か（認めると再承認が必要になることを伝える）。 */
  requirements: boolean;
}) {
  const m = useMessages().parts.changeDecision;
  const [state, formAction, pending] = useActionState(decideChangeAction, initial);
  return (
    <form action={formAction} className="flex flex-col gap-2.5">
      <input type="hidden" name="taskId" value={taskId} />
      <input type="hidden" name="proposalId" value={proposalId} />
      <p className="text-sm leading-6">{requirements ? m.requirementsHelp : m.designHelp}</p>
      {state.message && (
        <p role="alert" className="text-sm text-warn">
          {state.message}
        </p>
      )}
      <div className="flex flex-wrap gap-2.5">
        <Button
          type="submit"
          name="decision"
          value="reject"
          variant="outline"
          disabled={pending}
          className="min-h-11 flex-1"
        >
          {m.reject}
        </Button>
        <Button
          type="submit"
          name="decision"
          value="accept"
          disabled={pending}
          className="min-h-11 flex-1"
        >
          {m.accept}
        </Button>
      </div>
    </form>
  );
}
