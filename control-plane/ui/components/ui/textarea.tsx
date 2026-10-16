import { controlSurface } from "@/lib/control-styles";
import * as React from "react";
import { cn } from "cn";

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        controlSurface,
        "flex field-sizing-content min-h-24 w-full px-4 py-3",
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
