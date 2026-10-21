import { describe, expect, it } from "vitest";
import { missingCommands } from "./test-runner.js";

describe("missingCommands", () => {
  const run = (output: string, exitCode = 127) => ({ exitCode, output });

  it("テストのコマンドに書いたツールが sh で見つからなければ、その名前を返す", () => {
    const command = "kustomize build overlays/prod | kubeconform -strict -";
    // dash・busybox・bash の書き方
    expect(missingCommands(command, run("sh: 1: kubeconform: not found\n"))).toEqual([
      "kubeconform",
    ]);
    expect(missingCommands(command, run("sh: kubeconform: not found"))).toEqual(["kubeconform"]);
    expect(missingCommands(command, run("sh: line 1: kustomize: command not found\r\n"))).toEqual([
      "kustomize",
    ]);
    expect(
      missingCommands(command, run("sh: 1: kustomize: not found\nsh: 1: kubeconform: not found\n")),
    ).toEqual(["kustomize", "kubeconform"]);
  });

  it("終了コードが 127 でなければ、見つからないとはみなさない", () => {
    expect(missingCommands("helm lint chart", run("sh: 1: helm: not found", 1))).toEqual([]);
  });

  it("テストのコマンドに書いていないもの・パスで書いたものは、イメージの問題とはみなさない", () => {
    // npm test の中のスクリプトが使うツールは、リポジトリ（依存）の問題
    expect(missingCommands("npm ci && npm test", run("sh: 1: vitest: not found"))).toEqual([]);
    expect(
      missingCommands("./scripts/check.sh", run("sh: 1: ./scripts/check.sh: not found")),
    ).toEqual([]);
    // 名前の一部が書いてあるだけでは当てない
    expect(missingCommands("helmfile lint", run("sh: 1: helm: not found"))).toEqual([]);
  });
});
