import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    // 1Password の仕様どおり、空白を含む名前と、attribute などのクエリも受け付ける（レビュー指摘）
    expect(isOnePasswordRef("op://development/aws/Access Keys/access_key_id")).toBe(true);
    expect(isOnePasswordRef("op://Work/Bed rock/credential")).toBe(true);
    expect(
      isOnePasswordRef("op://development/GitHub/Security/one-time password?attribute=otp"),
    ).toBe(true);
    expect(isOnePasswordRef("op://Private/ssh keys/ssh key/private key?ssh-format=openssh")).toBe(
      true,
    );
    // 仕様に無い文字・空白だけの要素・要素の数の違いは受け付けない（その名前は ID で書く）
    expect(isOnePasswordRef("op://Work/Bed@rock/credential")).toBe(false);
    expect(isOnePasswordRef("op://Work/ /credential")).toBe(false);
    expect(isOnePasswordRef("op://Work/a/b/c/d")).toBe(false);
    expect(isOnePasswordRef("op://Work/a/b?attribute")).toBe(false);
    expect(SecretRef.safeParse("bedrock-api-key").success).toBe(true);
    expect(SecretRef.safeParse("op://Work/Bedrock/credential").success).toBe(true);
    expect(SecretRef.safeParse("op://Work").success).toBe(false);
    expect(SecretRef.safeParse("op://development/aws/Access Keys/access_key_id").success).toBe(
      true,
    );
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

  it("アカウントを変えたら、前のアカウントで取り出した値を使い回さない（レビュー指摘）", async () => {
    let account = "a.1password.com";
    const op = fakeOp((args) => ({
      code: 0,
      stdout: `value-of-${args[args.indexOf("--account") + 1]}`,
      stderr: "",
    }));
    const store = new OnePasswordSecretStore({ run: op.run, account: () => account });
    const ref = "op://Work/Bedrock/credential";
    expect(await store.get(ref)).toBe("value-of-a.1password.com");
    account = "b.1password.com";
    expect(await store.get(ref)).toBe("value-of-b.1password.com");
    // それぞれのアカウントの値は、アカウントごとに持ち続ける
    account = "a.1password.com";
    expect(await store.get(ref)).toBe("value-of-a.1password.com");
    expect(op.calls.map((c) => c[3])).toEqual(["a.1password.com", "b.1password.com"]);
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

  describe("起動時にまとめて取り出す（PBI-48）", () => {
    const path = process.env.PATH;
    let dir = "";
    afterEach(() => {
      process.env.PATH = path;
      if (dir) rmSync(dir, { recursive: true, force: true });
    });

    /**
     * op の偽物（PATH に置く）。run は --env-file の参照を値にして環境変数で渡し、-- の後のコマンドを動かす。
     * read は1件ずつ返す。呼ばれた回数を calls に書く。valid にない参照は取り出せない。
     */
    function installOp(valid: Record<string, string>) {
      dir = mkdtempSync(join(tmpdir(), "sacty-op-"));
      const cases = Object.entries(valid)
        .map(([ref, value]) => `    "${ref}") printf '%s' '${value}' ;;`)
        .join("\n");
      writeFileSync(
        join(dir, "op"),
        `#!/bin/sh
here=$(dirname "$0")
echo "$*" >> "$here/calls"
lookup() {
  case "$1" in
${cases}
    *) return 1 ;;
  esac
}
if [ "$1" = "read" ]; then
  for last; do :; done
  lookup "$last" || { echo "[ERROR] 2026/10/13 00:00:00 could not read secret '$last': item not found" >&2; exit 1; }
  exit 0
fi
if [ "$1" = "run" ]; then
  shift
  envfile=""
  while [ "$1" != "--" ]; do
    if [ "$1" = "--env-file" ]; then envfile="$2"; shift; fi
    shift
  done
  shift
  while IFS= read -r line; do
    key=\${line%%=*}
    ref=$(printf '%s' "\${line#*=}" | tr -d '"')
    value=$(lookup "$ref") || { echo "[ERROR] could not resolve $ref" >&2; exit 1; }
    export "$key=$value"
  done < "$envfile"
  exec "$@"
fi
exit 1
`,
      );
      chmodSync(join(dir, "op"), 0o755);
      process.env.PATH = `${dir}:${path}`;
      return {
        calls: () => {
          try {
            return readFileSync(join(dir, "calls"), "utf8").trim().split("\n");
          } catch {
            return [];
          }
        },
      };
    }

    it("1回の op run でまとめて取り出してメモリーに持ち、使うときは op を呼ばない", async () => {
      const op = installOp({
        "op://Work/AI Gateway/api-key": "key-1",
        "op://Work/Slack/token": "xoxb-2 with space",
      });
      const store = new OnePasswordSecretStore({ account: () => "my.1password.com" });
      expect(
        await store.prefetch([
          "op://Work/AI Gateway/api-key",
          "op://Work/Slack/token",
          "op://Work/AI Gateway/api-key",
          "keychain-name",
        ]),
      ).toEqual([]);
      expect(op.calls()).toHaveLength(1);
      expect(op.calls()[0]).toMatch(
        /^run --no-masking --account my\.1password\.com --env-file \S+ -- /,
      );
      // 参照のファイルは消す
      const envFile = op.calls()[0]?.match(/--env-file (\S+)/)?.[1] ?? "";
      expect(existsSync(envFile)).toBe(false);
      expect(await store.get("op://Work/AI Gateway/api-key")).toBe("key-1");
      expect(await store.get("op://Work/Slack/token")).toBe("xoxb-2 with space");
      expect(op.calls()).toHaveLength(1);
      // 持っている参照は、もう一度は取り出さない
      expect(await store.prefetch(["op://Work/Slack/token"])).toEqual([]);
      expect(op.calls()).toHaveLength(1);
    });

    it("まとめて取り出せなければ、参照ごとに取り出し直し、取り出せなかった参照と理由を返す", async () => {
      const op = installOp({ "op://Work/Ok/field": "ok-value" });
      const store = new OnePasswordSecretStore();
      const failures = await store.prefetch(["op://Work/Ok/field", "op://Work/Missing/field"]);
      expect(failures.map((f) => f.ref)).toEqual(["op://Work/Missing/field"]);
      expect(ja(failures[0]?.error)).toContain("item not found");
      // run の1回と、参照ごとの read の2回
      expect(op.calls().map((c) => c.split(" ")[0])).toEqual(["run", "read", "read"]);
      expect(await store.get("op://Work/Ok/field")).toBe("ok-value");
      expect(op.calls()).toHaveLength(3);
    });

    it("先に始まった取り出しがあれば、その完了を待ってから戻り、失敗も返す（レビュー指摘）", async () => {
      let release: (() => void) | undefined;
      const calls: string[] = [];
      const store = new OnePasswordSecretStore({
        run: async (args) => {
          calls.push(args[0] ?? "");
          if (args[0] === "read") {
            await new Promise<void>((r) => {
              release = r;
            });
            return { code: 1, stdout: "", stderr: "[ERROR] 2026/10/13 00:00:00 item not found" };
          }
          return { code: 0, stdout: JSON.stringify(["v"]), stderr: "" };
        },
      });
      // PF の認証の用意などで、先に個別の取り出しが始まっている
      const early = store.get("op://Work/Early/f").catch(() => undefined);
      let done = false;
      const prefetching = store.prefetch(["op://Work/Early/f", "op://Work/Other/f"]).then((r) => {
        done = true;
        return r;
      });
      await new Promise((r) => setTimeout(r, 20));
      expect(done).toBe(false);
      release?.();
      const failures = await prefetching;
      await early;
      expect(failures.map((f) => f.ref)).toEqual(["op://Work/Early/f"]);
      expect(calls).toEqual(["read", "run"]);
    });

    it("取り出し直し（fresh）は、持っている値を捨ててから取り出す。キーチェーンは取り出せるかを確かめる", async () => {
      const op = installOp({ "op://Work/A/f": "v1" });
      const resolving = new ResolvingSecretStore(
        new MemorySecretStore({ "kc-ok": "x" }),
        new OnePasswordSecretStore(),
      );
      expect(await resolving.prefetch(["op://Work/A/f", "kc-ok"])).toEqual([]);
      expect(op.calls()).toHaveLength(1);
      expect(await resolving.prefetch(["op://Work/A/f"])).toEqual([]);
      expect(op.calls()).toHaveLength(1);
      expect(await resolving.prefetch(["op://Work/A/f"], { fresh: true })).toEqual([]);
      expect(op.calls()).toHaveLength(2);
      const failures = await resolving.prefetch(["kc-missing"]);
      expect(failures.map((f) => f.ref)).toEqual(["kc-missing"]);
      // 参照が1つも無ければ、op を呼ばない
      expect(await resolving.prefetch([])).toEqual([]);
      expect(op.calls()).toHaveLength(2);
    });
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
