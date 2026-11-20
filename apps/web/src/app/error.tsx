"use client";

import { Button } from "@/components/ui/button";
import { useMessages } from "@/i18n/client";

/**
 * 描画の途中で例外が起きたとき。例外の文・パス・スタックは画面に出さない。読み直す操作を出す。
 * 言語は、レイアウトの `<Localized>` が決めたものに従う。
 */
export default function ErrorPage({ retry }: { error: unknown; retry: () => void }) {
  const t = useMessages().common.renderError;
  return (
    <div role="alert" className="flex flex-col items-start gap-3">
      <h1 className="text-2xl font-bold">{t.title}</h1>
      <p className="text-sm leading-6 text-muted-foreground">{t.note}</p>
      <Button type="button" variant="outline" onClick={() => retry()}>
        {t.retry}
      </Button>
    </div>
  );
}
