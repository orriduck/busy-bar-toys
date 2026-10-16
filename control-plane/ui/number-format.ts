/** Number Flow precision shared by setting badges and live metrics. */
export function numberFormat(
  decimals = 0,
  minimumDecimals = 0,
): Pick<
  Intl.NumberFormatOptions,
  "useGrouping" | "minimumFractionDigits" | "maximumFractionDigits"
> {
  return {
    useGrouping: false,
    minimumFractionDigits: minimumDecimals,
    maximumFractionDigits: decimals,
  };
}
