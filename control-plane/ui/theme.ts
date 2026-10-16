export type ThemeMode = "auto" | "light" | "dark";
export const THEME_KEY = "btc-theme";
export function themeMode(value: string | null): ThemeMode {
  return value === "light" || value === "dark" ? value : "auto";
}
export function nextTheme(mode: ThemeMode): ThemeMode {
  return mode === "auto" ? "light" : mode === "light" ? "dark" : "auto";
}
export function resolveTheme(mode: ThemeMode, darkSystem: boolean) {
  return mode === "auto" ? (darkSystem ? "dark" : "light") : mode;
}
