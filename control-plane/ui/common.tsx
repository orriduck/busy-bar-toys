import type { ReactNode } from "react";
import type { Snapshot } from "./api";
export function Icon({
  name,
}: {
  name: "chevron" | "plus" | "pause" | "play" | "end" | "refresh" | "device";
}) {
  const paths = {
    chevron: "m6 9 6 6 6-6",
    plus: "M12 5v14M5 12h14",
    pause: "M8 5v14M16 5v14",
    play: "m8 5 11 7-11 7Z",
    end: "M5 5l14 14M19 5 5 19",
    refresh:
      "M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 12-1l2 6M4 12l2 6a7 7 0 0 0 12-1",
    device: "M3 4h18v13H3ZM8 21h8M12 17v4",
  };
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d={paths[name]}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
export function Brand() {
  return (
    <div className="brand">
      <span className="dots" aria-hidden="true">
        {Array.from({ length: 16 }, (_, i) => (
          <i key={i} style={{ opacity: i === 2 || i === 8 ? 0.22 : 1 }} />
        ))}
      </span>
      BUSY BAR TOYS
    </div>
  );
}
export function serviceName(snapshot: Snapshot, id: string) {
  return snapshot.services.find((s) => s.id === id)?.name || id;
}
export function Meta({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="meta">
      <span>{label}</span>
      <div>{children}</div>
    </div>
  );
}
