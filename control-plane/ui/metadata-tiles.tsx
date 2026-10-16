import type { ReactNode } from "react";
import {
  Card,
  CardHeader,
  CardDescription,
  CardContent,
} from "./components/ui/card";
import { cn } from "./lib/utils";

/** A bounded value surface; long identities remain selectable and wrap in full. */
export function MetadataTile({
  label,
  children,
  className,
  detail,
}: {
  label: string;
  children: ReactNode;
  className?: string;
  detail?: ReactNode;
}) {
  return (
    <Card
      size="sm"
      className={cn("metadata-tile", className)}
      role="group"
      aria-label={label}
    >
      <CardHeader>
        <CardDescription>{label}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="metadata-value">{children}</div>
        {detail && (
          <div
            className="metadata-note"
            title={typeof detail === "string" ? detail : undefined}
          >
            {detail}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
