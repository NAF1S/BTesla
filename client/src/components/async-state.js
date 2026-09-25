import { Notice, Panel } from "./ui";

/**
 * The four states every screen that loads something has to have an answer for.
 *
 * This project talks to a separate API process over HTTP, so all four are
 * ordinary occurrences rather than edge cases: the API is not running
 * (`error` + `network`), the database is empty of seeded points (`empty`), the
 * session expired while the tab was open (`forbidden`/`unauthenticated`), and a
 * ride id that is not the passenger's (`not found`). A screen that rendered only
 * the happy path would be a screen that looks broken the first time anything is
 * wrong.
 *
 * Each one says what happened **and what to do about it**. A spinner with no
 * caption and an error with no next step are the two shapes of "the app is
 * broken" that are hardest to diagnose from the outside.
 */

/** A spinner with a caption. Uses `aria-busy` so a screen reader is told. */
export function Loading({ label = "Loading…", className = "" }) {
  return (
    <div
      aria-busy="true"
      className={["flex items-center gap-3 text-sm text-zinc-600 dark:text-zinc-400", className]
        .filter(Boolean)
        .join(" ")}
    >
      <span
        aria-hidden="true"
        className="size-4 animate-spin rounded-full border-2 border-zinc-300 border-t-transparent dark:border-zinc-600"
      />
      <span>{label}</span>
    </div>
  );
}

/**
 * Nothing to show, but nothing wrong.
 *
 * @param {{ title?: string, children?: React.ReactNode, action?: React.ReactNode }} props
 */
export function EmptyState({ title = "Nothing here yet", children, action }) {
  return (
    <Panel className="text-center">
      <p className="text-sm font-medium text-zinc-900 dark:text-zinc-50">{title}</p>
      {children ? (
        <div className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">{children}</div>
      ) : null}
      {action ? <div className="mt-4 flex justify-center">{action}</div> : null}
    </Panel>
  );
}

/**
 * Something went wrong, with the message the API or the network gave us.
 *
 * @param {{ title?: string, message?: string, hint?: string | null, action?: React.ReactNode }} props
 */
export function ErrorState({ title = "Something went wrong", message, hint, action }) {
  return (
    <Notice tone="error" title={title}>
      {message ? <p>{message}</p> : null}
      {hint ? <p className="mt-1 opacity-90">{hint}</p> : null}
      {action ? <div className="mt-3">{action}</div> : null}
    </Notice>
  );
}

/**
 * "You may not see this", with the way out.
 *
 * `401` and `403` are different situations and the copy says so: one is a session
 * that ended, the other is an account that is not a passenger. A screen that
 * squashed them together would send a driver round a sign-in loop.
 */
export function ForbiddenState({ reason = "unauthenticated", action }) {
  const copy =
    reason === "driver"
      ? {
          title: "This is the passenger app",
          message: "You are signed in as a driver, which this client does not support yet.",
        }
      : {
          title: "Your session has ended",
          message: "Sign in again to continue where you left off.",
        };

  return <ErrorState title={copy.title} message={copy.message} action={action} />;
}
