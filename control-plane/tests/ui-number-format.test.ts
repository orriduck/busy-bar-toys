import { describe, expect, it } from "vitest";
import { numberFormat } from "../ui/number-format";

const format = (value: number, decimals: number, minimumDecimals = 0) =>
  new Intl.NumberFormat(
    "en-US",
    numberFormat(decimals, minimumDecimals),
  ).format(value);

describe("compact number precision", () => {
  it("does not pad integer settings to six decimals", () => {
    expect(format(10, 6)).toBe("10");
    expect(format(90, 6)).toBe("90");
  });
  it("retains fractional precision without trailing zeros", () => {
    expect(format(0.123456, 6)).toBe("0.123456");
    expect(format(1.25, 6)).toBe("1.25");
  });
  it("lets FPS metrics explicitly retain one decimal", () => {
    expect(format(0, 1, 1)).toBe("0.0");
    expect(format(25, 1, 1)).toBe("25.0");
    expect(format(24.96, 1, 1)).toBe("25.0");
  });
  it("keeps priority and latency compact without grouping", () => {
    expect(format(1000, 0)).toBe("1000");
    expect(format(150, 0)).toBe("150");
  });
});
