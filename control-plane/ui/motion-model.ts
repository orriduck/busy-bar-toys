export const motionTiming = {
  page: 0.28,
  return: 0.14,
  row: 0.24,
  enter: 0.2,
  stagger: 0.03,
  staggerBudget: 0.14,
} as const;

export type RowPosition = {
  id: string;
  top: number;
  offset: number;
  opacity: number;
};

export function entranceDelay(index: number, count: number) {
  return (
    index *
    Math.min(
      motionTiming.stagger,
      motionTiming.staggerBudget / Math.max(1, count - 1),
    )
  );
}

/** Reconcile structure only. Streaming payloads and playback ticks are not keys. */
export function listMotion(
  previous: ReadonlyMap<string, RowPosition>,
  rows: readonly RowPosition[],
  { enabled, first }: { enabled: boolean; first: boolean },
) {
  if (!enabled) return [];
  return rows.flatMap((row, index) => {
    const before = previous.get(row.id);
    const y = before ? before.top + before.offset - row.top : 5;
    if (before && Math.abs(y) < 0.5 && before.opacity >= 1) return [];
    return [
      {
        id: row.id,
        y,
        opacity: before?.opacity ?? 0,
        delay: first ? entranceDelay(index, rows.length) : 0,
        duration: before ? motionTiming.row : motionTiming.enter,
      },
    ];
  });
}
