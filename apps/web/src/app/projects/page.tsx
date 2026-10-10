import Link from "next/link";
import { Suspense } from "react";
import { runIntakeAction } from "@/app/actions";
import { DaemonError } from "@/components/daemon-error";
import { ProjectEditor } from "@/components/project-editor";
import { Button } from "@/components/ui/button";
import { DaemonUnavailableError, getStatus, listProjects } from "@/lib/daemon";
import { formatStamp } from "@/lib/labels";

export default function ProjectsPage() {
  return (
    <>
      <h1 className="text-2xl font-bold">プロジェクト</h1>
      <Suspense fallback={<p className="text-sm text-muted-foreground">読み込み中…</p>}>
        <Projects />
      </Suspense>
      <section aria-labelledby="new-project" className="flex flex-col gap-3">
        <h2 id="new-project" className="text-[15px] font-semibold">
          プロジェクトを作る
        </h2>
        <ProjectEditor />
      </section>
    </>
  );
}

async function Projects() {
  let data: [Awaited<ReturnType<typeof listProjects>>, Awaited<ReturnType<typeof getStatus>>];
  try {
    data = await Promise.all([listProjects(), getStatus()]);
  } catch (error) {
    if (error instanceof DaemonUnavailableError) return <DaemonError message={error.message} />;
    throw error;
  }
  const [projects, status] = data;
  const intake = status.intake;
  return (
    <>
      <section
        aria-labelledby="intake"
        className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card p-5 text-sm"
      >
        <div className="flex flex-col gap-1">
          <h2 id="intake" className="text-[15px] font-semibold">
            GitHub Issue の取り込み
          </h2>
          {!intake ? (
            <p className="text-muted-foreground">
              取り込みは止まっています。config.yaml に github.token_secret
              を設定すると、定期的に取り込みます。
            </p>
          ) : (
            <>
              <p className="text-muted-foreground">
                {intake.lastRunAt
                  ? `最後の取り込み：${formatStamp(intake.lastRunAt)}（${intake.imported ?? 0}件のタスクを作成）`
                  : "まだ取り込んでいません。"}
              </p>
              {intake.errors && intake.errors.length > 0 && (
                <div role="alert" className="flex flex-col gap-1 text-warn">
                  <p>取り込めなかった取り込み元があります（ほかの取り込み元は取り込みました）：</p>
                  <ul className="list-disc pl-5">
                    {intake.errors.map((e) => (
                      <li key={`${e.query ?? ""}:${e.message}`} className="break-words">
                        {e.query && <span className="font-mono text-xs">{e.query}</span>}{" "}
                        {e.message}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}
        </div>
        {intake && (
          <form action={runIntakeAction}>
            <Button type="submit" variant="outline">
              今すぐ取り込む
            </Button>
          </form>
        )}
      </section>
      <ul className="grid grid-cols-[repeat(auto-fit,minmax(260px,1fr))] gap-4">
        {projects.map((p) => (
          <li
            key={p.id}
            className="flex flex-col gap-2 rounded-xl border border-border bg-card p-5"
          >
            <Link href={`/projects/${p.id}`} className="text-[17px] font-semibold hover:underline">
              {p.name}
            </Link>
            <p className="text-sm text-muted-foreground">
              取り込み元 {p.sources.length}件・リポジトリの設定 {p.repositories.length}件
            </p>
            {p.sources.length > 0 && (
              <ul className="flex flex-col gap-0.5 text-xs text-muted-foreground">
                {p.sources.map((s) => (
                  <li key={`${s.scope}:${s.target}`} className="break-all">
                    {s.scope === "org" ? "Org" : "リポジトリ"}：
                    <span className="font-mono">{s.target}</span>（ラベル {s.label}）
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}
