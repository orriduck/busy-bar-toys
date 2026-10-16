import { Slider as SliderPrimitive } from "@base-ui/react/slider";
import { cn } from "@/lib/utils";

function Slider({
  className,
  variant = "default",
  marks = [],
  defaultValue,
  value,
  min = 0,
  max = 100,
  thumbLabel,
  valueText,
  ...props
}: SliderPrimitive.Root.Props & {
  thumbLabel?: string;
  valueText?: string;
  variant?: "default" | "pill";
  marks?: number[];
}) {
  const _values = Array.isArray(value)
    ? value
    : Array.isArray(defaultValue)
      ? defaultValue
      : [min, max];

  return (
    <SliderPrimitive.Root
      className={cn(
        "data-horizontal:w-full data-vertical:h-full",
        variant === "pill" && "px-4.5",
        className,
      )}
      data-slot="slider"
      defaultValue={defaultValue}
      value={value}
      thumbAlignment="center"
      min={min}
      max={max}
      {...props}
    >
      <SliderPrimitive.Control className="relative flex w-full touch-none items-center select-none data-disabled:opacity-50 data-vertical:h-full data-vertical:min-h-40 data-vertical:w-auto data-vertical:flex-col">
        <SliderPrimitive.Track
          data-slot="slider-track"
          className={cn(
            "relative grow overflow-hidden rounded-full bg-muted select-none data-horizontal:h-1 data-horizontal:w-full data-vertical:h-full data-vertical:w-1",
            variant === "pill" &&
              "border border-foreground/5 data-horizontal:h-8",
          )}
        >
          <SliderPrimitive.Indicator
            data-slot="slider-range"
            className="bg-primary select-none data-horizontal:h-full data-vertical:w-full"
          />
          {variant === "pill" && (
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-x-0 top-1/2"
            >
              {marks.map((position) => (
                <span
                  key={position}
                  className="absolute size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white/30"
                  style={
                    position === 100
                      ? { right: "0.375rem" }
                      : { left: `${position}%` }
                  }
                />
              ))}
            </div>
          )}
        </SliderPrimitive.Track>
        {Array.from({ length: _values.length }, (_, index) => (
          <SliderPrimitive.Thumb
            getAriaLabel={() => thumbLabel ?? "Value"}
            getAriaValueText={valueText ? () => valueText : undefined}
            data-slot="slider-thumb"
            key={index}
            className={cn(
              "relative block size-3 shrink-0 rounded-full border border-ring bg-white ring-ring/50 transition-[color,box-shadow] select-none after:absolute after:-inset-2 hover:ring-3 focus-visible:ring-3 focus-visible:outline-hidden active:ring-3 disabled:pointer-events-none disabled:opacity-50",
              variant === "pill" && "size-9 border-0 shadow-sm",
            )}
          />
        ))}
      </SliderPrimitive.Control>
    </SliderPrimitive.Root>
  );
}

export { Slider };
