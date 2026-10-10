import type { Metadata } from "next";
import { IBM_Plex_Mono, IBM_Plex_Sans_JP } from "next/font/google";
import Link from "next/link";
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
    <html lang="ja" className={`${plexSans.variable} ${plexMono.variable} h-full antialiased`}>
      <body className="flex min-h-full flex-col">
        <header className="sticky top-0 z-30 flex h-16 items-center gap-4 border-b border-border bg-chrome px-5">
          <Link href="/" className="text-xl font-bold tracking-wide text-foreground">
            sacty
          </Link>
          <span aria-hidden="true" className="h-7 w-px bg-border" />
          {/* プロジェクトの切り替えはPBI-4。ここではプロジェクトの設定への入口だけを置く */}
          <nav aria-label="メイン" className="flex items-center gap-4 text-sm">
            <Link href="/" className="font-medium text-foreground hover:underline">
              タスク
            </Link>
            <Link href="/projects" className="font-medium text-foreground hover:underline">
              プロジェクト
            </Link>
          </nav>
        </header>
        <main className="flex-1 px-4 py-7 sm:px-8">
          <div className="mx-auto flex max-w-6xl flex-col gap-6">{children}</div>
        </main>
      </body>
    </html>
  );
}
