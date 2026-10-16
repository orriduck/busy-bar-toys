import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./components/ui/select";

export type SettingOption = { value: string; label: string; priority?: string };
/** Shared composition of the official Select, with no separate control skin. */
export function SettingsSelect({
  id,
  size = "default",
  labelledBy,
  value,
  options,
  onChange,
}: {
  id?: string;
  size?: "default" | "sm";
  labelledBy?: string;
  value: string;
  options: SettingOption[];
  onChange: (value: string) => void;
}) {
  const selected = options.find((option) => option.value === value);
  return (
    <Select
      items={options}
      value={value}
      onValueChange={(choice) => {
        if (choice !== null) onChange(choice);
      }}
    >
      <SelectTrigger
        id={id}
        size={size}
        aria-labelledby={labelledBy}
        className="w-full"
        data-priority={selected?.priority}
      >
        {selected?.priority && <span className="priority-dot" />}
        <SelectValue />
      </SelectTrigger>
      <SelectContent align="start" alignItemWithTrigger={false}>
        <SelectGroup>
          {options.map((option) => (
            <SelectItem
              key={option.value}
              value={option.value}
              data-priority={option.priority}
            >
              {option.priority && <span className="priority-dot" />}
              {option.label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}
