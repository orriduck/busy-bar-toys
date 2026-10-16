export type PolicyKey = "priority" | "visibleMs" | "heartbeatMs";
export const priorityPresets = [
  { id: "low", label: "Low", value: 10 },
  { id: "normal", label: "Normal", value: 50 },
  { id: "high", label: "High", value: 100 },
  { id: "critical", label: "Critical", value: 1000 },
] as const;
export function priorityPreset(value: number) {
  return priorityPresets.find((p) => p.value === value);
}
export const policyFields = {
  priority: {
    label: "Priority",
    unit: "",
    scale: 1,
    min: 0,
    max: 1000,
    help: "Higher priority plays first within the same urgency. Urgent messages still take precedence over every preset.",
    presets: priorityPresets,
    stops: [0, 10, 50, 100, 1000],
  },
  visibleMs: {
    label: "Hold",
    unit: "s",
    scale: 1000,
    min: 1,
    max: 86400,
    help: "Visible time per turn when equal-tier services are ready. Timed messages end after this total visible time; source messages stay alive until their sender finishes.",
    presets: [5, 10, 30, 60].map((value) => ({
      id: String(value),
      label: value === 60 ? "1 min" : `${value} s`,
      value: value * 1000,
    })),
    stops: [1, 5, 10, 30, 60, 86400],
  },
  heartbeatMs: {
    label: "Heartbeat",
    unit: "s",
    scale: 1000,
    min: 5,
    max: 300,
    help: "How long a sender can stop checking in before its messages are treated as disconnected. This is a timeout, not the sender’s reporting interval.",
    presets: [30, 60, 90, 180].map((value) => ({
      id: String(value),
      label: `${value} s`,
      value: value * 1000,
    })),
    stops: [5, 30, 60, 90, 180, 300],
  },
} as const;
/** Piecewise scale gives short timings usable space while retaining full bounds. */
export function sliderPosition(value: number, stops: readonly number[]) {
  const v = Math.max(stops[0], Math.min(stops.at(-1)!, value));
  const index = stops.findIndex((stop) => stop >= v);
  if (index <= 0) return 0;
  return (
    ((index - 1 + (v - stops[index - 1]) / (stops[index] - stops[index - 1])) /
      (stops.length - 1)) *
    100
  );
}
export function sliderValue(
  position: number,
  stops: readonly number[],
  scale = 1,
  detents: readonly number[] = stops,
) {
  const raw = (Math.max(0, Math.min(100, position)) / 100) * (stops.length - 1);
  const clamped = Math.max(0, Math.min(100, position));
  const snap = detents.find(
    (stop) => Math.abs(sliderPosition(stop, stops) - clamped) <= 3,
  );
  if (snap !== undefined) return Math.round(snap * scale);
  const index = Math.min(stops.length - 2, Math.floor(raw));
  const value =
    stops[index] + (stops[index + 1] - stops[index]) * (raw - index);
  return Math.round(value * scale);
}

/** Two-percent key movement must also leave integer rounding plateaus. */
export function sliderNudge(
  value: number,
  direction: 1 | -1,
  stops: readonly number[],
  scale: number,
  detents: readonly number[],
) {
  const position = sliderPosition(value / scale, stops);
  const candidate = sliderValue(position + direction * 2, stops, scale, []);
  // Keyboard movement is directional: land on a crossed preset, then leave it
  // on the next key. Pointer magnetism must never pull a key step backwards.
  const crossed = detents
    .map((stop) => Math.round(stop * scale))
    .filter((stop) =>
      direction === 1
        ? stop > value && stop <= candidate
        : stop < value && stop >= candidate,
    )
    .sort((a, b) => direction * (a - b));
  const next = crossed[0] ?? candidate;
  return Math.max(
    Math.round(stops[0] * scale),
    Math.min(
      Math.round(stops.at(-1)! * scale),
      next === value ? value + direction : next,
    ),
  );
}
