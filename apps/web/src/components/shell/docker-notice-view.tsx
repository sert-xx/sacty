import type { DaemonText } from "@sacty/core";
import type { ShellMessages } from "@/i18n/messages/shell";

/** Docker とエージェントのイメージの注意（PBI-148）の描画。注意が無ければ何も出さない。 */
export function DockerNoticeView({
  problems,
  t,
  text,
}: {
  problems: DaemonText[];
  t: ShellMessages["docker"];
  text: (value: DaemonText) => string;
}) {
  if (problems.length === 0) return null;
  return (
    <section
      role="alert"
      aria-labelledby="sacty-docker"
      className="flex flex-col gap-2 rounded-xl border border-warn-line bg-warn-soft p-4 text-sm leading-6 text-warn"
    >
      <h2 id="sacty-docker" className="font-semibold">
        {t.title}
      </h2>
      <ul className="flex flex-col gap-1">
        {problems.map((p) => (
          <li key={text(p)} className="break-words">
            {text(p)}
          </li>
        ))}
      </ul>
      <p>{t.recheck}</p>
    </section>
  );
}
