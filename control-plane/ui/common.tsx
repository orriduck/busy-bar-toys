import type { ReactNode, SVGProps } from "react";
import {
  ChevronDown,
  Plus,
  Pause,
  Play,
  X,
  RefreshCw,
  Keyboard,
  Laptop,
  House,
  LayoutGrid,
  Settings,
  Plane,
  GitPullRequest,
  Terminal,
  Gamepad2,
  type LucideIcon,
} from "lucide-react";
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
  | "terminal"
  | "gaming";
export function Icon({
  name,
  ...props
}: { name: IconName } & SVGProps<SVGSVGElement>) {
  const icons: Record<IconName, LucideIcon> = {
    chevron: ChevronDown,
    plus: Plus,
    pause: Pause,
    play: Play,
    end: X,
    refresh: RefreshCw,
    device: Keyboard,
    computer: Laptop,
    display: House,
    services: LayoutGrid,
    settings: Settings,
    plane: Plane,
    github: GitPullRequest,
    terminal: Terminal,
    gaming: Gamepad2,
  };
  const Component = icons[name];
  return <Component aria-hidden="true" {...props} />;
}

export function Brand() {
  return (
    <div
      className="brand block h-[2.4rem] w-[22rem] max-w-full overflow-hidden"
      aria-label="BUSY Traffic Control"
    >
      <img
        src="/busy-traffic-control.png"
        width="2142"
        height="734"
        alt="BUSY Traffic Control"
        className="block size-full object-cover object-[50%_47.5%]"
      />
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
  const icon: IconName = ["wow", "wow-forever", "maplestory"].includes(app)
    ? "gaming"
    : app === "adsbao"
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
