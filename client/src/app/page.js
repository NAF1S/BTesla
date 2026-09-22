import { getHealth, getUsers } from "@/lib/api";

export const dynamic = "force-dynamic";

export default async function Home() {
  let health = null;
  let users = [];
  let error = null;

  try {
    [health, users] = await Promise.all([getHealth(), getUsers()]);
  } catch (err) {
    error = err.message;
  }

  return (
    <div className="flex flex-1 justify-center bg-zinc-50 font-sans dark:bg-black">
      <main className="w-full max-w-3xl px-8 py-24">
        <h1 className="text-3xl font-semibold tracking-tight text-black dark:text-zinc-50">
          TeslaB
        </h1>
        <p className="mt-2 text-zinc-600 dark:text-zinc-400">
          Next.js client talking to an Express API.
        </p>

        {error ? (
          <div className="mt-8 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200">
            <p className="font-medium">Could not reach the API.</p>
            <p className="mt-1">{error}</p>
            <p className="mt-2">
              Start it with <code className="font-mono">npm run dev:server</code>.
            </p>
          </div>
        ) : (
          <>
            <dl className="mt-8 grid grid-cols-2 gap-4 text-sm">
              <div className="rounded-lg border border-black/[.08] p-4 dark:border-white/[.145]">
                <dt className="text-zinc-500 dark:text-zinc-400">API status</dt>
                <dd className="mt-1 font-medium text-black dark:text-zinc-50">
                  {health?.status ?? "unknown"}
                </dd>
              </div>
              <div className="rounded-lg border border-black/[.08] p-4 dark:border-white/[.145]">
                <dt className="text-zinc-500 dark:text-zinc-400">Users</dt>
                <dd className="mt-1 font-medium text-black dark:text-zinc-50">
                  {users.length}
                </dd>
              </div>
            </dl>

            <ul className="mt-6 divide-y divide-black/[.08] rounded-lg border border-black/[.08] dark:divide-white/[.145] dark:border-white/[.145]">
              {users.map((user) => (
                <li key={user.id} className="flex justify-between px-4 py-3 text-sm">
                  <span className="font-medium text-black dark:text-zinc-50">
                    {user.name}
                  </span>
                  <span className="text-zinc-500 dark:text-zinc-400">{user.email}</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </main>
    </div>
  );
}
