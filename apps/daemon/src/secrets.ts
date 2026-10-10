import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/** sactyがキーチェーンに保存するときのサービス名。 */
export const KEYCHAIN_SERVICE = "sacty";

export class SecretNotFoundError extends Error {
  constructor(readonly secretName: string) {
    super(
      `秘密情報「${secretName}」が見つかりません。\`sacty secret set ${secretName}\` で保存してください。`,
    );
  }
}

/** 秘密情報の取り出し口。値は台帳・ログ・画面に出さない。 */
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

/** テスト用。 */
export class MemorySecretStore implements SecretStore {
  constructor(private readonly values: Record<string, string>) {}
  async get(name: string): Promise<string> {
    const value = this.values[name];
    if (value === undefined) throw new SecretNotFoundError(name);
    return value;
  }
}
