import { describe, expect, it } from "vitest";
import { repoLabels, repoShortName } from "./repo-label";

describe("指定したリポジトリの短い名前（PBI-360）", () => {
  it("リポジトリ名にし、URL の全体を残す", () => {
    expect(repoLabels([])).toEqual([]);
    expect(repoLabels(["https://github.com/acme/web"])).toEqual([
      { url: "https://github.com/acme/web", label: "web", href: "https://github.com/acme/web" },
    ]);
    expect(
      repoLabels(["https://github.com/acme/web", "https://github.com/acme/api"]).map(
        (r) => r.label,
      ),
    ).toEqual(["web", "api"]);
  });

  it("同じ名前があるものだけ owner/name、別のホストで owner/name も同じなら URL の全体にする", () => {
    expect(
      repoLabels([
        "https://github.com/acme/web",
        "https://github.com/other/Web",
        "https://github.com/acme/api",
      ]).map((r) => r.label),
    ).toEqual(["acme/web", "other/Web", "api"]);
    expect(
      repoLabels(["https://github.com/acme/web", "https://ghe.example.com/acme/web"]).map(
        (r) => r.label,
      ),
    ).toEqual(["https://github.com/acme/web", "https://ghe.example.com/acme/web"]);
  });

  it("path を選ぶと、いつも owner/name（詳細の単数の表示と同じ）", () => {
    expect(
      repoLabels(["https://github.com/acme/web", "https://github.com/acme/api"], "path").map(
        (r) => r.label,
      ),
    ).toEqual(["acme/web", "acme/api"]);
  });

  it("書き方の揺れた URL は、そろえた URL をリンク先にする。URL として読めない値は、そのまま出しリンクにしない", () => {
    expect(repoLabels(["https://GitHub.com/acme/web.git/"])).toEqual([
      {
        url: "https://GitHub.com/acme/web.git/",
        label: "web",
        href: "https://github.com/acme/web",
      },
    ]);
    expect(repoLabels(["acme/web", "javascript:alert(1)"])).toEqual([
      { url: "acme/web", label: "acme/web" },
      { url: "javascript:alert(1)", label: "javascript:alert(1)" },
    ]);
    expect(repoShortName("https://github.com/acme/web")).toBe("web");
    expect(repoShortName("acme/web")).toBe("acme/web");
  });
});
