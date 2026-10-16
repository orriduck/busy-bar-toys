import { describe, expect, it } from "vitest";
import {
  policyFields,
  priorityPreset,
  sliderPosition,
  sliderValue,
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
