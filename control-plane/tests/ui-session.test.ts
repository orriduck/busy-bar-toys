import { describe, expect, it } from "vitest";
import { SessionFence, collectorSetupMode } from "../ui/session";
describe("browser session isolation", () => {
  it("drops an old device response and its high revision after another login", () => {
    const fence = new SessionFence();
    const first = fence.reset("device-a");
    expect(fence.accept("device-a", 99, first)).toBe(true);
    fence.reset(null);
    const second = fence.reset("device-b");
    expect(fence.accept("device-a", 1000, first)).toBe(false);
    expect(fence.accept("device-b", 1, second)).toBe(true);
    expect(fence.accept("device-a", 1000, second)).toBe(false);
  });
  it("rejects late writes and events from a prior session on the same device", () => {
    const fence = new SessionFence();
    const first = fence.reset("device-a");
    const second = fence.reset("device-a");
    expect(fence.current(first)).toBe(false);
    expect(fence.accept("device-a", 8, first)).toBe(false);
    expect(fence.accept("device-a", 1, second)).toBe(true);
    expect(fence.accept("device-a", 0, second)).toBe(false);
    expect(fence.accept("device-a", 1, second)).toBe(true);
  });
});

describe("collector setup safety", () => {
  it("withholds commands when the mode request failed on any host", () => {
    expect(collectorSetupMode(null, "preview.workers.dev")).toBe("unknown");
    expect(collectorSetupMode(null, "localhost")).toBe("unknown");
  });
  it("uses authenticated session mode to separate public demo from production", () => {
    expect(collectorSetupMode(true, "preview.workers.dev")).toBe("public-demo");
    expect(collectorSetupMode(false, "control.example.com")).toBe("allowed");
    expect(collectorSetupMode(true, "localhost")).toBe("allowed");
  });
});
