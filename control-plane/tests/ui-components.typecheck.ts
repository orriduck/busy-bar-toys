import type {
  Progress,
  ProgressTrack,
  ProgressIndicator,
} from "../ui/components/ui/progress";
import type {
  AlertDialogContent,
  AlertDialogCancel,
} from "../ui/components/ui/alert-dialog";
import type { Item } from "../ui/components/ui/item";
import type { ComponentProps } from "react";
import type { Button } from "../ui/components/ui/button";
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
  StringClassName<ComponentProps<typeof Progress>>,
  StringClassName<ComponentProps<typeof ProgressTrack>>,
  StringClassName<ComponentProps<typeof ProgressIndicator>>,
  StringClassName<ComponentProps<typeof AlertDialogContent>>,
  StringClassName<ComponentProps<typeof AlertDialogCancel>>,
  StringClassName<ComponentProps<typeof Item>>,
  StringClassName<ComponentProps<typeof Button>>,
  StringClassName<ComponentProps<typeof Switch>>,
  StringClassName<ComponentProps<typeof Separator>>,
  StringClassName<ComponentProps<typeof DialogContent>>,
  StringClassName<ComponentProps<typeof DialogDescription>>,
  StringClassName<ComponentProps<typeof DialogOverlay>>,
  StringClassName<ComponentProps<typeof DialogTitle>>,
];

export type { StyledClassNames };
