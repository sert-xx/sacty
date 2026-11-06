import { describe, expect, it } from "vitest";
import config from "../../next.config";

describe("画面の応答のヘッダー", () => {
  it("すべてのパスで、別のサイトの枠に埋め込ませない", async () => {
    expect(await config.headers?.()).toEqual([
      {
        source: "/:path*",
        headers: [{ key: "Content-Security-Policy", value: "frame-ancestors 'none'" }],
      },
    ]);
  });
});
