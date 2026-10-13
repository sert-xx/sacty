import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { code, type DaemonMessage, message } from "@sacty/core";
import { z } from "zod";
import { MessageError } from "./errors.js";

const run = promisify(execFile);

/** sactyがキーチェーンに保存するときのサービス名。 */
export const KEYCHAIN_SERVICE = "sacty";

/**
 * 1Password の秘密情報の参照（op://保管庫/アイテム/[セクション/]フィールド[?attribute=…]。PBI-34）。
 * 1Password の仕様に合わせ、各要素は英数字・ハイフン・アンダースコア・ピリオド・空白（空白だけは不可）。
 * それ以外の文字を含む名前は、1Password の ID で書く（https://www.1password.dev/cli/secret-reference-syntax）。
 */
const SEGMENT = "(?=[^/?]*[A-Za-z0-9._-])[A-Za-z0-9._ -]+";
const QUERY = "[A-Za-z-]+=[A-Za-z0-9-]+";
const ONE_PASSWORD_REF = new RegExp(
  `^op://${SEGMENT}/${SEGMENT}(/${SEGMENT})?/${SEGMENT}(\\?${QUERY}(&${QUERY})*)?$`,
);

/** 1Password の参照か。 */
export function isOnePasswordRef(ref: string): boolean {
  return ONE_PASSWORD_REF.test(ref);
}

/**
 * 設定に書く秘密情報。キーチェーンの名前（`sacty secret set` で保存したもの）か、1Password の参照（PBI-34）。
 * 値は書かない。
 */
export const SecretRef = z
  .string()
  .refine((v) => /^[A-Za-z0-9._-]+$/.test(v) || isOnePasswordRef(v), code("input.secretRef"));

/** 秘密情報を取り出せなかった（見つからない、取得元に届かない）。理由は文言のコードと引数で持つ。 */
export class SecretNotFoundError extends MessageError {
  constructor(
    readonly secretName: string,
    text: DaemonMessage = message("run.secretNotFound", { name: secretName }),
  ) {
    super(text);
  }
}

/** 秘密情報の取り出し口。値は作業履歴・ログ・画面に出さない。 */
export interface SecretStore {
  get(name: string): Promise<string>;
}

/** macOSのキーチェーンから取り出す。 */
export class KeychainSecretStore implements SecretStore {
  async get(name: string): Promise<string> {
    try {
      const { stdout } = await run("security", [
        "find-generic-password",
        "-s",
        KEYCHAIN_SERVICE,
        "-a",
        name,
        "-w",
      ]);
      const value = stdout.replace(/\n$/, "");
      if (!value) throw new SecretNotFoundError(name);
      return value;
    } catch (error) {
      if (error instanceof SecretNotFoundError) throw error;
      throw new SecretNotFoundError(name);
    }
  }
}

/** op コマンドの実行（終了コード・標準出力・標準エラー。コマンドが無ければ ENOENT の例外）。 */
export type OpRunner = (
  args: string[],
) => Promise<{ code: number; stdout: string; stderr: string }>;

const OP_TIMEOUT_MS = 120_000;

/** op コマンドを実行する。Touch ID などの確認を待てるよう、時間の上限は長めにする。 */
const runOp: OpRunner = (args) =>
  new Promise((resolve, reject) => {
    execFile(
      "op",
      args,
      { timeout: OP_TIMEOUT_MS, maxBuffer: 1024 * 1024, env: process.env },
      (error, stdout, stderr) => {
        if (error && (error as NodeJS.ErrnoException).code === "ENOENT") return reject(error);
        const exit = error ? (typeof error.code === "number" ? error.code : 1) : 0;
        resolve({ code: exit, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });

/**
 * 1Password から取り出す（op CLI。PBI-34）。取り出した値は、デーモンが動いている間だけメモリーに持ち、
 * 同じ参照で何度も 1Password に問い合わせない（ディスクには書かない）。同時の問い合わせも1回にまとめる。
 * 取り出せなかった参照は持たない（サインインし直せば、次は取り出せる）。
 */
export class OnePasswordSecretStore implements SecretStore {
  private readonly cache = new Map<string, Promise<string>>();

  constructor(
    private readonly options: {
      /** 使う 1Password のアカウント（複数のアカウントにサインインしているとき）。呼ぶたびに設定から読む。 */
      account?: () => string | undefined;
      run?: OpRunner;
    } = {},
  ) {}

  /**
   * 参照をまとめて取り出し、メモリーに持つ（sacty up の起動時。PBI-48）。1回の op run ですべての参照を環境変数として
   * 子のプロセスに渡し、子が JSON で返す（認証を1回にする。値はコマンドラインにもファイルにも出さない）。
   * まとめて取り出せなければ、参照ごとに取り出し直して、取り出せなかった参照と理由を返す。
   */
  async prefetch(refs: readonly string[]): Promise<{ ref: string; error: SecretNotFoundError }[]> {
    const account = this.options.account?.();
    const keyOf = (ref: string) => `${account ?? ""}\u0000${ref}`;
    const unique = [...new Set(refs)].filter(isOnePasswordRef);
    // すでに取り出し中・取り出し済みの参照は、その結果を待つ（戻ったときに、すべて取り出し終えているように）
    const failures: { ref: string; error: SecretNotFoundError }[] = [];
    const known = unique.filter((ref) => this.cache.has(keyOf(ref)));
    for (const ref of known) {
      await this.cache.get(keyOf(ref))?.catch((error: unknown) => {
        failures.push({
          ref,
          error: error instanceof SecretNotFoundError ? error : new SecretNotFoundError(ref),
        });
      });
    }
    const wanted = unique.filter((ref) => !known.includes(ref));
    if (wanted.length === 0) return failures;
    const dir = mkdtempSync(join(tmpdir(), "sacty-op-"));
    try {
      // 参照だけを書いたファイル（値は書かない）。本人だけが読める
      const envFile = join(dir, "refs.env");
      writeFileSync(envFile, wanted.map((ref, i) => `SACTY_OP_${i}="${ref}"\n`).join(""), {
        mode: 0o600,
      });
      const names = wanted.map((_, i) => `SACTY_OP_${i}`);
      const script = `process.stdout.write(JSON.stringify(${JSON.stringify(names)}.map((n) => process.env[n] ?? null)))`;
      let result: Awaited<ReturnType<OpRunner>> | undefined;
      try {
        result = await (this.options.run ?? runOp)([
          "run",
          "--no-masking",
          ...(account ? ["--account", account] : []),
          "--env-file",
          envFile,
          "--",
          process.execPath,
          "-e",
          script,
        ]);
      } catch {
        result = undefined;
      }
      let values: unknown;
      try {
        values = result && result.code === 0 ? JSON.parse(result.stdout) : undefined;
      } catch {
        values = undefined;
      }
      if (
        Array.isArray(values) &&
        values.length === wanted.length &&
        values.every((v) => typeof v === "string" && v !== "")
      ) {
        for (const [i, ref] of wanted.entries()) {
          this.cache.set(keyOf(ref), Promise.resolve(values[i] as string));
        }
        return failures;
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    // まとめて取り出せなかった（参照の誤り・サインインしていないなど）。どれが取り出せないかを参照ごとに確かめる
    for (const ref of wanted) {
      await this.get(ref).catch((error: unknown) => {
        failures.push({
          ref,
          error: error instanceof SecretNotFoundError ? error : new SecretNotFoundError(ref),
        });
      });
    }
    return failures;
  }

  /** メモリーに持った値を捨てる（画面から取り出し直すとき。PBI-48）。 */
  clear(): void {
    this.cache.clear();
  }

  get(ref: string): Promise<string> {
    // アカウントは取り出すときに決め、アカウントと参照の組で持つ（設定でアカウントを変えたら、前のアカウントの
    // 値を使い回さない。同じ名前の保管庫・アイテムが複数のアカウントにありうるため。PBI-34 レビュー指摘）
    const account = this.options.account?.();
    const key = `${account ?? ""}\u0000${ref}`;
    const cached = this.cache.get(key);
    if (cached) return cached;
    const pending = this.read(ref, account);
    this.cache.set(key, pending);
    pending.catch(() => this.cache.delete(key));
    return pending;
  }

  private async read(ref: string, account: string | undefined): Promise<string> {
    if (!isOnePasswordRef(ref)) throw new SecretNotFoundError(ref);
    let result: Awaited<ReturnType<OpRunner>>;
    try {
      result = await (this.options.run ?? runOp)([
        "read",
        "--no-newline",
        ...(account ? ["--account", account] : []),
        ref,
      ]);
    } catch {
      throw new SecretNotFoundError(ref, message("secret.opMissing"));
    }
    if (result.code === 0 && result.stdout) return result.stdout;
    const detail = result.stderr.trim().replace(/^\[ERROR\] \S+ \S+ /, "");
    if (/not (currently )?signed in|sign ?in|session (has )?expired|authoriz/i.test(detail)) {
      throw new SecretNotFoundError(ref, message("secret.opSignedOut", { ref }));
    }
    throw new SecretNotFoundError(
      ref,
      message("secret.opFailed", { ref, detail: detail || `exit code ${result.code}` }),
    );
  }
}

/** 参照の形で取得元を選ぶ（op:// は 1Password、それ以外はキーチェーン。PBI-34）。 */
export class ResolvingSecretStore implements SecretStore, PrefetchingSecretStore {
  constructor(
    private readonly keychain: SecretStore,
    private readonly onePassword: SecretStore &
      Partial<Pick<OnePasswordSecretStore, "prefetch" | "clear">>,
  ) {}
  get(ref: string): Promise<string> {
    return isOnePasswordRef(ref) ? this.onePassword.get(ref) : this.keychain.get(ref);
  }

  /**
   * 参照をまとめて取り出す（PBI-48）。1Password はまとめて取り出してメモリーに持ち、キーチェーンは取り出せるかを
   * 確かめる（キーチェーンは使うたびに取り出す。`sacty secret set` で変えた値をすぐに使うため）。
   * 取り出せなかった参照と理由を返す。fresh なら、持っている値を捨ててから取り出し直す。
   */
  async prefetch(
    refs: readonly string[],
    options: { fresh?: boolean } = {},
  ): Promise<{ ref: string; error: SecretNotFoundError }[]> {
    if (options.fresh) this.onePassword.clear?.();
    const unique = [...new Set(refs)];
    const failures: { ref: string; error: SecretNotFoundError }[] = [];
    const onePasswordRefs = unique.filter(isOnePasswordRef);
    if (onePasswordRefs.length > 0) {
      if (this.onePassword.prefetch)
        failures.push(...(await this.onePassword.prefetch(onePasswordRefs)));
      else {
        for (const ref of onePasswordRefs) {
          await this.onePassword.get(ref).catch((error: unknown) => {
            failures.push({
              ref,
              error: error instanceof SecretNotFoundError ? error : new SecretNotFoundError(ref),
            });
          });
        }
      }
    }
    for (const ref of unique.filter((r) => !isOnePasswordRef(r))) {
      await this.keychain.get(ref).catch((error: unknown) => {
        failures.push({
          ref,
          error: error instanceof SecretNotFoundError ? error : new SecretNotFoundError(ref),
        });
      });
    }
    return failures;
  }
}

/** 参照をまとめて取り出せる取り出し口（PBI-48）。 */
export interface PrefetchingSecretStore {
  prefetch(
    refs: readonly string[],
    options?: { fresh?: boolean },
  ): Promise<{ ref: string; error: SecretNotFoundError }[]>;
}

/** テスト用。 */
export class MemorySecretStore implements SecretStore {
  constructor(private readonly values: Record<string, string>) {}
  async get(name: string): Promise<string> {
    const value = this.values[name];
    if (value === undefined) throw new SecretNotFoundError(name);
    return value;
  }
}
