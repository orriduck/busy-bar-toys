import NumberFlow from "@number-flow/react";
import { useMotion } from "./motion";
import { numberFormat } from "./number-format";

/** Shared motion for settings; the library honors prefers-reduced-motion. */
export function SettingNumber({
  value,
  decimals = 0,
  minimumDecimals = 0,
}: {
  value: number;
  decimals?: number;
  minimumDecimals?: number;
}) {
  const { enabled } = useMotion();
  return (
    <NumberFlow
      value={value}
      animated={enabled}
      locales="en-US"
      isolate
      format={numberFormat(decimals, minimumDecimals)}
      transformTiming={{
        duration: 450,
        easing: "cubic-bezier(0.22, 1, 0.36, 1)",
      }}
      opacityTiming={{ duration: 180, easing: "ease-out" }}
    />
  );
}
