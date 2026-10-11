import type { Metadata } from "next";
import { IBM_Plex_Mono, IBM_Plex_Sans_JP } from "next/font/google";
import { Suspense } from "react";
import { AppHeader, HeaderFallback } from "@/components/shell/header";
import { Localized } from "@/components/shell/localized";
import { ProjectGate, RailGate } from "@/components/shell/project-gate";
import { RailNav } from "@/components/shell/rail";
import { THEME_SCRIPT } from "@/lib/theme";
import "./globals.css";

const plexSans = IBM_Plex_Sans_JP({
  variable: "--font-plex-sans",
  weight: ["400", "500", "600", "700"],
  preload: false,
});

const plexMono = IBM_Plex_Mono({
  variable: "--font-plex-mono",
  weight: ["400", "500"],
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "sacty",
  description: "AI software factory",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // テーマのクラスは、最初の描画の前にスクリプトで付ける（サーバーの描画と食い違ってよい）
    <html
      lang="ja"
      suppressHydrationWarning
      className={`${plexSans.variable} ${plexMono.variable} h-full antialiased`}
    >
      <head>
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: 固定の文字列で、利用者の入力を含まない */}
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="flex min-h-full flex-col">
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
