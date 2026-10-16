import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { projectSettingsPath, projectTasksPath, switchPath, taskPath } from "./paths";

const SRC = fileURLToPath(new URL("..", import.meta.url));

/** 画面のソース（テストを除く）。 */
function sources(dir = SRC): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return sources(path);
    return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [path] : [];
  });
}

describe("画面の URL（PBI-114）", () => {
  it("プロジェクトの画面とタスクの URL を作る（ID はエンコードする）", () => {
    expect(projectTasksPath("p 1")).toBe("/projects/p%201/tasks");
    expect(projectSettingsPath("p/1")).toBe("/projects/p%2F1/settings");
    expect(taskPath("t 1")).toBe("/tasks/t%201");
    expect(switchPath("p 1", "/projects/p%201/tasks")).toBe(
      "/switch?project=p%201&to=%2Fprojects%2Fp%25201%2Ftasks",
    );
  });

  it("画面の中に、古い URL（タスクの一覧の / ・設定の /projects/<ID>）を指すリンクと移動先を残さない", () => {
    const old = [
      // タスクの一覧だった /
      /href="\/"/,
      /href=\{"\/"\}/,
      /redirect\("\/"\)/,
      /to=\/["`&]/,
      // 設定だった /projects/<ID>（/projects/<ID>/export などは別の画面）
      /`\/projects\/\$\{[^}]*\}(`|\?)/,
    ];
    const found = sources().flatMap((file) => {
      const text = readFileSync(file, "utf8");
      return old.filter((re) => re.test(text)).map((re) => `${relative(SRC, file)}: ${re}`);
    });
    expect(found).toEqual([]);
  });
});
