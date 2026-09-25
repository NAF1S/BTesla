/**
 * The base fetch wrapper every API call goes through.
 *
 * ---------------------------------------------------------------------------
 * TWO BASE URLS, AND WHY
 * ---------------------------------------------------------------------------
 * A **browser** request uses `NEXT_PUBLIC_API_URL`, which is empty by default so
 * the request goes to the same origin and the rewrite in `next.config.mjs`
 * proxies `/api/*` to Express. That is what makes the HttpOnly auth cookie work
 * without CORS: the browser talks to the Next server, and Next forwards.
 *
 * A **server** request (a Server Component, the session guard) cannot use a
 * relative URL, so it uses `API_URL` and forwards the incoming cookie by hand —
 * see `session.js`.
 *
 * ---------------------------------------------------------------------------
 * WHY THE STATUS CODE IS KEPT
 * ---------------------------------------------------------------------------
 * The API's error shape is `{ error: { message } }`, and the message is written
 * for a person. But the *status* is what the UI branches on: `401` means "your
 * session ended, sign in again", `403` means "this account is not a passenger",
 * `404` means "not found, or not yours", `409` means "the state moved on — re-read
 * it". Collapsing all of those into a message loses exactly the information a
 * screen needs, so `ApiError` carries both.
 */

const CLIENT_BASE = process.env.NEXT_PUBLIC_API_URL ?? "";
const SERVER_BASE = process.env.API_URL ?? "http://localhost:4000";

/** True while running in a browser. */
export const isBrowser = () => typeof window !== "undefined";

const baseUrl = () => (isBrowser() ? CLIENT_BASE : SERVER_BASE);

/**
 * An API failure, with the status the UI branches on.
 *
 * `network` is set when the request never reached the API at all — a distinct
 * situation with a distinct message ("is the server running?" rather than
 * "something went wrong"), and a common one in this project because the API is a
 * separate process.
 */
export class ApiError extends Error {
  constructor(message, { status = 0, details = null, network = false } = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.details = details;
    this.network = network;
  }

  /** No valid session: the caller should be sent to the sign-in screen. */
  get isUnauthenticated() {
    return this.status === 401;
  }

  /** Authenticated, but this account may not use the endpoint. */
  get isForbidden() {
    return this.status === 403;
  }

  /** Not found — or not the caller's, which the API deliberately makes the same. */
  get isNotFound() {
    return this.status === 404;
  }

  /** The state moved on. Re-read rather than retrying blindly. */
  get isConflict() {
    return this.status === 409;
  }
}

/**
 * Parses a response body, tolerating the shapes the API uses.
 *
 * A list answers `{ data: [...] }`; a single resource answers the object itself;
 * a 204 has no body at all. Unwrapping here means a caller never has to know which
 * of the three it got.
 */
const readBody = async (response) => {
  if (response.status === 204) return null;

  const text = await response.text();
  if (!text) return null;

  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && "data" in parsed ? parsed.data : parsed;
  } catch {
    // A non-JSON body from a proxy, a crash page, or a truncated response. The
    // status is still meaningful, so it becomes an error with no message rather
    // than a parse failure the caller cannot act on.
    return null;
  }
};

/**
 * `apiFetch("/location/zones")` -> the zones array.
 *
 * Throws `ApiError` for every non-2xx, so a caller can `try/catch` and read
 * `err.status` rather than checking a response object. There is no "returns
 * either" shape here: a failure is always an exception.
 */
export async function apiFetch(path, init = {}) {
  const { cookie, ...rest } = init;

  let response;
  try {
    response = await fetch(`${baseUrl()}/api${path}`, {
      cache: "no-store",
      // `include`, not the default. The session is an HttpOnly cookie, and while a
      // same-origin request sends it either way, being explicit means the client
      // still works if `NEXT_PUBLIC_API_URL` points at the API directly.
      credentials: "include",
      ...rest,
      headers: {
        "Content-Type": "application/json",
        ...(cookie ? { cookie } : {}),
        ...rest.headers,
      },
    });
  } catch {
    throw new ApiError(
      "Could not reach the API. Is it running? (npm run db:up, then npm run dev)",
      { network: true },
    );
  }

  const body = await readBody(response);

  if (!response.ok) {
    throw new ApiError(body?.error?.message ?? `Request failed with ${response.status}`, {
      status: response.status,
      details: body?.error?.details ?? null,
    });
  }

  return body;
}

/** A POST with a JSON body. The common case, spelled once. */
export const apiPost = (path, body, init = {}) =>
  apiFetch(path, { method: "POST", body: JSON.stringify(body ?? {}), ...init });

/** A PATCH with a JSON body. */
export const apiPatch = (path, body, init = {}) =>
  apiFetch(path, { method: "PATCH", body: JSON.stringify(body ?? {}), ...init });

export const getHealth = () => apiFetch("/health");
export const getUsers = () => apiFetch("/users");
export const getUser = (id) => apiFetch(`/users/${id}`);
export const createUser = (user) => apiPost("/users", user);
