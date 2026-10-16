import { Suspense } from "react";
import { LiveDashboard } from "@/components/dashboard";
import { getMessages } from "@/i18n/server";
import { DaemonUnavailableError } from "@/lib/daemon";
import { loadDashboard } from "@/lib/dashboard-data";
import { liveVersion } from "@/lib/live-server";

/** ダッシュボード（PBI-114）。すべてのプロジェクトをまたいで、動きを1か所で見る。 */
export default async function DashboardPage() {
  const m = (await getMessages()).dashboard;
  return (
    <>
      <h1 className="text-2xl font-bold">{m.title}</h1>
      <Suspense fallback={<p className="text-sm text-muted-foreground">{m.loading}</p>}>
        <Dashboard />
      </Suspense>
    </>
  );
}

/** 描いたときのデータ（画面が取り直す。PBI-108）。 */
async function Dashboard() {
  try {
    const data = await loadDashboard();
    return <LiveDashboard initial={data} initialVersion={liveVersion(data)} />;
  } catch (error) {
    if (error instanceof DaemonUnavailableError) {
      return <LiveDashboard initial={null} error={error.message} />;
    }
    throw error;
  }
}
