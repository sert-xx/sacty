import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { code, type DaemonMessage, message } from "@sacty/core";
import { z } from "zod";
import { MessageError } from "./errors.js";

const run = promisify(execFile);

/** sactyがキーチェーンに保存するときのサービス名。 */
export const KEYCHAIN_SERVICE = "sacty";

/** 1Password の秘密情報の参照（op://保管庫/アイテム/[セクション/]フィールド。PBI-34）。 */
const ONE_PASSWORD_REF = /^op:\/\/[^/\s]+\/[^/\s]+(\/[^/\s]+)?\/[^/\s]+$/;

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

  get(ref: string): Promise<string> {
    const cached = this.cache.get(ref);
    if (cached) return cached;
    const pending = this.read(ref);
    this.cache.set(ref, pending);
    pending.catch(() => this.cache.delete(ref));
    return pending;
  }

  private async read(ref: string): Promise<string> {
    if (!isOnePasswordRef(ref)) throw new SecretNotFoundError(ref);
    const account = this.options.account?.();
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
export class ResolvingSecretStore implements SecretStore {
  constructor(
    private readonly keychain: SecretStore,
    private readonly onePassword: SecretStore,
  ) {}
  get(ref: string): Promise<string> {
    return isOnePasswordRef(ref) ? this.onePassword.get(ref) : this.keychain.get(ref);
  }
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
