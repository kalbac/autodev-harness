import { cva, type VariantProps } from "class-variance-authority";
import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

const button = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-[background,border,color] disabled:pointer-events-none disabled:opacity-50 select-none",
  {
    variants: {
      variant: {
        primary:
          "bg-accent text-white hover:bg-[color-mix(in_srgb,var(--color-accent)_88%,white)] border border-transparent",
        default:
          "bg-surface-2 text-text border border-line hover:border-line-strong hover:bg-[color-mix(in_srgb,var(--color-surface-2)_70%,white_4%)]",
        ghost: "bg-transparent text-muted hover:text-text hover:bg-surface-2 border border-transparent",
        outline: "bg-transparent text-text border border-line hover:border-line-strong",
      },
      size: {
        sm: "h-7 px-2.5 text-xs",
        md: "h-9 px-3.5",
        icon: "h-8 w-8",
      },
    },
    defaultVariants: { variant: "default", size: "md" },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof button> {}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, ...props }, ref) => (
    <button ref={ref} className={cn(button({ variant, size }), className)} {...props} />
  ),
);
Button.displayName = "Button";
