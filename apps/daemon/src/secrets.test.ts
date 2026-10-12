import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderMessage } from "@sacty/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  isOnePasswordRef,
  MemorySecretStore,
  OnePasswordSecretStore,
  type OpRunner,
  ResolvingSecretStore,
  SecretNotFoundError,
  SecretRef,
} from "./secrets.js";

const ja = (error: unknown) =>
  error instanceof SecretNotFoundError ? renderMessage(error.text, "ja") : String(error);

/** op の偽物。呼ばれた引数を記録し、決めた結果を返す。 */
function fakeOp(result: (args: string[]) => Awaited<ReturnType<OpRunner>> | Error) {
  const calls: string[][] = [];
  const run: OpRunner = async (args) => {
    calls.push(args);
    const r = result(args);
    if (r instanceof Error) throw r;
    return r;
  };
  return { run, calls };
}

describe("1Password の秘密情報（PBI-34）", () => {
  it("参照の形（op://保管庫/アイテム/[セクション/]フィールド）と、キーチェーンの名前を受け付ける", () => {
    expect(isOnePasswordRef("op://Work/Bedrock/credential")).toBe(true);
    expect(isOnePasswordRef("op://Work/Bedrock/api/credential")).toBe(true);
    expect(isOnePasswordRef("op://Work/Bedrock")).toBe(false);
    expect(isOnePasswordRef("op://Work/Bed rock/credential")).toBe(false);
    expect(SecretRef.safeParse("bedrock-api-key").success).toBe(true);
    expect(SecretRef.safeParse("op://Work/Bedrock/credential").success).toBe(true);
    expect(SecretRef.safeParse("op://Work").success).toBe(false);
    expect(SecretRef.safeParse("my key").success).toBe(false);
  });

  it("op read で取り出し、同じ参照は（同時の問い合わせも）1回だけ問い合わせて、メモリーに持つ", async () => {
    const op = fakeOp(() => ({ code: 0, stdout: "ABSK-secret", stderr: "" }));
    const store = new OnePasswordSecretStore({ run: op.run, account: () => "my.1password.com" });
    const [a, b] = await Promise.all([
      store.get("op://Work/Bedrock/credential"),
      store.get("op://Work/Bedrock/credential"),
    ]);
    expect([a, b]).toEqual(["ABSK-secret", "ABSK-secret"]);
    expect(await store.get("op://Work/Bedrock/credential")).toBe("ABSK-secret");
    expect(op.calls).toEqual([
      ["read", "--no-newline", "--account", "my.1password.com", "op://Work/Bedrock/credential"],
    ]);
  });

  it("取り出せなかった参照は持たず、次は問い合わせ直す（サインインし直せば取り出せる）", async () => {
    let signedIn = false;
    const op = fakeOp(() =>
      signedIn
        ? { code: 0, stdout: "value", stderr: "" }
        : {
            code: 1,
            stdout: "",
            stderr:
              "[ERROR] 2026/10/12 12:00:00 You are not currently signed in. Please run `op signin --help`",
          },
    );
    const store = new OnePasswordSecretStore({ run: op.run });
    const ref = "op://Work/Npm/token";
    const failure = await store.get(ref).catch((e) => e);
    expect(failure).toBeInstanceOf(SecretNotFoundError);
    expect(ja(failure)).toBe(
      "1Password にサインインしていないため、「op://Work/Npm/token」を取り出せません。op signin（または 1Password のアプリとの連携）でサインインしてから再開してください。",
    );
    signedIn = true;
    expect(await store.get(ref)).toBe("value");
    expect(op.calls).toHaveLength(2);
  });

  it("参照先が無い・op が無いときは、どの参照かと理由を返す", async () => {
    const missingItem = new OnePasswordSecretStore({
      run: fakeOp(() => ({
        code: 1,
        stdout: "",
        stderr: '[ERROR] 2026/10/12 12:00:00 "Bedrok" isn\'t an item in the "Work" vault',
      })).run,
    });
    expect(ja(await missingItem.get("op://Work/Bedrok/credential").catch((e) => e))).toBe(
      '1Password から「op://Work/Bedrok/credential」を取り出せませんでした（"Bedrok" isn\'t an item in the "Work" vault）。参照（保管庫・アイテム・フィールド）を確かめてから再開してください。',
    );
    const noOp = new OnePasswordSecretStore({
      run: fakeOp(() => Object.assign(new Error("spawn op ENOENT"), { code: "ENOENT" })).run,
    });
    expect(ja(await noOp.get("op://Work/Bedrock/credential").catch((e) => e))).toMatch(
      /op コマンドが見つかりません/,
    );
  });

  it("参照の形で取得元を選ぶ（op:// は 1Password、それ以外はキーチェーン）", async () => {
    const op = fakeOp(() => ({ code: 0, stdout: "from-1password", stderr: "" }));
    const store = new ResolvingSecretStore(
      new MemorySecretStore({ "npm-token": "from-keychain" }),
      new OnePasswordSecretStore({ run: op.run }),
    );
    expect(await store.get("npm-token")).toBe("from-keychain");
    expect(await store.get("op://Work/Npm/token")).toBe("from-1password");
    expect(op.calls).toHaveLength(1);
  });

  describe("実際の op コマンドの呼び出し（偽物の op を PATH に置く）", () => {
    const path = process.env.PATH;
    let dir = "";
    afterEach(() => {
      process.env.PATH = path;
      if (dir) rmSync(dir, { recursive: true, force: true });
    });

    it("引数を渡して標準出力を値にし、op が無ければ見つからないと返す", async () => {
      dir = mkdtempSync(join(tmpdir(), "sacty-op-"));
      const script = join(dir, "op");
      writeFileSync(
        script,
        '#!/bin/sh\nif [ "$1 $2" = "read --no-newline" ] && [ "$3" = "op://Work/Bedrock/credential" ]; then printf "%s" "ABSK-from-op"; exit 0; fi\necho "[ERROR] 2026/10/12 12:00:00 unexpected: $*" >&2; exit 1\n',
      );
      chmodSync(script, 0o755);
      process.env.PATH = `${dir}:${path}`;
      expect(await new OnePasswordSecretStore().get("op://Work/Bedrock/credential")).toBe(
        "ABSK-from-op",
      );
      expect(
        ja(await new OnePasswordSecretStore().get("op://Work/Other/x").catch((e) => e)),
      ).toMatch(/取り出せませんでした（unexpected: read --no-newline op:\/\/Work\/Other\/x）/);
      process.env.PATH = dir.replace(/\/[^/]+$/, "/sacty-no-such-dir");
      expect(
        ja(await new OnePasswordSecretStore().get("op://Work/Bedrock/credential").catch((e) => e)),
      ).toMatch(/op コマンドが見つかりません/);
    });
  });
});
