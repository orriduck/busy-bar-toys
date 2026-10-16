import { controlSurface } from "@/lib/control-styles";
import * as React from "react";
import { Input as InputPrimitive } from "@base-ui/react/input";
import { cn } from "cn";

function Input({
  className,
  type,
  variant = "default",
  ...props
}: React.ComponentProps<"input"> & { variant?: "default" | "embedded" }) {
  return (
    <InputPrimitive
      type={type}
      data-slot="input"
      className={cn(
        variant === "default"
          ? controlSurface
          : "min-w-0 border-0 bg-transparent text-foreground outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50",
        "h-12 w-full px-4 py-1 file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground",
        className,
      )}
      {...props}
    />
  );
}

export { Input };
