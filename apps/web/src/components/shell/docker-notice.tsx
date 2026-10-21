import { loadDockerData } from "@/lib/docker-data";
import { DockerNoticeLive } from "./docker-notice-live";

/**
 * Docker とエージェントのイメージの注意（PBI-148）。描いたときの状態から始め、画面の中で取り直す。デーモンにつながらなければ、
 * 注意の無い状態から始める（デーモンにつながらないことは、それぞれの画面が知らせる）。
 */
export async function DockerNotice() {
  const initial = await loadDockerData().catch(() => ({ docker: [] }));
  return <DockerNoticeLive initial={initial} />;
}
