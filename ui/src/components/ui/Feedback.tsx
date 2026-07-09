import { type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Alert, AlertDescription } from "./alert";
import { Spinner as SpinnerPrimitive } from "./spinner";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "./empty";

/** The critic/status muted spinner — the shadcn `spinner` primitive with our
 *  default muted tone (callers can override via className). */
export function Spinner({ className }: { className?: string }) {
  return <SpinnerPrimitive className={cn("text-muted-foreground", className)} />;
}

export function Loading({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 px-4 py-8 text-sm text-muted-foreground">
      <Spinner />
      {label}
    </div>
  );
}

/** An icon/title/description/action empty state, now a shadcn `empty`
 *  composition. Signature unchanged so every caller inherits the primitive. */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: {
  icon: LucideIcon;
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <Empty className={cn("py-16", className)}>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Icon />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        {description && (
          <EmptyDescription className="max-w-xs text-xs">{description}</EmptyDescription>
        )}
      </EmptyHeader>
      {action && <EmptyContent>{action}</EmptyContent>}
    </Empty>
  );
}

export function ErrorState({ message }: { message: string }) {
  return (
    <Alert variant="destructive" className="m-4">
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  );
}
