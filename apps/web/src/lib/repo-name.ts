import { parseRepoUrl, type Task } from "@sacty/core";

/**
 * タスクの作業するリポジトリの名前（PBI-141）。画面で選んだ・決めたリポジトリ（分割の子タスク・チケット・リポジトリを指定せずに
 * 作ったタスクで決めたものを含む）、無ければ Issue・PR の取り込み元、無ければ準備したリポジトリ。
 */
export function repoNameOf(task: Task): { repoName?: string } {
  const url = task.repo ?? task.source?.repo ?? task.repository?.url;
  const name = url ? parseRepoUrl(url)?.name : undefined;
  return name ? { repoName: name } : {};
}
