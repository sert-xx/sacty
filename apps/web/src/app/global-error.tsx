"use client";

import { messagesFor } from "@/i18n";

/**
 * レイアウトまで描けなかったとき。自前の html と body を持ち、言語を決められないので、日本語に固定する。
 * 例外の文・パス・スタックは画面に出さない。
 */
export default function GlobalError({ retry }: { error: unknown; retry: () => void }) {
  const t = messagesFor("ja").common.renderError;
  return (
    <html lang="ja">
      <body style={{ fontFamily: "sans-serif", padding: "2rem" }}>
        <div role="alert">
          <h1>{t.title}</h1>
          <p>{t.note}</p>
          <button type="button" onClick={() => retry()}>
            {t.retry}
          </button>
        </div>
      </body>
    </html>
  );
}
