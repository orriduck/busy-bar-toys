import type { CSSProperties } from "react";
import { Icon } from "./common";
import type { IconName } from "./common";
import { Button } from "./components/ui/button";
import { cn } from "./lib/utils";

export type Page = "display" | "services" | "configuration" | "device";
const pages: { id: Page; label: string; icon: IconName }[] = [
  { id: "display", label: "Display", icon: "display" },
  { id: "services", label: "Services", icon: "services" },
  { id: "configuration", label: "Configuration", icon: "settings" },
  { id: "device", label: "Device", icon: "device" },
];

export function Navigation({
  page,
  onPage,
}: {
  page: Page;
  onPage: (page: Page) => void;
}) {
  return (
    <nav
      className="primary-navigation"
      aria-label="Control plane"
      style={
        {
          "--navigation-index": pages.findIndex((entry) => entry.id === page),
        } as CSSProperties
      }
    >
      <span className="navigation-selection" aria-hidden="true" />
      {pages.map((entry) => (
        <Button
          key={entry.id}
          variant="navigation"
          className={cn("w-full", page === entry.id && "selected")}
          aria-label={entry.label}
          title={entry.label}
          aria-current={page === entry.id ? "page" : undefined}
          onClick={() => onPage(entry.id)}
        >
          <Icon name={entry.icon} data-icon="inline-start" />
          <span className="navigation-label">{entry.label}</span>
        </Button>
      ))}
    </nav>
  );
}
