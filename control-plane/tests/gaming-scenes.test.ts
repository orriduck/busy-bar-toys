import { describe, expect, it } from "vitest";
import fixtures from "./fixtures/gaming-scenes.json";
import { validateElements, validateScene } from "../src/model";

describe("Python game renderer to Worker scene contract", () => {
  it.each(fixtures)(
    "accepts $source with reduced motion $reduced",
    (fixture) => {
      expect(() => validateScene(fixture.scene)).not.toThrow();
      expect(() => validateElements(fixture.update)).not.toThrow();
      expect(fixture.update.map((element) => element.id)).toEqual([
        "notice-detail",
      ]);
      expect(
        fixture.scene.commands[0].elements.some(
          (element) => element.id === "notice-detail",
        ),
      ).toBe(true);
    },
  );
  it("rejects the native timeout field that caused the real publisher failure", () => {
    const scene = structuredClone(fixtures[0].scene);
    Object.assign(scene.commands[0].elements.at(-1)!, { timeout: 60 });
    expect(() => validateScene(scene)).toThrow("ELEMENT_FIELD_NOT_ALLOWED");
  });
});
