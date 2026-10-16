import { describe, expect, it } from "vitest";
import { shellStrategy } from "../pwa/cache-policy";
const origin = "https://btc.test";
const paths = ["/index.html", "/assets/app.js", "/api/snapshot"];
describe("public shell cache boundary", () => {
  it("never intercepts authenticated or mutable APIs even if allowlisted by mistake", () => {
    for (const path of [
      "/api/snapshot",
      "/api/preview/stream",
      "/api/events",
      "/api/session",
    ])
      expect(
        shellStrategy(
          { url: origin + path, method: "GET", mode: "navigate" },
          origin,
          paths,
        ),
      ).toBe(null);
    expect(
      shellStrategy(
        { url: origin + "/assets/app.js", method: "POST", mode: "same-origin" },
        origin,
        paths,
      ),
    ).toBe(null);
  });
  it("excludes foreign origins and unlisted resources", () => {
    expect(
      shellStrategy(
        {
          url: "https://other.test/assets/app.js",
          method: "GET",
          mode: "cors",
        },
        origin,
        paths,
      ),
    ).toBe(null);
    expect(
      shellStrategy(
        { url: origin + "/private-data", method: "GET", mode: "same-origin" },
        origin,
        paths,
      ),
    ).toBe(null);
  });
  it("uses fresh navigation but immutable public asset caching", () => {
    expect(
      shellStrategy(
        { url: origin + "/?release=abc", method: "GET", mode: "navigate" },
        origin,
        paths,
      ),
    ).toBe("navigation");
    expect(
      shellStrategy(
        { url: origin + "/assets/app.js", method: "GET", mode: "same-origin" },
        origin,
        paths,
      ),
    ).toBe("asset");
  });
});
