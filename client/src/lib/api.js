/**
 * Thin fetch wrapper around the Express API.
 *
 * - In the browser: uses NEXT_PUBLIC_API_URL, which is empty by default so
 *   requests go to the same origin and Next.js proxies /api/* to Express.
 * - On the server: uses API_URL because relative URLs are not fetchable.
 */
const CLIENT_BASE = process.env.NEXT_PUBLIC_API_URL ?? "";
const SERVER_BASE = process.env.API_URL ?? "http://localhost:4000";

const baseUrl = typeof window === "undefined" ? SERVER_BASE : CLIENT_BASE;

export async function apiFetch(path, init = {}) {
  const res = await fetch(`${baseUrl}/api${path}`, {
    cache: "no-store",
    ...init,
    headers: { "Content-Type": "application/json", ...init.headers },
  });

  const body = await res.json().catch(() => null);

  if (!res.ok) {
    throw new Error(body?.error?.message ?? `Request failed with ${res.status}`);
  }

  return body?.data ?? body;
}

export const getHealth = () => apiFetch("/health");
export const getUsers = () => apiFetch("/users");
export const getUser = (id) => apiFetch(`/users/${id}`);
export const createUser = (user) =>
  apiFetch("/users", { method: "POST", body: JSON.stringify(user) });
