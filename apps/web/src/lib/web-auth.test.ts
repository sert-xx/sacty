import { describe, expect, it } from "vitest";
import {
  isAllowedHost,
  isValidLoginToken,
  isValidSession,
  sessionCookieName,
  sessionValue,
} from "./web-auth";

describe("画面の認証の判定（PBI-129）", () => {
  it("cookie の値は、今の起動の秘密から作ったものだけを認める", () => {
    expect(isValidSession(sessionValue("now"), "now")).toBe(true);
    // 前の起動の秘密・誤った値・秘密そのもの・空
    expect(isValidSession(sessionValue("before"), "now")).toBe(false);
    expect(isValidSession("x", "now")).toBe(false);
    expect(isValidSession("now", "now")).toBe(false);
    expect(isValidSession(undefined, "now")).toBe(false);
    expect(isValidSession("", "now")).toBe(false);
  });

  it("秘密が無ければ（sacty up で起動していない）、どの cookie も入り口の URL も認めない", () => {
    expect(isValidSession(sessionValue(""), undefined)).toBe(false);
    expect(isValidSession(sessionValue(""), "")).toBe(false);
    expect(isValidLoginToken("", "")).toBe(false);
    expect(isValidLoginToken("x", undefined)).toBe(false);
  });

  it("入り口の URL の秘密は、今の起動の秘密と完全に一致するものだけを認める", () => {
    expect(isValidLoginToken("now", "now")).toBe(true);
    expect(isValidLoginToken("before", "now")).toBe(false);
    expect(isValidLoginToken("no", "now")).toBe(false);
    expect(isValidLoginToken("now ", "now")).toBe(false);
    expect(isValidLoginToken(null, "now")).toBe(false);
  });

  it("cookie の名前にポートを入れる（同じホストの別のポートの sacty と分ける）", () => {
    expect(sessionCookieName("4700")).toBe("sacty-session-4700");
    expect(sessionCookieName("4800")).toBe("sacty-session-4800");
    expect(sessionCookieName(undefined)).toBe("sacty-session");
    expect(sessionCookieName("47;00")).toBe("sacty-session");
  });

  it.each([
    ["127.0.0.1:4700", true],
    ["127.0.0.1", true],
    ["localhost:4700", true],
    ["LOCALHOST:4700", true],
    ["[::1]:4700", true],
    ["host.docker.internal:4700", false],
    ["evil.example:4700", false],
    ["127.0.0.1.evil.example", false],
    ["localhost.evil.example:4700", false],
    ["127.0.0.2:4700", false],
    ["127.0.0.1:abc", false],
    ["", false],
    [null, false],
  ])("Host %s を受け付けるか：%s", (host, ok) => {
    expect(isAllowedHost(host)).toBe(ok);
  });
});
