import { Progress as ProgressPrimitive } from "@base-ui/react/progress";
import { cn } from "cn";

function Progress({
  className,
  children,
  value,
  ...props
}: Omit<ProgressPrimitive.Root.Props, "className"> & { className?: string }) {
  return (
    <ProgressPrimitive.Root
      value={value}
      data-slot="progress"
      className={cn("group/progress flex flex-wrap gap-3", className)}
      {...props}
    >
      {children}
      <ProgressTrack>
        <ProgressIndicator />
      </ProgressTrack>
    </ProgressPrimitive.Root>
  );
}

function ProgressTrack({
  className,
  ...props
}: Omit<ProgressPrimitive.Track.Props, "className"> & { className?: string }) {
  return (
    <ProgressPrimitive.Track
      className={cn(
        "relative flex h-1 w-full items-center overflow-x-hidden rounded-full bg-muted group-data-[size=thin]/progress:h-0.5",
        className,
      )}
      data-slot="progress-track"
      {...props}
    />
  );
}

function ProgressIndicator({
  className,
  ...props
}: Omit<ProgressPrimitive.Indicator.Props, "className"> & {
  className?: string;
}) {
  return (
    <ProgressPrimitive.Indicator
      data-slot="progress-indicator"
      className={cn(
        "h-full bg-primary transition-[width] duration-100 data-indeterminate:w-[28%] data-indeterminate:animate-[queue-playing_2.5s_ease-in-out_infinite] motion-reduce:data-indeterminate:animate-none motion-reduce:data-indeterminate:w-full motion-reduce:data-indeterminate:opacity-65",
        className,
      )}
      {...props}
    />
  );
}

function ProgressLabel({
  className,
  ...props
}: Omit<ProgressPrimitive.Label.Props, "className"> & { className?: string }) {
  return (
    <ProgressPrimitive.Label
      className={cn("text-sm font-medium", className)}
      data-slot="progress-label"
      {...props}
    />
  );
}

function ProgressValue({
  className,
  ...props
}: Omit<ProgressPrimitive.Value.Props, "className"> & { className?: string }) {
  return (
    <ProgressPrimitive.Value
      className={cn(
        "ml-auto text-sm text-muted-foreground tabular-nums",
        className,
      )}
      data-slot="progress-value"
      {...props}
    />
  );
}

export {
  Progress,
  ProgressTrack,
  ProgressIndicator,
  ProgressLabel,
  ProgressValue,
};
