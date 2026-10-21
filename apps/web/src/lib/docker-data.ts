import type { DaemonText } from "@sacty/core";
import { getStatus } from "@/lib/daemon";

/** Docker とエージェントのイメージの注意のデータ（PBI-148）。画面が取り直す。無ければ空。 */
export type DockerData = { docker: DaemonText[] };

/** デーモンに Docker とイメージの注意を聞く。届かなければ例外（取り直しでは「更新できない」になる）。 */
export async function loadDockerData(): Promise<DockerData> {
  return { docker: (await getStatus()).docker ?? [] };
}
