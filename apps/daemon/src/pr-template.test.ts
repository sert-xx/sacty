import { renderMessage } from "@sacty/core";
import { describe, expect, it } from "vitest";
import {
  fillTemplate,
  GitHubPullRequestTemplates,
  limitBody,
  NOT_APPLICABLE,
  PR_BODY_MAX,
  TEMPLATE_MAX_BYTES,
  TRUNCATED_NOTE,
} from "./pr-template.js";
import type { BodyParts } from "./prompts.js";

const ja = (text: unknown) => renderMessage(text, "ja");

const parts: BodyParts = {
  summary: "目的の内容",
  changes: "変更の内容",
  tests: "テストの内容",
  issue: "Closes #12",
  record: "最終レビューの記録",
  footer: "---\nこの PR は sacty が作成しました（sacty task t-1）。",
};

describe("PR テンプレートを埋める（PBI-87）", () => {
  it("見出しの種類ごとに sacty の内容を入れ、説明の文は置き換え、コメントは残す", () => {
    const template = [
      "## 概要",
      "<!-- 何をするための PR か -->",
      "ここに概要を書いてください",
      "",
      "## 変更内容",
      "- 変更したこと",
      "",
      "## テスト",
      "どう確かめたか",
      "",
      "## 関連 Issue",
      "Closes #",
    ].join("\n");
    const { main, footer } = fillTemplate(template, parts);
    expect(main).toBe(
      [
        "## 概要",
        "",
        "<!-- 何をするための PR か -->",
        "",
        "目的の内容",
        "",
        "## 変更内容",
        "",
        "変更の内容",
        "",
        "## テスト",
        "",
        "テストの内容",
        "",
        "## 関連 Issue",
        "",
        "Closes #12",
        "",
        "<details>",
        "<summary>sacty の記録</summary>",
        "",
        "最終レビューの記録",
        "",
        "</details>",
      ].join("\n"),
    );
    // Issue は見出しに入れたので、footer には重ねない
    expect(footer).toBe(parts.footer);
  });

  it("英語の見出し・太字の項目も当てる。最初に当たった見出しだけに入れ、同じ種類の2つ目は該当なしにする", () => {
    const template = [
      "**Summary:**",
      "",
      "### What changed",
      "",
      "### Description",
      "",
      "## How to test",
      "",
      "## Related issues",
    ].join("\n");
    const { main } = fillTemplate(template, parts);
    expect(main).toContain("**Summary:**\n\n目的の内容");
    expect(main).toContain("### What changed\n\n変更の内容");
    expect(main).toContain(`### Description\n\n${NOT_APPLICABLE}`);
    expect(main).toContain("## How to test\n\nテストの内容");
    expect(main).toContain("## Related issues\n\nCloses #12");
  });

  it("チェックボックスはすべて外して残し、チェックボックスのある見出しには該当なしを書かない", () => {
    const template = [
      "## チェックリスト",
      "- [x] テストを書いた",
      "* [X] ドキュメントを直した",
      "1. [ ] レビューを受けた",
      "",
      "## テスト",
      "- [x] 単体テスト",
    ].join("\n");
    const { main } = fillTemplate(template, parts);
    expect(main).not.toMatch(/\[[xX]\]/);
    expect(main).toContain(
      "## チェックリスト\n\n- [ ] テストを書いた\n* [ ] ドキュメントを直した\n1. [ ] レビューを受けた",
    );
    expect(main).not.toContain(`## チェックリスト\n\n${NOT_APPLICABLE}`);
    // 内容のある見出しでは、内容の後にチェックボックスを残す
    expect(main).toContain("## テスト\n\nテストの内容\n\n- [ ] 単体テスト");
  });

  it("当てはまらない見出し・内容の無い見出しは、該当なしにする", () => {
    const { main } = fillTemplate("## スクリーンショット\n画像を貼る\n\n## 変更\n", {
      footer: "f",
      summary: "目的",
    });
    expect(main).toContain(`## スクリーンショット\n\n${NOT_APPLICABLE}`);
    expect(main).toContain(`## 変更\n\n${NOT_APPLICABLE}`);
    expect(main).not.toContain("画像を貼る");
    // どの見出しにも入れられなかったので、目的は畳まずに後ろに出す
    expect(main.endsWith(`## 変更\n\n${NOT_APPLICABLE}\n\n目的`)).toBe(true);
    expect(main).not.toContain("<details>");
  });

  it("見出しが1つも無いテンプレートでも、内容を失わない（目的・変更・テストは畳まずに出し、Issue は footer の前に出す）", () => {
    const { main, footer } = fillTemplate(
      "<!-- 変更の説明を書いてください -->\n説明\n- [x] 確かめた",
      parts,
    );
    expect(main).toBe(
      [
        "<!-- 変更の説明を書いてください -->",
        "- [ ] 確かめた",
        "",
        "目的の内容",
        "",
        "変更の内容",
        "",
        "テストの内容",
        "",
        "<details>",
        "<summary>sacty の記録</summary>",
        "",
        "最終レビューの記録",
        "",
        "</details>",
      ].join("\n"),
    );
    expect(footer).toBe(`Closes #12\n\n${parts.footer}`);
  });

  it("よくある英語のテンプレートの見出しを当てる（種類の一覧・スクリーンショット・チェックリストは書かない）", () => {
    const template = [
      "## Description",
      "## Related Issue",
      "## Motivation and Context",
      "## How Has This Been Tested?",
      "## Screenshots (if appropriate):",
      "## Types of changes",
      "- [ ] Bug fix",
      "## Checklist:",
      "- [x] My code follows the code style",
    ].join("\n");
    const { main } = fillTemplate(template, parts);
    expect(main).toContain("## Description\n\n目的の内容");
    expect(main).toContain("## Related Issue\n\nCloses #12");
    expect(main).toContain(`## Motivation and Context\n\n${NOT_APPLICABLE}`);
    expect(main).toContain("## How Has This Been Tested?\n\nテストの内容");
    expect(main).toContain(`## Screenshots (if appropriate):\n\n${NOT_APPLICABLE}`);
    expect(main).toContain("## Types of changes\n\n- [ ] Bug fix");
    expect(main).toContain("## Checklist:\n\n- [ ] My code follows the code style");
    // 変更の見出しが無いので、変更は sacty の記録に入れる
    expect(main).toContain("<summary>sacty の記録</summary>\n\n変更の内容\n\n最終レビューの記録");
  });

  it("Detail（詳細）の見出しは変更として当てる", () => {
    const { main } = fillTemplate("### Motivation / Background\n### Detail\n", parts);
    expect(main).toContain("### Motivation / Background\n\n目的の内容");
    expect(main).toContain("### Detail\n\n変更の内容");
  });

  it("日本語のテンプレートの見出しを当てる", () => {
    const template =
      "## 背景・目的\n## 対応内容\n## 動作確認\n## 関連チケット\n## レビューしてほしいところ\n";
    const { main } = fillTemplate(template, parts);
    expect(main).toContain("## 背景・目的\n\n目的の内容");
    expect(main).toContain("## 対応内容\n\n変更の内容");
    expect(main).toContain("## 動作確認\n\nテストの内容");
    expect(main).toContain("## 関連チケット\n\nCloses #12");
    expect(main).toContain(`## レビューしてほしいところ\n\n${NOT_APPLICABLE}`);
  });

  it("コードブロック・HTML のコメントの中の見出しは見出しにしない（中身は残さない・コメントはそのまま残す）", () => {
    const template = ["## 概要", "```", "## 変更", "```", "<!--", "## テスト", "-->"].join("\n");
    const { main } = fillTemplate(template, parts);
    // 見出しは「概要」だけ（コードブロックの見出しは消え、コメントの見出しはコメントのまま）
    expect(main).not.toContain("## 変更");
    expect(main.split("## テスト")).toHaveLength(2);
    expect(main).not.toContain(NOT_APPLICABLE);
    expect(main).toContain("<!--\n## テスト\n-->");
    expect(main).not.toContain("```");
  });

  it("閉じられていないコメントは閉じる（後ろの本文を隠さない）", () => {
    const { main } = fillTemplate("## 概要\n<!-- 説明\n", parts);
    expect(main).toContain("<!-- 説明\n -->");
  });

  it("CRLF のテンプレートも読む", () => {
    const { main } = fillTemplate("## Summary\r\nText\r\n## Testing\r\n", parts);
    expect(main).toContain("## Summary\n\n目的の内容");
    expect(main).toContain("## Testing\n\nテストの内容");
  });
});

describe("PR の本文の長さ（PBI-87）", () => {
  it("上限に収まるならそのまま", () => {
    expect(limitBody("main", "footer")).toEqual({ body: "main\n\nfooter", truncated: false });
    expect(limitBody("main", "")).toEqual({ body: "main", truncated: false });
  });

  it("超えるときは main の後ろを省き、footer は必ず残す", () => {
    const main = "a".repeat(PR_BODY_MAX * 2);
    const { body, truncated } = limitBody(main, "FOOTER sacty task t-1");
    expect(truncated).toBe(true);
    expect(body.length).toBeLessThanOrEqual(PR_BODY_MAX);
    expect(body.endsWith("FOOTER sacty task t-1")).toBe(true);
    expect(body).toContain(TRUNCATED_NOTE);
  });

  it("省いたところで閉じられていないコメント・コードブロック・折りたたみを閉じる", () => {
    const main = `<details>\n<summary>x</summary>\n\n\`\`\`\n<!-- ${"b".repeat(PR_BODY_MAX)}`;
    const { body } = limitBody(main, "FOOTER", PR_BODY_MAX);
    expect(body.length).toBeLessThanOrEqual(PR_BODY_MAX);
    const head = body.slice(0, body.indexOf(TRUNCATED_NOTE));
    expect(head.endsWith(" -->\n```\n\n")).toBe(true);
    expect(body).toContain("</details>\n\nFOOTER");
  });

  it("省けない部分（keep）は、省いて消えたら footer の前に出し直し、残っていれば重ねない（PR #99 レビュー指摘）", () => {
    const main = `先頭\n\n${"a".repeat(PR_BODY_MAX)}\n\nCloses #12`;
    const { body, truncated } = limitBody(main, "FOOTER", PR_BODY_MAX, ["先頭", "Closes #12"]);
    expect(truncated).toBe(true);
    expect(body.length).toBeLessThanOrEqual(PR_BODY_MAX);
    expect(body.endsWith("Closes #12\n\nFOOTER")).toBe(true);
    expect(body.split("先頭")).toHaveLength(2);
    // footer が空でも、省けない部分は最後に残す
    const fallback = limitBody(main, "", PR_BODY_MAX, ["Closes #12"]);
    expect(fallback.body.length).toBeLessThanOrEqual(PR_BODY_MAX);
    expect(fallback.body.endsWith("Closes #12")).toBe(true);
  });

  it("省けない部分が残っているかは、行として丸ごと・コメントとコードブロックの外にあるかで確かめる（PR #99 再レビュー指摘）", () => {
    const keep = ["Closes #12", "sacty task t-1"];
    const cases = [
      // 前に Closes #123 があり、後ろの Closes #12 だけが省かれる
      `Closes #123\n\n${"a".repeat(PR_BODY_MAX)}\n\nCloses #12`,
      // 同じ文字列が、行の一部・HTML のコメント・コードブロックの中にだけある
      `See Closes #12 later\n<!-- Closes #12 -->\n\`\`\`\nCloses #12\n\`\`\`\n${"a".repeat(PR_BODY_MAX)}\n\nCloses #12`,
      // タスクの ID も同じ（ほかの ID の一部として前にある）
      `sacty task t-10\n\n${"a".repeat(PR_BODY_MAX)}\n\nsacty task t-1`,
    ];
    for (const main of cases) {
      const { body } = limitBody(main, "FOOTER", PR_BODY_MAX, keep);
      expect(body.length).toBeLessThanOrEqual(PR_BODY_MAX);
      const tail = body.slice(body.indexOf(TRUNCATED_NOTE));
      for (const k of keep) {
        if (main.includes(`\n${k}`) && main.endsWith(k)) expect(tail).toContain(`\n${k}\n`);
      }
    }
    // 行として丸ごと残っていれば、重ねない
    const kept = limitBody(`Closes #12\n\n${"a".repeat(PR_BODY_MAX)}`, "FOOTER", PR_BODY_MAX, [
      "Closes #12",
    ]);
    expect(kept.body.split("Closes #12")).toHaveLength(2);
  });

  it("テンプレートの Issue の見出しが長い概要の後にあっても、省いたときに Closes を失わない（PR #99 レビュー指摘）", () => {
    const filled = fillTemplate("## 概要\n\n## Related Issue\n", {
      ...parts,
      summary: "長い概要。".repeat(20_000),
    });
    expect(filled.keep).toEqual(["Closes #12"]);
    const { body } = limitBody(filled.main, filled.footer, PR_BODY_MAX, filled.keep);
    expect(body.length).toBeLessThanOrEqual(PR_BODY_MAX);
    expect(body).toContain("Closes #12");
    expect(body.endsWith(parts.footer)).toBe(true);
  });

  it("サロゲートペアの途中で切らない", () => {
    const main = "😀".repeat(PR_BODY_MAX);
    const { body } = limitBody(main, "F");
    expect(body.length).toBeLessThanOrEqual(PR_BODY_MAX);
    expect(body).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });
});

type Route = { status: number; json: unknown } | (() => Promise<Response>);

/** URL ごとに応答を返す fetch の偽物（無い URL は 404）。 */
function routes(table: Record<string, Route>) {
  const calls: { url: string; auth?: string }[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, auth: (init.headers as Record<string, string>).authorization });
    const route = table[url];
    if (typeof route === "function") return route();
    const { status, json } = route ?? { status: 404, json: { message: "Not Found" } };
    return new Response(JSON.stringify(json), { status });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const API = "https://api.github.com/repos/acme/app/contents";
const ORG = "https://api.github.com/repos/acme/.github";
const file = (name: string, path: string, size = 10) => ({ name, path, type: "file", size });
const dir = (name: string, path: string) => ({ name, path, type: "dir", size: 0 });
const content = (text: string) => ({
  status: 200,
  json: { encoding: "base64", content: Buffer.from(text).toString("base64"), size: text.length },
});
const find = (impl: typeof fetch, repo = "https://github.com/acme/app") =>
  new GitHubPullRequestTemplates(impl).find({ repo, token: "ghp_secret" });

describe("PR テンプレートを探す（PBI-87）", () => {
  it(".github・ルート・docs の順で、大文字・小文字を区別せずに探す（.github のものを使う）", async () => {
    const { impl, calls } = routes({
      [API]: {
        status: 200,
        json: [
          dir(".GitHub", ".GitHub"),
          dir("Docs", "Docs"),
          file("pull_request_template.md", "pull_request_template.md"),
        ],
      },
      [`${API}/.GitHub`]: {
        status: 200,
        json: [file("PULL_REQUEST_TEMPLATE.md", ".GitHub/PULL_REQUEST_TEMPLATE.md")],
      },
      [`${API}/Docs`]: {
        status: 200,
        json: [file("pull_request_template.md", "Docs/pull_request_template.md")],
      },
      [`${API}/.GitHub/PULL_REQUEST_TEMPLATE.md`]: content("## 概要\n"),
    });
    expect(await find(impl)).toEqual({
      kind: "found",
      template: {
        repo: "https://github.com/acme/app",
        path: ".GitHub/PULL_REQUEST_TEMPLATE.md",
        text: "## 概要\n",
      },
    });
    expect(calls.every((c) => c.auth === "Bearer ghp_secret")).toBe(true);
  });

  it("前の順番で見つかったら、後の順番のディレクトリは読まない（その一覧の失敗で使えなくしない。PR #99 レビュー指摘）", async () => {
    const broken = { status: 500, json: { message: "boom" } };
    // ルートにあり、docs の一覧は失敗する
    const root = routes({
      [API]: {
        status: 200,
        json: [dir("docs", "docs"), file("pull_request_template.md", "pull_request_template.md")],
      },
      [`${API}/docs`]: broken,
      [`${API}/pull_request_template.md`]: content("root"),
    });
    expect(await find(root.impl)).toMatchObject({ kind: "found", template: { text: "root" } });
    expect(root.calls.map((c) => c.url)).not.toContain(`${API}/docs`);
    // .github にあり、docs の一覧は失敗する
    const github = routes({
      [API]: { status: 200, json: [dir(".github", ".github"), dir("docs", "docs")] },
      [`${API}/.github`]: {
        status: 200,
        json: [file("pull_request_template.md", ".github/pull_request_template.md")],
      },
      [`${API}/docs`]: broken,
      [`${API}/.github/pull_request_template.md`]: content("github"),
    });
    expect(await find(github.impl)).toMatchObject({ kind: "found", template: { text: "github" } });
    expect(github.calls.map((c) => c.url)).not.toContain(`${API}/docs`);
    // .github のディレクトリのテンプレートがあり、docs の一覧は失敗する（docs の1つのファイルを探すときに初めて失敗する）
    const multiple = routes({
      [API]: { status: 200, json: [dir(".github", ".github"), dir("docs", "docs")] },
      [`${API}/.github`]: {
        status: 200,
        json: [dir("PULL_REQUEST_TEMPLATE", ".github/PULL_REQUEST_TEMPLATE")],
      },
      [`${API}/docs`]: broken,
    });
    expect(await find(multiple.impl)).toMatchObject({ kind: "unusable" });
  });

  it(".github に無ければルート、ルートにも無ければ docs のものを使う", async () => {
    const root = routes({
      [API]: {
        status: 200,
        json: [
          dir(".github", ".github"),
          file("Pull_Request_Template.md", "Pull_Request_Template.md"),
        ],
      },
      [`${API}/.github`]: { status: 200, json: [file("CODEOWNERS", ".github/CODEOWNERS")] },
      [`${API}/Pull_Request_Template.md`]: content("root"),
    });
    expect(await find(root.impl)).toMatchObject({
      kind: "found",
      template: { path: "Pull_Request_Template.md", text: "root" },
    });
    const docs = routes({
      [API]: { status: 200, json: [dir("docs", "docs")] },
      [`${API}/docs`]: {
        status: 200,
        json: [file("pull_request_template.md", "docs/pull_request_template.md")],
      },
      [`${API}/docs/pull_request_template.md`]: content("docs"),
    });
    expect(await find(docs.impl)).toMatchObject({
      kind: "found",
      template: { path: "docs/pull_request_template.md", text: "docs" },
    });
  });

  it("1つのファイルが無ければ、PULL_REQUEST_TEMPLATE/ の中の .md のうち名前の順で最初のものを使う", async () => {
    const { impl } = routes({
      [API]: { status: 200, json: [dir(".github", ".github")] },
      [`${API}/.github`]: {
        status: 200,
        json: [dir("PULL_REQUEST_TEMPLATE", ".github/PULL_REQUEST_TEMPLATE")],
      },
      [`${API}/.github/PULL_REQUEST_TEMPLATE`]: {
        status: 200,
        json: [
          file("feature.md", ".github/PULL_REQUEST_TEMPLATE/feature.md"),
          file("README.txt", ".github/PULL_REQUEST_TEMPLATE/README.txt"),
          file("Bugfix.md", ".github/PULL_REQUEST_TEMPLATE/Bugfix.md"),
          dir("a.md", ".github/PULL_REQUEST_TEMPLATE/a.md"),
        ],
      },
      [`${API}/.github/PULL_REQUEST_TEMPLATE/Bugfix.md`]: content("bug"),
    });
    expect(await find(impl)).toMatchObject({
      kind: "found",
      template: { path: ".github/PULL_REQUEST_TEMPLATE/Bugfix.md" },
    });
  });

  it("対象のリポジトリに無ければ、Org の公開の .github リポジトリの同じ場所を探す", async () => {
    const { impl } = routes({
      [API]: { status: 200, json: [file("README.md", "README.md")] },
      [ORG]: { status: 200, json: { private: false } },
      [`${ORG}/contents`]: { status: 200, json: [dir(".github", ".github")] },
      [`${ORG}/contents/.github`]: {
        status: 200,
        json: [file("pull_request_template.md", ".github/pull_request_template.md")],
      },
      [`${ORG}/contents/.github/pull_request_template.md`]: content("org"),
    });
    expect(await find(impl)).toEqual({
      kind: "found",
      template: {
        repo: "https://github.com/acme/.github",
        path: ".github/pull_request_template.md",
        text: "org",
      },
    });
  });

  it("Org の .github が無い・非公開なら、テンプレートは無いものとする（非公開は理由を添える）", async () => {
    const none = routes({ [API]: { status: 200, json: [] } });
    expect(await find(none.impl)).toEqual({ kind: "none" });
    const hidden = routes({
      [API]: { status: 200, json: [] },
      [ORG]: { status: 200, json: { private: true } },
      [`${ORG}/contents`]: {
        status: 200,
        json: [file("pull_request_template.md", "pull_request_template.md")],
      },
    });
    const result = await find(hidden.impl);
    expect(result.kind).toBe("none");
    expect(ja(result.kind === "none" ? result.message : "")).toContain("非公開");
    // 非公開の中身は読まない
    expect(hidden.calls.map((c) => c.url)).not.toContain(`${ORG}/contents`);
  });

  it("対象のリポジトリが空・見えない（404）なら Org を探し、対象が Org の .github そのものなら Org を探し直さない", async () => {
    const empty = routes({});
    expect(await find(empty.impl)).toEqual({ kind: "none" });
    expect(empty.calls.map((c) => c.url)).toEqual([API, ORG]);
    const self = routes({});
    expect(await find(self.impl, "https://github.com/acme/.github")).toEqual({ kind: "none" });
    expect(self.calls).toHaveLength(1);
  });

  it("権限・取得の失敗は、使えなかったとして理由を返す（例外にしない）", async () => {
    const denied = routes({ [API]: { status: 403, json: { message: "Resource not accessible" } } });
    const result = await find(denied.impl);
    expect(result).toMatchObject({ kind: "unusable", repo: "https://github.com/acme/app" });
    expect(ja(result.kind === "unusable" ? result.message : "")).toBe(
      "PR テンプレート（/）を確かめられませんでした（HTTP 403）：Resource not accessible",
    );
    // Org の .github の確認の失敗
    const org = routes({
      [API]: { status: 200, json: [] },
      [ORG]: { status: 500, json: { message: "boom" } },
    });
    expect(await find(org.impl)).toMatchObject({
      kind: "unusable",
      repo: "https://github.com/acme/.github",
    });
    // 通信の失敗
    const offline = routes({ [API]: () => Promise.reject(new Error("ECONNRESET")) });
    const failed = await find(offline.impl);
    expect(failed.kind).toBe("unusable");
    expect(ja(failed.kind === "unusable" ? failed.message : "")).toContain("ECONNRESET");
    // テンプレートのファイルの読み込みの失敗
    const read = routes({
      [API]: { status: 200, json: [file("pull_request_template.md", "pull_request_template.md")] },
      [`${API}/pull_request_template.md`]: { status: 502, json: {} },
    });
    expect(await find(read.impl)).toMatchObject({
      kind: "unusable",
      path: "pull_request_template.md",
    });
  });

  it("時間切れなら、使えなかったとして返す", async () => {
    const impl = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      })) as unknown as typeof fetch;
    const result = await new GitHubPullRequestTemplates(impl, 20).find({
      repo: "https://github.com/acme/app",
      token: "t",
    });
    expect(result.kind).toBe("unusable");
  });

  it("大きすぎる・空・UTF-8 でないテンプレートは使わない（大きすぎるものは中身を読まない）", async () => {
    const big = routes({
      [API]: {
        status: 200,
        json: [
          file("pull_request_template.md", "pull_request_template.md", TEMPLATE_MAX_BYTES + 1),
        ],
      },
    });
    const large = await find(big.impl);
    expect(large).toMatchObject({ kind: "unusable", path: "pull_request_template.md" });
    expect(ja(large.kind === "unusable" ? large.message : "")).toContain("大きすぎる");
    expect(big.calls).toHaveLength(1);
    const listed = (json: unknown) =>
      routes({
        [API]: {
          status: 200,
          json: [file("pull_request_template.md", "pull_request_template.md")],
        },
        [`${API}/pull_request_template.md`]: { status: 200, json },
      });
    const noContent = await find(listed({ encoding: "none", content: "", size: 2_000_000 }).impl);
    expect(ja(noContent.kind === "unusable" ? noContent.message : "")).toContain("大きすぎる");
    const blank = await find(listed(content(" \n\n").json).impl);
    expect(ja(blank.kind === "unusable" ? blank.message : "")).toContain("空");
    const binary = await find(
      listed({ encoding: "base64", content: Buffer.from([0xff, 0xfe, 0x00]).toString("base64") })
        .impl,
    );
    expect(ja(binary.kind === "unusable" ? binary.message : "")).toContain("UTF-8");
  });

  it("BOM を除き、GitHub Enterprise Server はそのホストの API で探す", async () => {
    const api = "https://ghe.example.com/api/v3/repos/acme/app/contents";
    const { impl } = routes({
      [api]: { status: 200, json: [file("pull_request_template.md", "pull_request_template.md")] },
      [`${api}/pull_request_template.md`]: content("﻿## 概要"),
    });
    expect(await find(impl, "https://ghe.example.com/acme/app")).toMatchObject({
      kind: "found",
      template: { repo: "https://ghe.example.com/acme/app", text: "## 概要" },
    });
  });
});
