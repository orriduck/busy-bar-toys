import { useId, useState, type CSSProperties } from "react";
import { SettingNumber } from "./setting-number";
import { cn } from "./lib/utils";
import { CircleHelp } from "lucide-react";
import { Field, FieldContent, FieldLabel } from "./components/ui/field";
import { InputGroup, InputGroupInput } from "./components/ui/input-group";
import { Button } from "./components/ui/button";
import { Slider } from "./components/ui/slider";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "./components/ui/tooltip";
import { Badge } from "./components/ui/badge";
import {
  policyFields,
  priorityPreset,
  sliderPosition,
  sliderValue,
  sliderNudge,
} from "./policy-presets";
import type { PolicyKey } from "./policy-presets";

export function PriorityBadge({ value }: { value: number }) {
  const preset = priorityPreset(value);
  return (
    <Badge
      variant="outline"
      className="priority-badge"
      data-priority={preset?.id ?? "custom"}
      title={`Priority ${value}`}
    >
      <span className="priority-dot" />
      {preset?.label ?? (
        <>
          Custom · <SettingNumber value={value} />
        </>
      )}
    </Badge>
  );
}
export function HelpTip({
  label,
  children,
}: {
  label: string;
  children: string;
}) {
  const [open, setOpen] = useState(false);
  const triggerId = useId();
  return (
    <Tooltip open={open} onOpenChange={setOpen} triggerId={triggerId}>
      <TooltipTrigger
        id={triggerId}
        closeOnClick={false}
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={`About ${label}`}
            onClick={() => setOpen(true)}
          />
        }
      >
        <CircleHelp />
      </TooltipTrigger>
      <TooltipContent>{children}</TooltipContent>
    </Tooltip>
  );
}
export function PolicyField({
  field,
  className,
  value,
  onChange,
}: {
  field: PolicyKey;
  className?: string;
  value: number;
  onChange: (value: number) => void;
}) {
  const id = useId(),
    definition = policyFields[field];
  const [editing, setEditing] = useState(false);
  const scaled = value / definition.scale;
  const currentPreset = definition.presets.find(
    (preset) => preset.value === value,
  );
  const detents = definition.presets.map((p) => p.value / definition.scale);
  const meaning =
    field === "priority"
      ? "priority"
      : field === "visibleMs"
        ? "hold"
        : "heartbeat";
  const tones = [
    "--priority-low",
    "--priority-normal",
    "--priority-high",
    "--priority-critical",
  ];
  const anchors = [10, 50, 100, 1000];
  const interval = Math.max(
    0,
    anchors.findIndex((anchor) => value <= anchor) - 1,
  );
  const index = value >= 1000 ? 2 : interval;
  const mix = Math.max(
    0,
    Math.min(
      100,
      ((value - anchors[index]) / (anchors[index + 1] - anchors[index])) * 100,
    ),
  );
  const accent =
    field === "priority"
      ? `color-mix(in oklch, var(${tones[index]}) ${100 - mix}%, var(${tones[index + 1]}) ${mix}%)`
      : `var(--slider-${meaning})`;
  return (
    <Field
      className={cn("min-w-0 gap-0", className)}
      style={{ "--slider-accent": accent } as CSSProperties}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-1">
        <FieldLabel id={`${id}-label`}>{definition.label}</FieldLabel>
        <HelpTip label={definition.label}>{definition.help}</HelpTip>
        <InputGroup
          title={
            currentPreset
              ? `${currentPreset.label} · ${scaled} ${definition.unit}`.trim()
              : undefined
          }
          size="xs"
          variant="quiet"
          className="ml-auto w-auto min-w-12 max-w-full shrink-0 justify-center px-1"
        >
          <Badge
            variant="outline"
            aria-hidden="true"
            className={cn("policy-value-badge", editing && "invisible")}
          >
            <SettingNumber
              value={scaled}
              decimals={field === "priority" ? 0 : 6}
            />
            {definition.unit}
          </Badge>
          <InputGroupInput
            className="absolute inset-0 h-full w-full [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
            data-readout={!editing}
            onFocus={() => setEditing(true)}
            onBlur={() => setEditing(false)}
            aria-label={`${definition.label} value`}
            aria-describedby={definition.unit ? `${id}-unit` : undefined}
            type="number"
            required
            min={definition.min}
            max={definition.max}
            step={field === "priority" ? 1 : "any"}
            value={scaled}
            onChange={(event) =>
              onChange(
                Math.round(Number(event.target.value) * definition.scale),
              )
            }
          />
        </InputGroup>
        {definition.unit && (
          <span id={`${id}-unit`} className="sr-only">
            Seconds
          </span>
        )}
      </div>
      <FieldContent className="min-w-0">
        <div className="policy-slider">
          <Slider
            variant="pill"
            meaning={meaning}
            style={{ "--slider-accent": accent } as CSSProperties}
            marks={detents.map((stop) =>
              sliderPosition(stop, definition.stops),
            )}
            aria-label={`${definition.label} slider`}
            thumbLabel={`${definition.label} slider`}
            valueText={
              currentPreset
                ? `${currentPreset.label}, ${scaled} ${definition.unit}`.trim()
                : `${scaled} ${definition.unit}`.trim()
            }
            value={[sliderPosition(scaled, definition.stops)]}
            min={0}
            max={100}
            step={1}
            onKeyDownCapture={(event) => {
              const direction =
                event.key === "ArrowRight" || event.key === "ArrowUp"
                  ? 1
                  : event.key === "ArrowLeft" || event.key === "ArrowDown"
                    ? -1
                    : null;
              if (direction === null) return;
              event.preventDefault();
              onChange(
                sliderNudge(
                  value,
                  direction,
                  definition.stops,
                  definition.scale,
                  detents,
                ),
              );
            }}
            onValueChange={(values) =>
              onChange(
                sliderValue(
                  Array.isArray(values) ? values[0] : values,
                  definition.stops,
                  definition.scale,
                  detents,
                ),
              )
            }
          />
          <div className="slider-stops" aria-hidden="true">
            {definition.presets.map((option) => {
              const position = sliderPosition(
                option.value / definition.scale,
                definition.stops,
              );
              return (
                <span
                  key={option.id}
                  data-priority={field === "priority" ? option.id : undefined}
                  style={{ left: `${position}%` }}
                >
                  <small
                    style={{
                      transform:
                        position === 100
                          ? "translateX(-100%)"
                          : "translateX(-50%)",
                    }}
                  >
                    {option.label}
                  </small>
                </span>
              );
            })}
          </div>
        </div>
      </FieldContent>
    </Field>
  );
}
