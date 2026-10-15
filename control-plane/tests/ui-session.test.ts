import { describe, expect, it } from "vitest";
import { SessionFence } from "../ui/session";
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
