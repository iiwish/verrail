import type { HTMLAttributes } from "react";
import { cn } from "../lib/utils";

type VerrailBrandVariant = "mark" | "wordmark" | "lockup";

interface VerrailBrandProps extends HTMLAttributes<HTMLSpanElement> {
  decorative?: boolean;
  title?: string;
  variant?: VerrailBrandVariant;
}

const BRAND_ASSETS: Record<VerrailBrandVariant, { lightSurface: string; darkSurface: string }> = {
  mark: {
    lightSurface: "/brand/verrail/mark-dark.svg",
    darkSurface: "/brand/verrail/mark-light.svg",
  },
  wordmark: {
    lightSurface: "/brand/verrail/wordmark-dark.svg",
    darkSurface: "/brand/verrail/wordmark-light.svg",
  },
  lockup: {
    lightSurface: "/brand/verrail/lockup-dark.svg",
    darkSurface: "/brand/verrail/lockup-light.svg",
  },
};

export function VerrailBrand({
  className,
  decorative = false,
  title = "Verrail",
  variant = "lockup",
  ...props
}: VerrailBrandProps) {
  const assets = BRAND_ASSETS[variant];

  return (
    <span
      {...props}
      className={cn("inline-flex shrink-0 items-center", className)}
      role={decorative ? undefined : "img"}
      aria-hidden={decorative ? true : undefined}
      aria-label={decorative ? undefined : title}
    >
      <img src={assets.lightSurface} alt="" className="block h-full w-auto dark:hidden" />
      <img src={assets.darkSurface} alt="" className="hidden h-full w-auto dark:block" />
    </span>
  );
}

export function VerrailLoading({ className }: { className?: string }) {
  return (
    <div role="status" className={cn("flex min-h-dvh w-full items-center justify-center", className)}>
      <VerrailBrand variant="mark" decorative className="h-16 animate-pulse" />
      <span className="sr-only">Loading...</span>
    </div>
  );
}
