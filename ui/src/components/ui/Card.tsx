import type { HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

// Kept minimal and signature-preserving (Card/CardHeader/CardBody, 0 current
// call sites) rather than adopting shadcn's own richer card.tsx (which uses
// CardContent/CardTitle/CardAction/CardFooter) — just re-skinned onto
// canonical shadcn tokens. See docs/superpowers/plans/2026-07-06-shadcn-ui-migration.md §Task 0.7.
export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("rounded-lg border border-border bg-card", className)}
      {...props}
    />
  );
}

export function CardHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("px-4 py-3 border-b border-border", className)} {...props} />;
}

export function CardBody({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("px-4 py-3", className)} {...props} />;
}
