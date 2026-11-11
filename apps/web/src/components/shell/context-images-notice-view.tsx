import type { DaemonText } from "@sacty/core";
import type { ShellMessages } from "@/i18n/messages/shell";
import type { ContextImagesView } from "@/lib/daemon";
import { ContextImageRebuildButton } from "./context-image-rebuild-button";

/** ログの末尾として出す行の数。 */
const LOG_LINES = 40;

/** ログの末尾の行。 */
export function logTail(log: string, lines = LOG_LINES): string {
  return log.replace(/\r/g, "\n").split("\n").filter(Boolean).slice(-lines).join("\n");
}

/**
 * コンテキストのイメージ（images.yaml）の作成の状況（PBI-325）の描画。作成中・順番待ち・失敗したものだけを出す（作り終えた
 * ものは出さない）。出すものが無ければ何も出さない。
 */
export function ContextImagesNoticeView({
  projects,
  t,
  text,
}: {
  projects: ContextImagesView[];
  t: ShellMessages["contextImages"];
  text: (value: DaemonText) => string;
}) {
  const shown = projects
    .map((p) => ({ ...p, images: p.images.filter((i) => i.state !== "ready") }))
    .filter((p) => p.images.length > 0);
  if (shown.length === 0) return null;
  const all = shown.flatMap((p) => p.images);
  const building = all.filter((i) => i.state === "building").length;
  const queued = all.filter((i) => i.state === "queued").length;
  const failedCount = all.filter((i) => i.state === "failed").length;
  const failed = failedCount > 0;
  const pending = shown.some((p) => p.images.some((i) => i.state !== "failed"));
  return (
    <section
      aria-labelledby="sacty-context-images"
      className={`flex flex-col gap-3 rounded-xl border p-4 text-sm leading-6 ${
        failed ? "border-warn-line bg-warn-soft text-warn" : "border-border bg-muted"
      }`}
    >
      <h2 id="sacty-context-images" className="font-semibold">
        {t.title}
      </h2>
      {/* 状態の変化だけを読み上げる（5秒ごとに変わるログ・ボタンは、ライブ領域に入れない） */}
      <p role={failed ? "alert" : "status"} className="sr-only">
        {t.summary(building, queued, failedCount)}
      </p>
      {shown.map((project) => (
        <div key={project.projectId} className="flex flex-col gap-2">
          <h3 className="font-medium">{t.project(project.projectName)}</h3>
          <ul className="flex flex-col gap-2">
            {project.images.map((image) => (
              <li key={image.name} className="flex flex-col gap-1 break-words">
                <p>
                  <span className="font-mono">{image.name}</span>
                  {"："}
                  {image.state === "building"
                    ? t.building
                    : image.state === "queued"
                      ? t.queued
                      : t.failed}
                  <span className="text-muted-foreground">
                    {" "}
                    （{image.description}・{t.from(image.from)}）
                  </span>
                </p>
                {image.error && <p>{text(image.error)}</p>}
                {image.log && (
                  <details open={image.state === "building"}>
                    <summary className="cursor-pointer">{t.log}</summary>
                    <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-background/60 p-2 font-mono text-xs text-foreground">
                      {logTail(image.log)}
                    </pre>
                  </details>
                )}
                {image.state === "failed" && (
                  <ContextImageRebuildButton projectId={project.projectId} name={image.name} />
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}
      {pending && <p>{t.waiting}</p>}
      {failed && <p>{t.fix}</p>}
    </section>
  );
}
