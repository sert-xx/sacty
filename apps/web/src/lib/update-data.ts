import { type DaemonStatus, getStatus } from "@/lib/daemon";

/** 新しい版の知らせのデータ（PBI-135）。画面が取り直す。無ければ null。 */
export type UpdateData = { update: NonNullable<DaemonStatus["update"]> | null };

/** デーモンに新しい版があるかを聞く。届かなければ例外（取り直しでは「更新できない」になる）。 */
export async function loadUpdateData(): Promise<UpdateData> {
  return { update: (await getStatus()).update ?? null };
}
