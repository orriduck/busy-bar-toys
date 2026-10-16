import { useId, useState } from "react";
import { CircleHelp } from "lucide-react";
import { Field, FieldContent, FieldLabel } from "./components/ui/field";
import {
  InputGroup,
  InputGroupInput,
  InputGroupAddon,
} from "./components/ui/input-group";
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
      {preset?.label ?? `Custom · ${value}`}
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
  value,
  onChange,
}: {
  field: PolicyKey;
  value: number;
  onChange: (value: number) => void;
}) {
  const id = useId(),
    definition = policyFields[field];
  const scaled = value / definition.scale;
  const detents = definition.presets.map((p) => p.value / definition.scale);
  return (
    <Field className="min-w-0 gap-3">
      <div className="flex min-w-0 items-center gap-1.5">
        <FieldLabel id={`${id}-label`}>{definition.label}</FieldLabel>
        <HelpTip label={definition.label}>{definition.help}</HelpTip>
        <InputGroup size="sm" className="ml-auto w-28 shrink-0">
          <InputGroupInput
            aria-label={`${definition.label} value`}
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
          {definition.unit && (
            <InputGroupAddon align="inline-end">
              {definition.unit}
            </InputGroupAddon>
          )}
        </InputGroup>
      </div>
      <FieldContent className="min-w-0">
        <div className="policy-slider">
          <Slider
            aria-label={`${definition.label} slider`}
            thumbLabel={`${definition.label} slider`}
            valueText={`${scaled} ${definition.unit}`.trim()}
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
