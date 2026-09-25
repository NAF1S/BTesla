import Link from "next/link";

import { getHealth, getUsers } from "@/lib/api";
import { Heading, PageShell } from "@/components/ui";

export const dynamic = "force-dynamic";
export const metadata = { title: "API status — TeslaB" };

/**
 * The scaffold's demo page, kept and moved here.
 *
 * It used to be `/`, and it is the only screen in this client that answers the
 * question "is the API actually up?" — it names the health endpoint's status, the
 * database's, and lists the seeded accounts, which is also how you find an account
 * to sign in with. Deleting it to make room for the ride flow would have thrown
 * away the one page that explains a broken environment, so `/` became a redirect
 * and this content moved to `/status`.
 *
 * Nothing here is passenger-specific and nothing here is authenticated: it must
 * work when the session does, when it does not, and when the API is unreachable —
 * which is exactly when a person needs it.
 */
export default async function StatusPage() {
  let health = null;
  let users = [];
  let error = null;

  try {
    [health, users] = await Promise.all([getHealth(), getUsers()]);
  } catch (err) {
    error = err.message;
  }

  return (
    <PageShell>
      <Heading level={1} description="Next.js client talking to an Express API.">
        TeslaB
      </Heading>

      {error ? (
        <div className="mt-8 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200">
          <p className="font-medium">Could not load data from the API.</p>
          <p className="mt-1">{error}</p>
          <p className="mt-2">
            Make sure the database and API are running:{" "}
            <code className="font-mono">npm run db:up</code>, then{" "}
            <code className="font-mono">npm run dev</code>.
          </p>
        </div>
      ) : (
        <>
          <dl className="mt-8 grid gap-4 text-sm sm:grid-cols-3">
            <div className="rounded-lg border border-black/[.08] p-4 dark:border-white/[.145]">
              <dt className="text-zinc-500 dark:text-zinc-400">API status</dt>
              <dd className="mt-1 font-medium text-black dark:text-zinc-50">
                {health?.status ?? "unknown"}
              </dd>
            </div>
            <div className="rounded-lg border border-black/[.08] p-4 dark:border-white/[.145]">
              <dt className="text-zinc-500 dark:text-zinc-400">Database</dt>
              <dd
                className={`mt-1 font-medium ${
                  health?.database?.status === "up"
                    ? "text-emerald-600 dark:text-emerald-400"
                    : "text-red-600 dark:text-red-400"
                }`}
              >
                {health?.database?.status ?? "unknown"}
                {health?.database?.latencyMs != null && ` (${health.database.latencyMs}ms)`}
              </dd>
            </div>
            <div className="rounded-lg border border-black/[.08] p-4 dark:border-white/[.145]">
              <dt className="text-zinc-500 dark:text-zinc-400">Users</dt>
              <dd className="mt-1 font-medium text-black dark:text-zinc-50">{users.length}</dd>
            </div>
          </dl>

          <ul className="mt-6 divide-y divide-black/[.08] rounded-lg border border-black/[.08] dark:divide-white/[.145] dark:border-white/[.145]">
            {users.map((user) => (
              <li key={user.id} className="flex justify-between gap-4 px-4 py-3 text-sm">
                <span className="font-medium text-black dark:text-zinc-50">{user.name}</span>
                {/* `/users` is the legacy scaffold endpoint: id, name, email, created_at. */}
                <span className="text-zinc-500 dark:text-zinc-400">{user.email}</span>
              </li>
            ))}
          </ul>
        </>
      )}

      <p className="mt-8 text-sm text-zinc-600 dark:text-zinc-400">
        <Link href="/ride" className="underline underline-offset-4">
          Go to the ride screen
        </Link>
      </p>
    </PageShell>
  );
}
