import Link from "next/link";

/**
 * The handful of presentational pieces this milestone's screens are built from.
 *
 * Deliberately tiny and dependency-free: a card, a button, a labelled select, a
 * notice. There is no component library in this project and adding one for four
 * screens would be a dependency for a styling problem — Tailwind is already here,
 * and these are the repeated combinations worth naming.
 *
 * Nothing here holds state or knows about rides. That is what keeps a screen's
 * markup readable: the interesting logic is in the client components, and this
 * file is what makes it look like something.
 */

const join = (...classes) => classes.filter(Boolean).join(" ");

/** A bordered card, the unit every screen is composed of. */
export function Panel({ children, as: Element = "section", className = "" }) {
  return (
    <Element
      className={join(
        "rounded-xl border border-black/[.08] bg-white p-5 shadow-sm",
        "dark:border-white/[.145] dark:bg-zinc-900",
        className,
      )}
    >
      {children}
    </Element>
  );
}

/**
 * The column every page's content sits in.
 *
 * The root layout supplies the header and the flex column; this supplies the
 * measure (a phone-ish width, so the forms do not stretch across a desktop) and
 * the vertical padding. Four pages use it, which is exactly the point at which a
 * repeated set of classes is worth a name.
 */
export function PageShell({ children, className = "" }) {
  return (
    <div className="flex flex-1 justify-center bg-zinc-50 dark:bg-black">
      <main className={join("w-full max-w-2xl px-4 py-8 sm:px-8", className)}>{children}</main>
    </div>
  );
}

/** A screen or panel heading, with an optional description underneath. */
export function Heading({ children, description, level = 2, className = "" }) {
  const Tag = `h${level}`;
  const size = level === 1 ? "text-2xl sm:text-3xl" : "text-lg";

  return (
    <div className={className}>
      <Tag className={join(size, "font-semibold tracking-tight text-zinc-900 dark:text-zinc-50")}>
        {children}
      </Tag>
      {description ? (
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">{description}</p>
      ) : null}
    </div>
  );
}

const BUTTON_VARIANTS = {
  primary:
    "bg-zinc-900 text-white hover:bg-zinc-700 focus-visible:outline-zinc-900 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200",
  secondary:
    "border border-black/[.12] bg-white text-zinc-900 hover:bg-zinc-100 dark:border-white/[.2] dark:bg-transparent dark:text-zinc-100 dark:hover:bg-white/[.08]",
  quiet:
    "text-zinc-600 underline underline-offset-4 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100",
};

/**
 * A button.
 *
 * `disabled` is passed straight through to the element *and* used for the styling,
 * so a disabled control cannot be clicked and does not look clickable. That pair
 * matters more than it sounds: a submit button that looks live but does nothing is
 * how a passenger ends up clicking four times and creating four rides.
 */
export function Button({
  children,
  variant = "primary",
  type = "button",
  className = "",
  disabled = false,
  ...rest
}) {
  return (
    <button
      type={type}
      disabled={disabled}
      className={join(
        "inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition",
        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2",
        "disabled:cursor-not-allowed disabled:opacity-50",
        BUTTON_VARIANTS[variant],
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

/** A `Link` styled as a button, for navigation that is not an action. */
export function LinkButton({ children, href, variant = "secondary", className = "" }) {
  return (
    <Link
      href={href}
      className={join(
        "inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition",
        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2",
        BUTTON_VARIANTS[variant],
        className,
      )}
    >
      {children}
    </Link>
  );
}

/**
 * A labelled form control.
 *
 * The label is wired to the control with a real `htmlFor`/`id` pair rather than
 * wrapping it, because a wrapping label swallows the click target of a select on
 * some browsers. `hint` is where a field explains itself, and `error` is where it
 * says what is wrong — kept apart so a screen does not have to choose.
 */
export function Field({ id, label, hint, error, children }) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium text-zinc-800 dark:text-zinc-200">
        {label}
      </label>
      {children}
      {hint && !error ? <p className="text-xs text-zinc-500">{hint}</p> : null}
      {error ? (
        <p className="text-xs text-red-600 dark:text-red-400" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

const CONTROL_CLASSES = join(
  "w-full rounded-lg border border-black/[.12] bg-white px-3 py-2 text-sm text-zinc-900",
  "dark:border-white/[.2] dark:bg-zinc-900 dark:text-zinc-50",
  "disabled:cursor-not-allowed disabled:opacity-60",
  "focus:outline focus:outline-2 focus:outline-offset-1 focus:outline-zinc-900 dark:focus:outline-zinc-100",
);

/**
 * A `<select>` with a placeholder.
 *
 * The placeholder is a real disabled option rather than a `value=""` that happens
 * to render blank, so the control cannot be left in a state where it *looks* like
 * a choice was made.
 */
export function Select({ id, value, onChange, options, placeholder, disabled, ...rest }) {
  return (
    <select
      id={id}
      value={value}
      onChange={onChange}
      disabled={disabled}
      className={CONTROL_CLASSES}
      {...rest}
    >
      {placeholder ? (
        <option value="" disabled>
          {placeholder}
        </option>
      ) : null}
      {options.map((option) => (
        <option key={option.value} value={option.value} disabled={option.disabled}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

/** A text input, for the auth forms. */
export function Input({ id, className = "", ...rest }) {
  return <input id={id} className={join(CONTROL_CLASSES, className)} {...rest} />;
}

const NOTICE_TONES = {
  info: "border-sky-300 bg-sky-50 text-sky-900 dark:border-sky-800 dark:bg-sky-950 dark:text-sky-200",
  warning:
    "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200",
  error:
    "border-red-300 bg-red-50 text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-200",
  success:
    "border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-200",
};

/**
 * A message block.
 *
 * `role="alert"` on errors only: an error should interrupt a screen reader, and an
 * informational note should not.
 */
export function Notice({ children, tone = "info", title, className = "" }) {
  return (
    <div
      role={tone === "error" ? "alert" : undefined}
      className={join("rounded-lg border p-3 text-sm", NOTICE_TONES[tone], className)}
    >
      {title ? <p className="font-medium">{title}</p> : null}
      {children ? <div className={title ? "mt-1" : undefined}>{children}</div> : null}
    </div>
  );
}

/**
 * A label and value on one line, for the fare and route facts.
 *
 * A `<dl>` rather than a grid of divs, because that is what it is: two screens
 * read this, and a definition list is what a screen reader announces correctly.
 */
export function Facts({ items, className = "" }) {
  return (
    <dl className={join("grid gap-x-6 gap-y-3 sm:grid-cols-2", className)}>
      {items
        .filter((item) => item.value !== undefined)
        .map((item) => (
          <div key={item.label} className="flex items-baseline justify-between gap-4">
            <dt className="text-sm text-zinc-500 dark:text-zinc-400">{item.label}</dt>
            <dd className="text-sm font-medium tabular-nums text-zinc-900 dark:text-zinc-50">
              {item.value}
            </dd>
          </div>
        ))}
    </dl>
  );
}
