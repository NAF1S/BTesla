import { REQUEST_STATUS } from "@/lib/ride-status";

/**
 * A status chip: a state the server decided, as a coloured word.
 *
 * The tone is looked up from `ride-status.js` rather than derived here, so the
 * same status is the same colour everywhere it appears. `status` is a closed enum
 * from the API; an unrecognised value renders as a neutral chip with the raw value
 * shown rather than throwing, because a status added by a later milestone should
 * make a chip look plain, not break the page.
 */

const CHIP_TONES = {
  waiting: "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200",
  active: "border-sky-300 bg-sky-50 text-sky-900 dark:border-sky-800 dark:bg-sky-950 dark:text-sky-200",
  done: "border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-200",
  stopped: "border-zinc-300 bg-zinc-100 text-zinc-700 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
  neutral: "border-black/[.12] bg-white text-zinc-600 dark:border-white/[.2] dark:bg-transparent dark:text-zinc-400",
};

/** A chip for an arbitrary tone and label, when the caller already has both. */
export function Chip({ children, tone = "neutral", className = "" }) {
  return (
    <span
      className={[
        "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium",
        CHIP_TONES[tone] ?? CHIP_TONES.neutral,
        className,
      ].join(" ")}
    >
      {children}
    </span>
  );
}

/**
 * The chip for a ride request's status.
 *
 * @param {{ status: import("@/lib/types").RideRequestStatus, className?: string }} props
 */
export function RideStatusChip({ status, className = "" }) {
  const known = REQUEST_STATUS[status];

  return (
    <Chip tone={known?.tone ?? "neutral"} className={className}>
      {known?.label ?? status}
    </Chip>
  );
}

/** A small caption above a value. Used in the tracker's panels. */
export function Labeled({ label, children, className = "" }) {
  return (
    <div className={className}>
      <p className="text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400">{label}</p>
      <div className="mt-1 text-sm text-zinc-900 dark:text-zinc-50">{children}</div>
    </div>
  );
}

/** A single place, with its code as the secondary line. A place has no id to show. */
export function PlaceLine({ point, label }) {
  if (!point) return null;

  return (
    <Labeled label={label}>
      <span className="font-medium">{point.name}</span>{" "}
      {/* The space is not decoration: without it the name and the code run
          together in the accessibility tree as "Banani Road 11banani-road-11". */}
      <span className="font-mono text-xs text-zinc-500">{point.code}</span>
    </Labeled>
  );
}
