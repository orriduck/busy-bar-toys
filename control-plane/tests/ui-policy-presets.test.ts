import { describe, expect, it } from "vitest";
import {
  policyFields,
  priorityPreset,
  sliderPosition,
  sliderValue,
  sliderNudge,
} from "../ui/policy-presets";
describe("policy preset and precision controls", () => {
  it("preserves existing numeric priorities and detects exact presets only", () => {
    expect(priorityPreset(10)?.id).toBe("low");
    expect(priorityPreset(50)?.id).toBe("normal");
    expect(priorityPreset(1000)?.id).toBe("critical");
    expect(priorityPreset(999)).toBeUndefined();
  });
  it.each(Object.entries(policyFields))(
    "keeps %s full bounds and valid preset values",
    (_key, field) => {
      expect(sliderValue(0, field.stops, field.scale)).toBe(
        Math.round(field.min * field.scale),
      );
      expect(sliderValue(100, field.stops, field.scale)).toBe(
        field.max * field.scale,
      );
      for (const preset of field.presets) {
        const position = sliderPosition(
          preset.value / field.scale,
          field.stops,
        );
        expect(sliderValue(position, field.stops, field.scale)).toBe(
          preset.value,
        );
      }
    },
  );
  it("snaps near common stops but allows precise intermediate custom values", () => {
    const f = policyFields.heartbeatMs,
      position = sliderPosition(90, f.stops);
    expect(sliderValue(position + 0.5, f.stops, f.scale)).toBe(90000);
    expect(sliderValue(position + 2, f.stops, f.scale)).toBeGreaterThan(90000);
    const value = sliderValue(position + 5, f.stops, f.scale);
    expect(value).toBeGreaterThan(90000);
    expect(value).toBeLessThan(120000);
  });
  it("keeps timing boundaries monotone and clamps out-of-range slider positions", () => {
    for (const f of Object.values(policyFields)) {
      let previous = 0;
      for (let position = -1; position <= 101; position += 0.5) {
        const value = sliderValue(position, f.stops, f.scale);
        expect(value).toBeGreaterThanOrEqual(previous);
        previous = value;
      }
    }
  });
});

describe("preset-only slider detents", () => {
  it.each(Object.entries(policyFields))(
    "%s marks only its named presets and retains full bounds",
    (_key, f) => {
      const expected = [
        ...new Set([f.min, ...f.presets.map((p) => p.value / f.scale), f.max]),
      ].sort((a, b) => a - b);
      expect([...f.stops]).toEqual(expected);
      const detents = f.presets.map((p) => p.value / f.scale);
      for (const stop of detents) {
        const position = sliderPosition(stop, f.stops);
        expect(sliderValue(position + 0.5, f.stops, f.scale, detents)).toBe(
          Math.round(stop * f.scale),
        );
        if (position < 98)
          expect(
            sliderValue(position + 2, f.stops, f.scale, detents),
          ).toBeGreaterThan(Math.round(stop * f.scale));
      }
    },
  );
  it("does not create a snap plateau at an extra unnamed value", () => {
    const f = policyFields.heartbeatMs;
    const position = sliderPosition(120, f.stops);
    const detents = f.presets.map((p) => p.value / f.scale);
    expect(
      sliderValue(position + 0.5, f.stops, f.scale, detents),
    ).toBeGreaterThan(120000);
  });
});

it("makes every preset reachable through the actual one-percent pointer grid", () => {
  for (const f of Object.values(policyFields)) {
    const detents = f.presets.map((p) => p.value / f.scale);
    const emitted = new Set(
      Array.from({ length: 101 }, (_, position) =>
        sliderValue(position, f.stops, f.scale, detents),
      ),
    );
    for (const p of f.presets) expect(emitted.has(p.value)).toBe(true);
  }
});
it("keyboard movement leaves integer rounding plateaus and respects range ends", () => {
  const f = policyFields.priority,
    detents = f.presets.map((p) => p.value);
  expect(sliderNudge(0, 1, f.stops, f.scale, detents)).toBeGreaterThan(0);
  expect(sliderNudge(1, 1, f.stops, f.scale, detents)).toBeGreaterThan(1);
  expect(sliderNudge(1, -1, f.stops, f.scale, detents)).toBeLessThan(1);
  expect(sliderNudge(0, -1, f.stops, f.scale, detents)).toBe(0);
  expect(sliderNudge(1000, 1, f.stops, f.scale, detents)).toBe(1000);
});
