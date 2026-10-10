"use client";

import { useActionState } from "react";
import { type DecideChangeState, decideChangeAction } from "@/app/actions";
import { Button } from "@/components/ui/button";

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
  const [state, formAction, pending] = useActionState(decideChangeAction, initial);
  return (
    <form action={formAction} className="flex flex-col gap-2.5">
      <input type="hidden" name="taskId" value={taskId} />
      <input type="hidden" name="proposalId" value={proposalId} />
      <p className="text-sm leading-6">
        {requirements
          ? "認めると要求要件の承認を取り消し、変更後の要求要件をもう一度承認していただきます。認めなければ、申し出た工程の成果物をそのまま提出します。"
          : "認めると承認済みの設計を置き換えます。認めなければ、承認済みの設計のまま進めます。"}
      </p>
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
          認めない
        </Button>
        <Button
          type="submit"
          name="decision"
          value="accept"
          disabled={pending}
          className="min-h-11 flex-1"
        >
          変更を認める
        </Button>
      </div>
    </form>
  );
}
