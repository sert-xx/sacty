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
          <div className="flex flex-col leading-tight">
            <span className="text-[11px] text-muted-foreground">プロジェクト</span>
            <span className="text-sm font-semibold">デフォルト</span>
          </div>
        </header>
        <main className="flex-1 px-4 py-7 sm:px-8">
          <div className="mx-auto flex max-w-6xl flex-col gap-6">{children}</div>
        </main>
      </body>
    </html>
  );
}
