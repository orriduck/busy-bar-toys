import type { ReactNode, SVGProps } from "react";
import type { Snapshot } from "./api";
export type IconName =
  | "chevron"
  | "plus"
  | "pause"
  | "play"
  | "end"
  | "refresh"
  | "device"
  | "computer"
  | "display"
  | "services"
  | "settings"
  | "plane"
  | "github"
  | "terminal";
export function Icon({
  name,
  ...props
}: { name: IconName } & SVGProps<SVGSVGElement>) {
  const paths: Record<IconName, string> = {
    chevron: "m6 9 6 6 6-6",
    plus: "M12 5v14M5 12h14",
    pause: "M8 5v14M16 5v14",
    play: "m8 5 11 7-11 7Z",
    end: "M5 5l14 14M19 5 5 19",
    refresh:
      "M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 12-1l2 6M4 12l2 6a7 7 0 0 0 12-1",
    computer: "M4 3h16v13H4ZM1 20h22M8 16v4M16 16v4",
    device: "M4 7h16a2 2 0 0 1 2 2v7H2V9a2 2 0 0 1 2-2ZM5 10h8M5 13h3M16 5h3",
    display: "m3 10 9-7 9 7v11H3ZM9 21v-8h6v8",
    services: "M3 3h7v7H3ZM3 14h7v7H3ZM14 14h7v7h-7ZM17.5 2v9M13 6.5h9",
    settings:
      "m9 3-1 3-3 1-2 4 2 2v3l3 2 1 3h6l1-3 3-2v-3l2-2-2-4-3-1-1-3ZM15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0",
    plane: "m21 10-6-1-6-7H6l3 7H4L2 6H1v11h1l2-4h5l-3 8h3l6-8 6-1Z",
    github:
      "M8 20c-4 1-4-2-6-2M16 22v-4c0-1-1-2-1-2 5 0 7-2 7-6 0-2-1-3-2-4 0-2 0-3-1-4-2 0-4 2-4 2-2-1-4-1-6 0 0 0-2-2-4-2-1 1-1 2-1 4-1 1-2 2-2 4 0 4 2 6 7 6 0 0-1 1-1 2v4",
    terminal: "m4 6 6 6-6 6M13 18h7",
  };
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
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
    <div className="brand" aria-label="BUSY Bar">
      <img src="/busy-logo.svg" width="80" height="26" alt="BUSY" />
    </div>
  );
}
export function AppIcon({ app }: { app: string }) {
  if (app === "codex" || app === "chatgpt")
    return (
      <img
        className="app-icon chatgpt-mark"
        src="/apps/chatgpt.png"
        alt=""
        width="28"
        height="28"
      />
    );
  if (app === "claude" || app === "dots")
    return (
      <img
        className="app-icon"
        src={`/apps/${app === "claude" ? "claude.png" : "dots.svg"}`}
        alt=""
        width="28"
        height="28"
      />
    );
  const icon: IconName =
    app === "adsbao"
      ? "plane"
      : app === "github"
        ? "github"
        : app === "terminal"
          ? "terminal"
          : "services";
  return (
    <span className={`app-icon app-${app.replace(/[^a-z-]/g, "")}`}>
      <Icon name={icon} />
    </span>
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
