import type { ComponentProps } from "react";
import type { Button } from "../ui/components/ui/button";
import type { Checkbox } from "../ui/components/ui/checkbox";
import type { Switch } from "../ui/components/ui/switch";
import type { Separator } from "../ui/components/ui/separator";
import type {
  DialogContent,
  DialogDescription,
  DialogOverlay,
  DialogTitle,
} from "../ui/components/ui/dialog";

// These styled wrappers merge classes with cn/cva, which accept strings only.
// A primitive's state callback must never silently reappear in their public API.
type StringClassName<Props extends { className?: string }> = Props["className"];
type StyledClassNames = [
  StringClassName<ComponentProps<typeof Button>>,
  StringClassName<ComponentProps<typeof Checkbox>>,
  StringClassName<ComponentProps<typeof Switch>>,
  StringClassName<ComponentProps<typeof Separator>>,
  StringClassName<ComponentProps<typeof DialogContent>>,
  StringClassName<ComponentProps<typeof DialogDescription>>,
  StringClassName<ComponentProps<typeof DialogOverlay>>,
  StringClassName<ComponentProps<typeof DialogTitle>>,
];

export type { StyledClassNames };
