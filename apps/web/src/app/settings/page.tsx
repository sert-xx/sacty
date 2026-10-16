import { Suspense } from "react";
import { DaemonError } from "@/components/daemon-error";
import { SecretsSection } from "@/components/secrets-section";
import { SettingsForm } from "@/components/settings-form";
import { Hint } from "@/components/ui/hint";
import { getMessages } from "@/i18n/server";
import { DaemonUnavailableError, getSettings, getStatus } from "@/lib/daemon";
import { notificationProblems } from "@/lib/notification-problems";

/** sacty 全体の設定（プロジェクトとは別。PBI-26）。 */
export default async function SettingsPage() {
  const t = (await getMessages()).settings;
  return (
    <>
      <h1 className="flex items-center gap-2 text-2xl font-bold">
        {t.title}
        <Hint text={t.hint} />
      </h1>
      <Suspense fallback={<p className="text-sm text-muted-foreground">{t.loading}</p>}>
        <Settings />
      </Suspense>
      {/* 秘密情報の取り出し直し（PBI-48） */}
      <SecretsSection />
    </>
  );
}

async function Settings() {
  let settings: Awaited<ReturnType<typeof getSettings>>;
  let status: Awaited<ReturnType<typeof getStatus>>;
  try {
    [settings, status] = await Promise.all([getSettings(), getStatus()]);
  } catch (error) {
    if (error instanceof DaemonUnavailableError) return <DaemonError message={error.message} />;
    throw error;
  }
  const { labels } = await getMessages();
  return (
    <SettingsForm
      intakeLabel={settings.intakeLabel ?? ""}
      reviewLabel={settings.reviewLabel ?? ""}
      reviewRequested={settings.reviewRequested === true}
      triageOff={settings.triageOff ?? []}
      ticketLabel={settings.ticketLabel ?? ""}
      maxParallelTasks={settings.maxParallelTasks}
      issueIntervalSec={settings.issueIntervalSec}
      reviewIntervalSec={settings.reviewIntervalSec}
      ticketIntervalSec={settings.ticketIntervalSec}
      notification={settings.notification}
      notificationProblems={notificationProblems(status.warnings, labels.text)}
    />
  );
}
