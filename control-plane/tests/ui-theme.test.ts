import { describe, expect, it } from "vitest";
import { themeMode, nextTheme, resolveTheme } from "../ui/theme";

describe("appearance preference", () => {
  it("defaults unknown or absent preferences to automatic", () => {
    for (const value of [null, "", "system", "invalid"])
      expect(themeMode(value)).toBe("auto");
  });
  it("cycles through light, dark, automatic", () => {
    expect(nextTheme("auto")).toBe("light");
    expect(nextTheme("light")).toBe("dark");
    expect(nextTheme("dark")).toBe("auto");
  });
  it("only follows the system in automatic mode", () => {
    expect(resolveTheme("auto", true)).toBe("dark");
    expect(resolveTheme("auto", false)).toBe("light");
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });
});
