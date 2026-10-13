import { Gauge, ArrowUpRight } from "lucide-react";
import { cn } from "@/lib/utils";
import * as React from "react";

export interface QuotaBannerProps extends React.ComponentProps<"aside"> {
  label?: string;
  limit: number;
  onUpgrade?: () => void;
  resetsAt: string;
  unit?: string;
  used: number;
}

export function QuotaBanner({
  className,
  label = "Monthly agent usage",
  limit,
  onUpgrade,
  resetsAt,
  unit = "runs",
  used,
  ...props
}: QuotaBannerProps) {
  const remaining = Math.max(limit - used, 0);
  const percentage = limit > 0 ? Math.min((used / limit) * 100, 100) : 0;
  const barColor =
    percentage > 95
      ? "bg-red-500"
      : percentage >= 80
        ? "bg-amber-500"
        : "bg-foreground/85";

  return (
    <aside
      data-slot="quota-banner"
      className={cn(
        "rounded-2xl bg-card p-4 font-sans text-sm font-[450] tracking-[-0.05px] text-muted-foreground shadow-md dark:shadow-none",
        className
      )}
      {...props}
    >
      <div className="flex items-start gap-3">
        {/* Icon */}
        <span className="flex size-9 shrink-0 items-center justify-center rounded-[10px] bg-foreground/6 text-muted-foreground">
          <Gauge className="size-4" />
        </span>

        {/* Content */}
        <div className="min-w-0 flex-1">
          <h3 className="text-sm leading-5 font-medium text-muted-foreground">
            {label}
          </h3>
          <p className="mt-1 text-[22px] leading-7 font-medium tracking-[-0.02em] text-foreground tabular-nums">
            {used.toLocaleString()} / {limit.toLocaleString()}{" "}
            <span className="text-base font-normal text-muted-foreground">
              {unit}
            </span>
          </p>

          {/* Progress bar */}
          <div
            aria-hidden="true"
            className="mt-3 h-1.5 overflow-hidden rounded-full bg-foreground/10"
          >
            <div
              className={cn(
                "h-full rounded-full transition-all duration-300 ease-out",
                barColor
              )}
              style={{ width: `${percentage}%` }}
            />
          </div>

          {/* Remaining / reset */}
          <p className="mt-2 text-xs leading-5 text-muted-foreground tabular-nums">
            {remaining.toLocaleString()} remaining · Resets {resetsAt}
          </p>
        </div>

        {/* Upgrade button */}
        {onUpgrade && (
          <button
            type="button"
            onClick={onUpgrade}
            className="inline-flex items-center gap-1 rounded-full bg-primary px-3 py-1 text-[12px] font-[500] text-primary-foreground shadow-none hover:bg-primary/90 transition-colors active:scale-[0.97]"
          >
            Upgrade
            <ArrowUpRight className="size-3 -mr-0.5" />
          </button>
        )}
      </div>
    </aside>
  );
}

export default QuotaBanner;
