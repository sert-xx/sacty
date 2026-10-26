import type { Metadata } from "next";
// フォントは npm のパッケージから読む（ビルドのときに Google Fonts に取りに行かない。外への通信が制限された
// 環境でもビルドできるように。PBI-39）。使う文字の範囲だけを、ブラウザが必要なときに読む
import "@fontsource/ibm-plex-sans-jp/400.css";
import "@fontsource/ibm-plex-sans-jp/500.css";
import "@fontsource/ibm-plex-sans-jp/600.css";
import "@fontsource/ibm-plex-sans-jp/700.css";
import "@fontsource/ibm-plex-mono/latin-400.css";
import "@fontsource/ibm-plex-mono/latin-500.css";
import { Suspense } from "react";
import { DesktopNotifications } from "@/components/shell/desktop-notifications";
import { DockerNotice } from "@/components/shell/docker-notice";
import { AppHeader, HeaderFallback } from "@/components/shell/header";
import { Localized } from "@/components/shell/localized";
import { ProjectGate, RailGate } from "@/components/shell/project-gate";
import { RailNav } from "@/components/shell/rail";
import { UpdateNotice } from "@/components/shell/update-notice";
import { THEME_SCRIPT } from "@/lib/theme";
import "./globals.css";

export const metadata: Metadata = {
  title: "Sacty",
  description: "AI software factory",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // テーマのクラスは、最初の描画の前にスクリプトで付ける（サーバーの描画と食い違ってよい）
    <html lang="ja" suppressHydrationWarning className="h-full antialiased">
      <head>
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: 固定の文字列で、利用者の入力を含まない */}
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="flex min-h-full flex-col">
        {/* ブラウザのデスクトップ通知（このブラウザで On にしたときだけ。画面には何も描かない） */}
        <DesktopNotifications />
        {/* 画面の言語は cookie とリクエストから決まるので、どこも Suspense の中で決める */}
        <Suspense fallback={<HeaderFallback />}>
          <Localized>
            <AppHeader />
          </Localized>
        </Suspense>
        <div className="flex flex-1">
          {/* 表示中の画面（URL）も、描画のたびに決まるので Suspense の中で読む */}
          <Suspense fallback={<RailNav />}>
            <Localized>
              <RailGate />
            </Localized>
          </Suspense>
          <main className="min-w-0 flex-1 px-4 py-7 sm:px-8">
            <div className="mx-auto flex max-w-6xl flex-col gap-6">
              {/* Docker を使えない・エージェントのイメージが無い（PBI-148）。タスクを実行できないので、どの画面でも中身の上に出す */}
              <Suspense fallback={null}>
                <Localized>
                  <DockerNotice />
                </Localized>
              </Suspense>
              {/* sacty の新しい版（PBI-135）。どの画面でも、中身の上に出す */}
              <Suspense fallback={null}>
                <Localized>
                  <UpdateNotice />
                </Localized>
              </Suspense>
              <Suspense fallback={null}>
                <Localized>
                  <ProjectGate>{children}</ProjectGate>
                </Localized>
              </Suspense>
            </div>
          </main>
        </div>
      </body>
    </html>
  );
}
