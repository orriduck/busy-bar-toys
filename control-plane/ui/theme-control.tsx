import { useEffect, useState } from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import { Button } from "./components/ui/button";
import {
  nextTheme,
  resolveTheme,
  themeMode,
  THEME_KEY,
  type ThemeMode,
} from "./theme";

function storedTheme(): ThemeMode {
  try {
    return themeMode(localStorage.getItem(THEME_KEY));
  } catch {
    return "auto";
  }
}
export function useTheme() {
  const [mode, setMode] = useState<ThemeMode>(storedTheme);
  useEffect(() => {
    const system = matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const resolved = resolveTheme(mode, system.matches);
      document.documentElement.classList.toggle("dark", resolved === "dark");
      document.documentElement.dataset.theme = resolved;
      document
        .querySelector('meta[name="theme-color"]')
        ?.setAttribute("content", resolved === "dark" ? "#0a0a0a" : "#f4f4f5");
    };
    apply();
    system.addEventListener("change", apply);
    return () => system.removeEventListener("change", apply);
  }, [mode]);
  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (
        event.storageArea === localStorage &&
        (event.key === THEME_KEY || event.key === null)
      )
        setMode(themeMode(event.newValue));
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);
  const cycle = () =>
    setMode((current) => {
      const next = nextTheme(current);
      try {
        localStorage.setItem(THEME_KEY, next);
      } catch {
        /* Private storage may be unavailable. */
      }
      return next;
    });
  return { mode, cycle };
}
export function ThemeToggle({
  mode,
  onCycle,
  className,
}: {
  mode: ThemeMode;
  onCycle: () => void;
  className?: string;
}) {
  const Icon = mode === "auto" ? Monitor : mode === "light" ? Sun : Moon;
  const label = `Appearance: ${mode === "auto" ? "Automatic" : mode === "light" ? "Light" : "Dark"}. Switch to ${nextTheme(mode)}.`;
  return (
    <Button
      variant="ghost"
      size="icon"
      className={className}
      onClick={onCycle}
      aria-label={label}
      title={label}
    >
      <Icon className="size-5" />
      <span className="sr-only">{label}</span>
    </Button>
  );
}
