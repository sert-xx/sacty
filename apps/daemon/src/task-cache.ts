import { constants } from "node:fs";
import { access, chmod, lstat, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { removeEntry, TASK_CACHE_DIR, taskCachePath } from "./workspace-cleanup.js";

/**
 * タスクごとの依存のキャッシュ（PBI-319）を、実行の前に用意する。用意したディレクトリ（ホストのパス）を返す。
 *
 * - キャッシュの根（`_task-cache`）が無ければ作る。根がディレクトリでない（リンク・ファイル）なら使わない（リンクの先に
 *   書かない。sacty が作った形でないので、消しもしない）
 * - タスクのディレクトリがディレクトリでない（リンク・ファイル）・読み書きできないなら、壊れたものとして消して作り直す
 *   （リンクはリンクだけを消す）。消せなければ（中に消せないものがある）、使わない
 * - どこかで失敗したら、理由を warn に渡して undefined を返す（キャッシュを使わずに実行する。タスクを止めない）
 *
 * 別のタスクのものと分けるため、ディレクトリは持ち主だけが読み書きできるようにする（0700）。
 */
export async function prepareTaskCache(
  workspaceRoot: string,
  taskId: string,
  warn: (line: string) => void = (line) => console.warn(line),
): Promise<string | undefined> {
  const base = join(workspaceRoot, TASK_CACHE_DIR);
  const dir = taskCachePath(workspaceRoot, taskId);
  try {
    await mkdir(base, { recursive: true, mode: 0o700 });
    if (!(await lstat(base)).isDirectory()) {
      throw new Error(`${base} is not a directory (a link is not followed)`);
    }
    if (!(await usable(dir))) {
      // 壊れたもの（リンク・ファイル・読み書きできないディレクトリ）は消して作り直す。無ければ何もしない。
      // 読み書きできないディレクトリは、中を消せるように持ち主の権限を戻してから消す
      const stat = await lstat(dir).catch(() => undefined);
      if (stat?.isDirectory()) await chmod(dir, 0o700).catch(() => {});
      await removeEntry(workspaceRoot, dir);
      await mkdir(dir, { mode: 0o700 });
      if (!(await usable(dir))) throw new Error(`${dir} is not readable and writable`);
    }
    return dir;
  } catch (error) {
    warn(
      `[daemon] 依存のキャッシュを用意できないので、キャッシュを使わずに実行します（${dir}）：${(error as Error).message}`,
    );
    return undefined;
  }
}

/** リンクでないディレクトリで、読み書きできるか。無ければ false。 */
async function usable(dir: string): Promise<boolean> {
  try {
    if (!(await lstat(dir)).isDirectory()) return false;
    await access(dir, constants.R_OK | constants.W_OK | constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * 依存のキャッシュを渡す実行の指示に足す、使い方の案内（PBI-319）。工程・最終レビュー・統合レビューのどれにも、
 * 実行の共通の経路で足す（既定の規則は、最終レビュー・統合レビューには渡らないため）。特定の言語・ツールに寄せない。
 */
export function taskCachePromptLines(): string[] {
  return [
    "## 依存のキャッシュ",
    "環境変数 `XDG_CACHE_HOME` が `/sacty-cache` を指していれば、そこは同じタスクの実行の間で残るキャッシュの場所です（作業領域の外。タスクが終わると消えます）。",
    "- 依存の準備はリポジトリの手順どおりに行い、ツールのキャッシュをそこに置いてください。`XDG_CACHE_HOME` を見ないツールは、そのツールのキャッシュの場所の設定（環境変数・オプション）でその下に向けてください（リポジトリのファイルは変えない）。",
    "- 認証の設定ファイル・秘密の値は置かないでください。",
    "- キャッシュのせいで失敗するように見えたら、使わずに進めてください。",
  ];
}
