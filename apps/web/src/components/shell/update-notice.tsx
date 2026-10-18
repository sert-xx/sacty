import { getMessages } from "@/i18n/server";
import { type DaemonStatus, getStatus } from "@/lib/daemon";

/** 更新の手順（sacty のリポジトリで実行する）。 */
export const UPDATE_COMMANDS = "git pull origin main\nnpm install\nnpm run build";

/**
 * GitHub の差分のページだけをリンクにする（デーモンの応答をそのまま href にしない）。
 */
export function safeCompareUrl(url: string): string | undefined {
  return /^https:\/\/github\.com\/[^\s"'<>]+$/.test(url) ? url : undefined;
}

/** 新しい版の知らせ（PBI-135）。描画の部分（データの取り方と分ける）。 */
export function UpdateNoticeView({
  update,
  t,
}: {
  update: DaemonStatus["update"];
  t: Awaited<ReturnType<typeof getMessages>>["shell"]["update"];
}) {
  if (!update || update.behindBy <= 0) return null;
  const compareUrl = safeCompareUrl(update.compareUrl);
  return (
    <section
      role="status"
      aria-labelledby="sacty-update"
      className="flex flex-col gap-2 rounded-xl border border-warn-line bg-warn-soft p-4 text-sm leading-6 text-warn"
    >
      <h2 id="sacty-update" className="font-semibold">
        {t.title}
      </h2>
      <p>
        {t.behind(update.behindBy)}
        {compareUrl && (
          <>
            {" "}
            <a href={compareUrl} target="_blank" rel="noreferrer" className="underline">
              {t.compare}
            </a>
          </>
        )}
      </p>
      <p>{t.steps}</p>
      <pre className="overflow-x-auto rounded-md bg-background/60 p-2 font-mono text-xs text-foreground">
        {UPDATE_COMMANDS}
      </pre>
    </section>
  );
}

/** デーモンに新しい版があるか聞き、あれば知らせる。つながらなければ何も出さない。 */
export async function UpdateNotice() {
  const status = await getStatus().catch(() => undefined);
  if (!status?.update) return null;
  return <UpdateNoticeView update={status.update} t={(await getMessages()).shell.update} />;
}
