import { Suspense } from "react";
import { DaemonError } from "@/components/daemon-error";
import { SecretsSection } from "@/components/secrets-section";
import { SettingsForm } from "@/components/settings-form";
import { getMessages } from "@/i18n/server";
import { DaemonUnavailableError, getSettings } from "@/lib/daemon";

/** sacty 全体の設定（プロジェクトとは別。PBI-26）。 */
export default async function SettingsPage() {
  const t = (await getMessages()).settings;
  return (
    <>
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-bold">{t.title}</h1>
        <p className="text-sm leading-6 text-muted-foreground whitespace-pre-line">{t.note}</p>
      </div>
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
  try {
    settings = await getSettings();
  } catch (error) {
    if (error instanceof DaemonUnavailableError) return <DaemonError message={error.message} />;
    throw error;
  }
  return (
    <SettingsForm
      intakeLabel={settings.intakeLabel ?? ""}
      reviewLabel={settings.reviewLabel ?? ""}
      reviewRequested={settings.reviewRequested === true}
      triageOff={settings.triageOff ?? []}
      ticketLabel={settings.ticketLabel ?? ""}
      maxParallelTasks={settings.maxParallelTasks}
    />
  );
}
