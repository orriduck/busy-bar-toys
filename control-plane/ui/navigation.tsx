import { useRef, type CSSProperties } from "react";
import { useLiquidNavigation } from "./navigation-motion";
import { Icon } from "./common";
import type { IconName } from "./common";
import { Button } from "./components/ui/button";
import { ThemeToggle } from "./theme-control";
import type { ThemeMode } from "./theme";
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
  appearance,
}: {
  page: Page;
  onPage: (page: Page) => void;
  appearance?: { mode: ThemeMode; cycle: () => void };
}) {
  const navigation = useRef<HTMLElement>(null);
  const selectedIndex = pages.findIndex((entry) => entry.id === page);
  useLiquidNavigation(navigation, selectedIndex);
  return (
    <nav
      ref={navigation}
      className="primary-navigation"
      aria-label="Control plane"
      style={
        {
          "--navigation-index": selectedIndex,
        } as CSSProperties
      }
    >
      <span className="navigation-selection" aria-hidden="true">
        <span className="navigation-liquid" />
      </span>
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
      {appearance && (
        <ThemeToggle
          mode={appearance.mode}
          onCycle={appearance.cycle}
          className="theme-toggle-mobile"
        />
      )}
    </nav>
  );
}
