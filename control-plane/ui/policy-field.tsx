import { useId, useState } from "react";
import { CircleHelp } from "lucide-react";
import { Field, FieldLabel } from "./components/ui/field";
import { Input } from "./components/ui/input";
import { Button } from "./components/ui/button";
import { Slider } from "./components/ui/slider";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectGroup,
  SelectItem,
} from "./components/ui/select";
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
            size="icon-sm"
            className="field-help"
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
  const preset = definition.presets.find((p) => p.value === value);
  const [custom, setCustom] = useState(!preset);
  const selected = custom || !preset ? "custom" : preset.id;
  const scaled = value / definition.scale;
  return (
    <Field className="policy-field">
      <div className="policy-label">
        <FieldLabel id={`${id}-label`}>{definition.label}</FieldLabel>
        <HelpTip label={definition.label}>{definition.help}</HelpTip>
      </div>
      <Select
        items={[
          ...definition.presets.map((p) => ({ value: p.id, label: p.label })),
          { value: "custom", label: "Custom" },
        ]}
        value={selected}
        onValueChange={(choice) => {
          if (!choice) return;
          setCustom(choice === "custom");
          const option = definition.presets.find((p) => p.id === choice);
          if (option) onChange(option.value);
        }}
      >
        <SelectTrigger
          className="policy-choice"
          aria-labelledby={`${id}-label`}
          data-priority={field === "priority" ? selected : undefined}
        >
          {field === "priority" && <span className="priority-dot" />}
          <SelectValue />
        </SelectTrigger>
        <SelectContent align="start" alignItemWithTrigger={false}>
          <SelectGroup>
            {definition.presets.map((option) => (
              <SelectItem
                key={option.id}
                value={option.id}
                data-priority={field === "priority" ? option.id : undefined}
              >
                {field === "priority" && <span className="priority-dot" />}
                {option.label}
              </SelectItem>
            ))}
            <SelectItem value="custom">Custom</SelectItem>
          </SelectGroup>
        </SelectContent>
      </Select>
      {selected === "custom" && (
        <div className="policy-custom">
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
                    definition.presets.map((p) => p.value / definition.scale),
                  ),
                );
              }}
              onValueChange={(values) => {
                const position = Array.isArray(values) ? values[0] : values;
                onChange(
                  sliderValue(
                    position,
                    definition.stops,
                    definition.scale,
                    definition.presets.map((p) => p.value / definition.scale),
                  ),
                );
              }}
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
          <div className="policy-exact">
            <Input
              aria-label={`${definition.label} custom value`}
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
            <span>{definition.unit}</span>
          </div>
        </div>
      )}
    </Field>
  );
}
