import type { ShellMessages } from "@/i18n/messages/shell";
import type { DaemonStatus } from "@/lib/daemon";

/**
 * 更新の手順（sacty のリポジトリで実行する）。動いている sacty up を止めてから実行する（npm run build が画面の .next を
 * 消して作り直すので、動いている画面が壊れないように。PR #147 レビュー提案）。既定のイメージの名前は版に連れて変わるので、
 * イメージも作り直す（PBI-147）。
 */
export const UPDATE_COMMANDS =
  "git pull origin main\nnpm ci\nnpm run build\nnpx sacty image build\nnpx sacty up";

/** GitHub のページだけをリンクにする（デーモンの応答をそのまま href にしない）。 */
export function safeGitHubUrl(url: string): string | undefined {
  return /^https:\/\/github\.com\/[^\s"'<>]+$/.test(url) ? url : undefined;
}

/** 新しい版の知らせ（PBI-135・PBI-147）の描画。新しい版が無ければ何も出さない。 */
export function UpdateNoticeView({
  update,
  t,
}: {
  update: DaemonStatus["update"];
  t: ShellMessages["update"];
}) {
  if (!update) return null;
  const releaseUrl = safeGitHubUrl(update.releaseUrl);
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
        {t.newer(update.latest, update.current)}
        {releaseUrl && (
          <>
            {" "}
            <a href={releaseUrl} target="_blank" rel="noreferrer" className="underline">
              {t.release}
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
