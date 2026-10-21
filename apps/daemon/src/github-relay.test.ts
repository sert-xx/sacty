import { describe, expect, it } from "vitest";
import {
  githubGraphqlUrl,
  githubPromptLines,
  githubRelayEnv,
  isReadOnlyGraphql,
  relayHeaderValue,
} from "./github-relay.js";

const body = (query: unknown, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ query, ...extra });

describe("GitHub の読み取りの中継の判定", () => {
  it("query の操作と fragment だけを読み取りとみなす", () => {
    expect(isReadOnlyGraphql(body("{ viewer { login } }"))).toBe(true);
    expect(
      isReadOnlyGraphql(
        body(
          'query Q($n: Int!) { repository(owner: "o", name: "r") { pullRequest(number: $n) { title } } }',
        ),
      ),
    ).toBe(true);
    expect(
      isReadOnlyGraphql(
        body("query { ...F }\nfragment F on Query { viewer { login } }", { variables: { a: 1 } }),
      ),
    ).toBe(true);
    // 文字列・コメントの中の mutation は、操作の種類ではない
    expect(
      isReadOnlyGraphql(
        body(
          'query { search(query: "mutation", type: ISSUE, first: 1) { issueCount } } # mutation',
        ),
      ),
    ).toBe(true);
    // 引数の既定の値の {} の後ろでも見る
    expect(isReadOnlyGraphql(body("query($a: In = {}) { viewer { login } }"))).toBe(true);
  });

  it("mutation・subscription・読めないもの・まとめた要求・query の無いものは断る", () => {
    expect(
      isReadOnlyGraphql(
        body('mutation { addComment(input: {subjectId: "x", body: "y"}) { clientMutationId } }'),
      ),
    ).toBe(false);
    expect(isReadOnlyGraphql(body("query A { viewer { login } } mutation B { x }"))).toBe(false);
    expect(isReadOnlyGraphql(body("subscription { x }"))).toBe(false);
    expect(isReadOnlyGraphql(body("query($a: In = {}) mutation { x }"))).toBe(false);
    // 括弧・文字列が閉じていない（判定できない）
    expect(isReadOnlyGraphql(body("query { viewer { login }"))).toBe(false);
    expect(isReadOnlyGraphql(body('query { search(query: "x) { a } }'))).toBe(false);
    expect(isReadOnlyGraphql(JSON.stringify([{ query: "{ viewer { login } }" }]))).toBe(false);
    expect(isReadOnlyGraphql(JSON.stringify({ extensions: { persistedQuery: {} } }))).toBe(false);
    expect(isReadOnlyGraphql("not json")).toBe(false);
  });

  it("API の URL（github.com は別のホスト）と、ヘッダーの URL の書き換え", () => {
    expect(githubGraphqlUrl("github.com")).toBe("https://api.github.com/graphql");
    expect(githubGraphqlUrl("ghe.example.co.jp")).toBe("https://ghe.example.co.jp/api/graphql");
    expect(
      relayHeaderValue(
        '<https://api.github.com/repos/o/r/pulls?page=2>; rel="next", <https://api.github.com/repos/o/r/pulls?page=5>; rel="last"',
        "github.com",
        "http://host.docker.internal:1/r/t/github/github.com",
      ),
    ).toBe(
      '<http://host.docker.internal:1/r/t/github/github.com/repos/o/r/pulls?page=2>; rel="next", <http://host.docker.internal:1/r/t/github/github.com/repos/o/r/pulls?page=5>; rel="last"',
    );
    expect(
      relayHeaderValue(
        "https://ghe.example.co.jp/api/v3/repositories/1",
        "ghe.example.co.jp",
        "http://gw/r/t/github/ghe.example.co.jp",
      ),
    ).toBe("http://gw/r/t/github/ghe.example.co.jp/repositories/1");
  });

  it("環境変数と、役割ごとの指示（投稿の頼み方は、レビューを除く工程だけ）", () => {
    expect(githubRelayEnv("http://gw/r/t/github", ["github.com", "ghe.x"], "ghe.x")).toEqual({
      SACTY_GITHUB_URL: "http://gw/r/t/github",
      SACTY_GITHUB_HOSTS: "github.com ghe.x",
      GH_HOST: "ghe.x",
    });
    expect(githubPromptLines(["github.com"], "operation").join("\n")).toContain(
      '"sacty-github-comments"',
    );
    expect(githubPromptLines(["github.com"], "review").join("\n")).not.toContain(
      '"sacty-github-comments"',
    );
    expect(githubPromptLines(["github.com"], "orchestrator").join("\n")).not.toContain(
      '"sacty-github-comments"',
    );
    expect(githubPromptLines(["github.com"], "guardian").join("\n")).toContain("gh api");
  });
});
