import { type ProjectTarget, targetHost } from "@sacty/core";

/** gh にログイン済みのアカウント。 */
type Account = { host: string; login: string; active: boolean };

/**
 * プロジェクトの設定で、GitHub のアカウントを選ぶホストと、保存するアカウント（PBI-40）。
 * - 対象のホストは必ず選ぶ（required）
 * - コンテキストリポジトリ・共用の compose のリポジトリ（HTTPS。PBI-70）のホストと、保存済みのホスト（対象から外れても
 *   消さない）も選べる
 * - まだ選んでいなければ、そのホストの gh のアクティブなアカウントを選んでおく。chosen の空は「選ばない」
 */
export function githubAccountChoices(input: {
  targets: readonly ProjectTarget[];
  contextRepo: string;
  /** 共用の compose のリポジトリ（PBI-70）。 */
  sharedRepos?: readonly string[];
  chosen: Record<string, string>;
  accounts: readonly Account[];
}): {
  hosts: { host: string; required: boolean; forContext: boolean; forShared: boolean }[];
  githubAccounts: Record<string, string>;
  /** 対象のホストで、アカウントを選んでいないものがある。 */
  missing: boolean;
} {
  const targetHosts = new Set(input.targets.map(targetHost).filter(Boolean));
  const hostOf = (repo: string) =>
    repo
      .trim()
      .match(/^https:\/\/([^/@]+)\//i)?.[1]
      ?.toLowerCase();
  const contextHost = hostOf(input.contextRepo);
  const sharedHosts = new Set(
    (input.sharedRepos ?? []).map(hostOf).filter((h): h is string => Boolean(h)),
  );
  const hosts = [
    ...new Set([
      ...targetHosts,
      ...(contextHost ? [contextHost] : []),
      ...sharedHosts,
      ...Object.keys(input.chosen),
    ]),
  ];
  const githubAccounts = Object.fromEntries(
    hosts.flatMap((host) => {
      const login =
        input.chosen[host] ?? input.accounts.find((a) => a.host === host && a.active)?.login;
      return login ? [[host, login]] : [];
    }),
  );
  return {
    hosts: hosts.map((host) => ({
      host,
      required: targetHosts.has(host),
      forContext: host === contextHost,
      forShared: sharedHosts.has(host),
    })),
    githubAccounts,
    missing: [...targetHosts].some((host) => !githubAccounts[host]),
  };
}
