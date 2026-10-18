import { loadUpdateData } from "@/lib/update-data";
import { UpdateNoticeLive } from "./update-notice-live";

/**
 * sacty の新しい版の知らせ（PBI-135）。描いたときの状態から始め、画面の中で取り直す。デーモンにつながらなければ、
 * 知らせの無い状態から始める（届いてから現れる）。
 */
export async function UpdateNotice() {
  const initial = await loadUpdateData().catch(() => ({ update: null }));
  return <UpdateNoticeLive initial={initial} />;
}
