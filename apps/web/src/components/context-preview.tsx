"use client";

import { useState, useTransition } from "react";
import { previewContextAction } from "@/app/actions";
import { Button } from "@/components/ui/button";
import { Hint } from "@/components/ui/hint";
import { useMessages } from "@/i18n/client";
import type { ContextPreview, ContextPreviewResult, PreviewRuntime } from "@/lib/daemon";

const RUNTIMES: { value: PreviewRuntime; label: string }[] = [
  { value: "claude-code", label: "Claude Code" },
  { value: "codex", label: "Codex" },
];

/**
 * プロジェクトのコンテキストの合成の結果のプレビュー（PBI-76）。保存した設定か、編集中の設定（definition）で作り、
 * AI の種類を切り替えて見られる（切り替えると、同じ設定で作り直す）。
 */
export function ContextPreviewPanel({
  projectId,
  definition,
}: {
  projectId: string;
  /** 編集中の設定（編集画面が JSON にまとめたもの）。 */
  definition: string;
}) {
  const messages = useMessages();
  const t = messages.projects.preview;
  const [runtime, setRuntime] = useState<PreviewRuntime>("claude-code");
  // 最後に作ったときの設定（保存したものか、編集中のものか）。AI の種類を切り替えたら、同じ設定で作り直す
  const [source, setSource] = useState<{ editing: boolean; definition: string } | undefined>();
  const [result, setResult] = useState<ContextPreviewResult | undefined>();
  const [pending, startTransition] = useTransition();
  const run = (next: { editing: boolean; definition: string }, nextRuntime: PreviewRuntime) => {
    setSource(next);
    startTransition(async () => {
      setResult(
        await previewContextAction(projectId, nextRuntime, next.editing ? next.definition : ""),
      );
    });
  };

  return (
    <section
      aria-labelledby="context-preview"
      className="flex flex-col gap-3 rounded-xl border border-border bg-card p-5"
    >
      <h2 id="context-preview" className="text-[15px] font-semibold">
        {t.title} <Hint text={t.hint} />
      </h2>
      <p className="flex items-center gap-1 text-sm leading-6 text-warn">
        {t.secretsNote}
        <Hint text={t.secretsHint} />
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <fieldset className="flex items-center gap-1 rounded-md border border-input p-0.5">
          <legend className="sr-only">{t.runtime}</legend>
          {RUNTIMES.map((r) => (
            <label
              key={r.value}
              className={`cursor-pointer rounded px-3 py-1 text-sm ${
                runtime === r.value ? "bg-muted font-semibold" : "text-muted-foreground"
              }`}
            >
              <input
                type="radio"
                name={`${projectId}-preview-runtime`}
                value={r.value}
                checked={runtime === r.value}
                // 合成しているあいだは切り替えない（後から返った結果で、ほかの AI の結果を上書きしないため）
                disabled={pending}
                className="sr-only"
                onChange={() => {
                  setRuntime(r.value);
                  if (source) run(source, r.value);
                }}
              />
              {r.label}
            </label>
          ))}
        </fieldset>
        <Button
          type="button"
          variant="outline"
          disabled={pending}
          onClick={() => run({ editing: false, definition: "" }, runtime)}
        >
          {t.saved}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={pending}
          onClick={() => run({ editing: true, definition }, runtime)}
        >
          {t.editing}
        </Button>
      </div>
      {pending && (
        <p role="status" className="text-sm text-muted-foreground">
          {t.loading}
        </p>
      )}
      {!pending && result && source && (
        <div className="flex flex-col gap-3" data-testid="context-preview-result">
          <p className="text-xs text-muted-foreground">
            {source.editing ? t.fromEditing : t.fromSaved}
          </p>
          {!result.ok ? (
            <p role="alert" className="text-sm text-warn">
              {result.message}
            </p>
          ) : "error" in result ? (
            <p role="alert" className="text-sm whitespace-pre-line text-warn">
              {t.error} {messages.labels.text(result.error)}
            </p>
          ) : (
            <PreviewBody preview={result.preview} />
          )}
        </div>
      )}
    </section>
  );
}

function PreviewBody({ preview }: { preview: ContextPreview }) {
  const messages = useMessages();
  const t = messages.projects.preview;
  const heading = "text-sm font-semibold";
  const mono = "font-mono text-xs break-all";
  const headerValue = (v: string | { secret: string; prefix: string }) =>
    typeof v === "string" ? v : `${v.prefix}<${t.secretRef(v.secret)}>`;
  return (
    <>
      {preview.warnings.length > 0 && (
        <div className="flex flex-col gap-1">
          <h3 className={heading}>{t.warnings}</h3>
          <ul className="flex flex-col gap-1">
            {preview.warnings.map((w, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: 警告は並びのまま出す
              <li key={i} className="text-sm text-warn">
                {messages.labels.text(w)}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex flex-col gap-1">
        <h3 className={heading}>{t.layers}</h3>
        <ol className="flex flex-col gap-1.5">
          {preview.layers.map((l) => {
            const named = (r: Record<string, string[]>) =>
              (Object.keys(t.kind) as (keyof typeof t.kind)[])
                .filter((k) => (r[k] ?? []).length > 0)
                .map((k) => `${t.kind[k]}: ${(r[k] ?? []).join(", ")}`)
                .join(" / ");
            const locked = named(l.locked);
            const remove = named(l.remove);
            return (
              <li key={`${l.repo}#${l.ref ?? ""}`} className="rounded-lg border border-border p-2">
                <div className={mono}>
                  {l.repo}
                  {l.ref ? `#${l.ref}` : ""} @ {l.commit}
                </div>
                {locked && (
                  <div className="text-xs text-muted-foreground">
                    {t.locked}: {locked}
                  </div>
                )}
                {remove && (
                  <div className="text-xs text-muted-foreground">
                    {t.remove}: {remove}
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      </div>

      {preview.effects.length > 0 && (
        <div className="flex flex-col gap-1">
          <h3 className={heading}>{t.effects}</h3>
          <ul className="list-disc pl-5 text-sm">
            {preview.effects.map((e) => (
              <li key={`${e.effect}-${e.kind}-${e.name}-${e.by}`}>
                {e.effect === "removed"
                  ? t.removed(t.kind[e.kind], e.name, e.by, e.of)
                  : t.lockedBy(t.kind[e.kind], e.name, e.by, e.of)}
              </li>
            ))}
          </ul>
        </div>
      )}

      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
        <dt className="text-muted-foreground">{t.rules}</dt>
        <dd className={mono}>{preview.rules.join(" → ") || t.none}</dd>
        <dt className="text-muted-foreground">{t.agentSettings}</dt>
        <dd className={mono}>{preview.agentSettings.join(" → ") || t.none}</dd>
        <dt className="text-muted-foreground">{t.skills}</dt>
        <dd className="text-xs">
          {preview.skills.length === 0
            ? t.none
            : preview.skills.map((s) => (
                <div key={s.name}>
                  <span className="font-mono font-semibold">{s.name}</span>{" "}
                  <span className="text-muted-foreground">{s.from}</span>
                </div>
              ))}
        </dd>
        <dt className="text-muted-foreground">{t.platforms}</dt>
        <dd className="text-xs">
          {preview.platforms.length === 0
            ? t.none
            : preview.platforms.map((p) => (
                <div key={p.name}>
                  <span className="font-mono font-semibold">{p.name}</span>{" "}
                  <span className="text-muted-foreground">{p.from ?? t.platformHost}</span>
                </div>
              ))}
        </dd>
      </dl>

      <div className="flex flex-col gap-1">
        <h3 className={heading}>{t.mcp}</h3>
        {preview.mcp.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t.none}</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {preview.mcp.map((m) => {
              const timeouts = t.timeouts(m.startup_timeout_sec, m.tool_timeout_sec);
              return (
                <li
                  key={m.name}
                  className="flex flex-col gap-0.5 rounded-lg border border-border p-2 text-xs"
                >
                  <div>
                    <span className="font-mono font-semibold">{m.name}</span>{" "}
                    <span className="text-muted-foreground">{m.from}</span>
                    {timeouts && <span className="text-muted-foreground">（{timeouts}）</span>}
                  </div>
                  <div>
                    <span className="text-muted-foreground">{t.mcpAgent}: </span>
                    <span className={mono}>
                      {"url" in m.agent
                        ? m.agent.url
                        : [m.agent.command, ...m.agent.args].join(" ")}
                    </span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">{t.mcpOrigin}: </span>
                    {m.origin.kind === "host" ? (
                      t.mcpHost
                    ) : m.origin.kind === "gateway" ? (
                      <span className={mono}>{t.mcpGateway(m.origin.url)}</span>
                    ) : m.origin.kind === "hostCommand" ? (
                      <span className={mono}>
                        {t.mcpHostCommand([m.origin.command, ...m.origin.args].join(" "))}
                      </span>
                    ) : (
                      t.mcpDirect
                    )}
                  </div>
                  {m.origin.kind === "hostCommand" && (
                    <div className="text-muted-foreground">{t.mcpHostCwd(m.origin.cwd)}</div>
                  )}
                  {m.origin.kind === "hostCommand" && Object.keys(m.origin.env).length > 0 && (
                    <div>
                      <span className="text-muted-foreground">{t.mcpHostEnv}: </span>
                      <span className={mono}>
                        {Object.entries(m.origin.env)
                          .map(([k, v]) => `${k}=${headerValue(v)}`)
                          .join(" / ")}
                      </span>
                    </div>
                  )}
                  {m.origin.kind === "gateway" && Object.keys(m.origin.headers).length > 0 && (
                    <div>
                      <span className="text-muted-foreground">{t.mcpHeaders}: </span>
                      <span className={mono}>
                        {Object.entries(m.origin.headers)
                          .map(([k, v]) => `${k}: ${headerValue(v)}`)
                          .join(" / ")}
                      </span>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="flex flex-col gap-1">
        <h3 className={heading}>{t.env}</h3>
        {preview.secrets.length === 0 && Object.keys(preview.env).length === 0 ? (
          <p className="text-sm text-muted-foreground">{t.none}</p>
        ) : (
          <ul className={`flex flex-col gap-0.5 ${mono}`}>
            {preview.secrets.map((s) => (
              <li key={s.env}>
                {s.env} = {s.prefix}&lt;{s.gatewayToken ? t.gatewayToken : t.secretRef(s.secret)}
                &gt;
              </li>
            ))}
            {Object.entries(preview.env).map(([k, v]) => (
              <li key={k}>
                {k} = {v}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="flex flex-col gap-1">
        <h3 className={heading}>{t.files(preview.files.length)}</h3>
        <ul className="flex flex-col gap-1">
          {preview.files.map((f) => (
            <li key={f.path}>
              <details className="rounded-lg border border-border">
                <summary className="cursor-pointer px-2 py-1 text-xs">
                  <span className="font-mono font-semibold">{f.path}</span>{" "}
                  <span className="text-muted-foreground">
                    {f.from ?? t.generated}・{t.size(f.size)}
                  </span>
                </summary>
                {f.binary || f.omitted ? (
                  <p className="px-2 pb-2 text-xs text-muted-foreground">
                    {f.binary ? t.binary : t.omitted}
                  </p>
                ) : (
                  <>
                    {f.truncated && <p className="px-2 text-xs text-warn">{t.truncated}</p>}
                    <pre className="max-h-96 overflow-auto border-t border-border bg-muted/40 p-2 font-mono text-xs whitespace-pre-wrap break-all">
                      {f.content}
                    </pre>
                  </>
                )}
              </details>
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}
