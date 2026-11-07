import * as React from "react";
import { cn } from "@/lib/utils";

export interface QuotaBannerProps extends React.ComponentProps<"aside"> {
  label?: string;
  limit: number;
  onUpgrade?: () => void;
  onClose?: () => void;
  resetsAt: string;
  unit?: string;
  used: number;
}

export function QuotaBanner({
  className,
  label = "Monthly agent usage",
  limit,
  onUpgrade,
  onClose,
  resetsAt,
  unit = "runs",
  used,
  ...props
}: QuotaBannerProps) {
  const remaining = Math.max(limit - used, 0);
  const percentage = limit > 0 ? Math.min((used / limit) * 100, 100) : 0;
  const tone =
    percentage > 95
      ? "bg-red-500"
      : percentage >= 80
        ? "bg-amber-500"
        : "bg-white";

  return (
    <aside
      data-slot="quota-banner"
      className={cn(
        "relative rounded-[16px] bg-[#141416] border border-white/10 p-4 font-sans text-sm text-zinc-400 shadow-2xl backdrop-blur-md select-none",
        className
      )}
      {...props}
    >
      <div className="flex items-start gap-3.5">
        {/* Speedometer Gauge icon container */}
        <span className="flex size-9 shrink-0 items-center justify-center rounded-[10px] bg-white/[0.06] text-zinc-300">
          <svg
            className="size-4"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="m12 14 4-4" />
            <path d="M3.34 19a10 10 0 1 1 17.32 0" />
          </svg>
        </span>

        {/* Content */}
        <div className="min-w-0 flex-1">
          <h3 className="text-xs leading-4 font-medium text-zinc-400">{label}</h3>
          <p className="mt-1 text-[22px] leading-7 font-semibold tracking-[-0.02em] text-white tabular-nums">
            {used.toLocaleString()} / {limit.toLocaleString()}{" "}
            <span className="text-sm font-normal text-zinc-400">{unit}</span>
          </p>

          {/* Meter progress bar */}
          <meter
            aria-label={`${label}: ${used.toLocaleString()} of ${limit.toLocaleString()} ${unit} used`}
            className="sr-only"
            max={limit}
            min={0}
            value={Math.min(used, limit)}
          />
          <div
            aria-hidden="true"
            className="mt-3 h-1.5 overflow-hidden rounded-full bg-white/10"
          >
            <div
              className={cn("h-full rounded-full transition-all duration-300 ease-out", tone)}
              style={{ width: `${percentage}%` }}
            />
          </div>

          <p className="mt-2 text-xs leading-4 text-zinc-400 tabular-nums">
            {remaining.toLocaleString()} left · Resets {resetsAt}
          </p>
        </div>

        {/* Action buttons on the right */}
        <div className="flex items-center gap-1.5 shrink-0">
          {onUpgrade && (
            <button
              onClick={onUpgrade}
              className="group/button inline-flex h-7 items-center justify-center gap-1 rounded-full bg-white hover:bg-zinc-200 text-zinc-900 px-3 pb-0.5 text-xs font-semibold shadow-sm transition-all active:scale-95 cursor-pointer"
              type="button"
            >
              <span>Upgrade</span>
              <svg
                className="size-3 transition-transform duration-150 group-hover/button:translate-x-0.5 group-hover/button:-translate-y-0.5"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M7 17 17 7" />
                <path d="M7 7h10v10" />
              </svg>
            </button>
          )}

          {onClose && (
            <button
              onClick={onClose}
              className="flex size-7 items-center justify-center rounded-full text-zinc-400 hover:text-white hover:bg-white/10 transition-colors cursor-pointer"
              aria-label="Close"
              type="button"
            >
              <svg
                className="size-3.5"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>
      </div>
    </aside>
  );
}

export default QuotaBanner;
