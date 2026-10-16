import { describe, expect, it } from "vitest";
import gsap from "gsap";
import { measuredMotionScope } from "../ui/motion-scope";
import {
  entranceDelay,
  listMotion,
  motionTiming,
  type RowPosition,
} from "../ui/motion-model";

const row = (
  id: string,
  top: number,
  offset = 0,
  opacity = 1,
): RowPosition => ({ id, top, offset, opacity });
const positions = (...rows: RowPosition[]) =>
  new Map(rows.map((value) => [value.id, value]));
const enabled = { enabled: true, first: false };

describe("bounded dashboard motion", () => {
  it("caps a large first-visit stagger within the page entrance budget", () => {
    expect(entranceDelay(99, 100) + motionTiming.page).toBeCloseTo(0.42);
    expect(entranceDelay(0, 1)).toBe(0);
  });
  it("does nothing for payload or progress updates with unchanged positions", () => {
    const layout = [row("a", 0), row("b", 60)];
    expect(listMotion(positions(...layout), layout, enabled)).toEqual([]);
  });
  it("enters a new row and settles existing rows after insertion", () => {
    const plan = listMotion(
      positions(row("a", 0)),
      [row("b", 0), row("a", 60)],
      enabled,
    );
    expect(plan.map(({ id, y, opacity }) => ({ id, y, opacity }))).toEqual([
      { id: "b", y: 5, opacity: 0 },
      { id: "a", y: -60, opacity: 1 },
    ]);
  });
  it("closes the removed row's gap without retaining removed data or controls", () => {
    const plan = listMotion(
      positions(row("a", 0), row("b", 60)),
      [row("b", 0)],
      enabled,
    );
    expect(plan).toHaveLength(1);
    expect(plan[0]).toMatchObject({ id: "b", y: 60 });
  });
  it("starts an interrupted reorder at its current visual position", () => {
    const plan = listMotion(
      positions(row("b", 60, -25, 0.8)),
      [row("b", 0)],
      enabled,
    );
    expect(plan[0]).toMatchObject({ id: "b", y: 35, opacity: 0.8, delay: 0 });
  });
  it("never animates inactive, reduced-motion or dragging surfaces", () => {
    expect(
      listMotion(new Map(), [row("a", 0)], { enabled: false, first: true }),
    ).toEqual([]);
  });
  it("preserves an in-flight sample when GSAP reverts before reconciliation", () => {
    const target = { y: 0, opacity: 1 };
    let sample = { y: 0, opacity: 1 };
    const context = gsap.context((parent) =>
      measuredMotionScope(parent, () => {
        const tween = gsap.fromTo(
          target,
          { y: 60, opacity: 0 },
          {
            y: 0,
            opacity: 1,
            duration: 1,
            paused: true,
            ease: "power3.out",
            onUpdate: () => {
              sample = { y: target.y, opacity: target.opacity };
            },
          },
        );
        tween.progress(0.3);
      }),
    );
    const interrupted = { ...sample };
    expect(interrupted.y).toBeGreaterThan(0);
    expect(interrupted.y).toBeLessThan(60);
    context.revert();
    expect(target).toMatchObject({ y: 0, opacity: 1 });
    expect(sample).toEqual(interrupted);
    const plan = listMotion(
      positions(row("a", 60, sample.y, sample.opacity)),
      [row("a", 0)],
      enabled,
    );
    expect(plan[0].y).toBeCloseTo(60 + interrupted.y);
  });
});
