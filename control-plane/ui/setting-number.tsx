import NumberFlow from "@number-flow/react";
import { useMotion } from "./motion";

/** Shared motion for settings; the library honors prefers-reduced-motion. */
export function SettingNumber({
  value,
  decimals = 0,
}: {
  value: number;
  decimals?: number;
}) {
  const { enabled } = useMotion();
  return (
    <NumberFlow
      value={value}
      animated={enabled}
      locales="en-US"
      isolate
      format={{
        useGrouping: false,
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
      }}
      transformTiming={{
        duration: 450,
        easing: "cubic-bezier(0.22, 1, 0.36, 1)",
      }}
      opacityTiming={{ duration: 180, easing: "ease-out" }}
    />
  );
}
