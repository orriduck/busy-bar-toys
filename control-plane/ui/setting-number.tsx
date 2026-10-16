import NumberFlow from "@number-flow/react";

/** Shared motion for settings; the library honors prefers-reduced-motion. */
export function SettingNumber({
  value,
  decimals = 0,
}: {
  value: number;
  decimals?: number;
}) {
  return (
    <NumberFlow
      value={value}
      locales="en-US"
      isolate
      format={{ useGrouping: false, maximumFractionDigits: decimals }}
      transformTiming={{
        duration: 450,
        easing: "cubic-bezier(0.22, 1, 0.36, 1)",
      }}
      opacityTiming={{ duration: 180, easing: "ease-out" }}
    />
  );
}
