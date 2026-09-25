/**
 * Presentation helpers: turning the API's exact, machine values into something a
 * person reads.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS MODULE DOES NOT DO
 * ---------------------------------------------------------------------------
 * It does **not** do arithmetic on money. The fare arrives as an exact decimal
 * string (`"130.63"`) and is displayed as it arrived; the only thing added here is
 * the currency, and a thousands separator at most. A client that added up the
 * fare components in floating point would disagree with the server by a paisa, and
 * the server is the one that is right.
 *
 * Unit conversion is not calculation in the same sense — turning 2214 metres into
 * "2.2 km" is presentation, and the API does the same thing itself for a quote
 * (`distanceKilometers`). Where the API has already formatted a value, prefer
 * theirs; these helpers exist for the DTOs that carry raw numbers, like the
 * current ride's route.
 */

/**
 * The clock these helpers print in, and why it is a constant.
 *
 * Two reasons, and both are about correctness rather than taste:
 *
 *  * **It is the product's clock.** A fare's rush-hour windows are defined in
 *    `Asia/Dhaka` (the server's traffic profile reads the Dhaka wall clock), so a
 *    screen that printed the *browser's* local time could show a departure at 18:40
 *    next to a rush-hour price, and be right about neither.
 *  * **It is the same on both sides of a hydration.** A tracker is rendered on the
 *    server and then re-rendered in the browser. `toLocaleTimeString` with no
 *    timezone uses the machine's, and with no locale uses the machine's — so a
 *    server in UTC and a browser in Dhaka would disagree, React would throw the
 *    server's HTML away and rebuild it, and the screen would flicker on every load.
 *    Pinning both makes the two renders identical.
 */
const SERVICE_TIMEZONE = "Asia/Dhaka";

/**
 * A fixed locale, for the same hydration reason: "en-GB" is 24-hour, so a time is
 * "19:47" on both sides rather than "7:47 PM" on one and "19:47" on the other.
 */
const TIME_LOCALE = "en-GB";

/**
 * A money amount, exactly as the API sent it.
 *
 * The amount is a string and stays one: `Number("130.63")` is a binary float, and
 * `toFixed(2)` on it is how a paisa goes missing. The currency is appended, or
 * returned alone when there is no amount.
 *
 * @param {string | null | undefined} amount
 * @param {string} [currency]
 */
export const formatMoney = (amount, currency = "BDT") => {
  if (amount === null || amount === undefined || amount === "") return "—";

  return `${amount} ${currency}`;
};

/** Metres as kilometres, with the precision a passenger can use. @param {number} meters */
export const formatDistance = (meters) => {
  if (typeof meters !== "number" || Number.isNaN(meters)) return "—";
  if (meters < 1000) return `${Math.round(meters)} m`;

  return `${(meters / 1000).toFixed(1)} km`;
};

/**
 * Seconds as a human duration.
 *
 * Rounded to whole minutes because "18 min" is what somebody plans with, and
 * anything finer is false precision for a journey measured by a traffic profile
 * that changes by the hour.
 *
 * @param {number} seconds
 */
export const formatDuration = (seconds) => {
  if (typeof seconds !== "number" || Number.isNaN(seconds)) return "—";

  const minutes = Math.round(seconds / 60);
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return `${minutes} min`;

  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;

  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
};

/**
 * An instant as a short time, on the product's clock.
 *
 * An absent instant is an em dash rather than "Invalid Date".
 *
 * @param {string | null | undefined} iso
 */
export const formatTime = (iso) => {
  if (!iso) return "—";

  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";

  return date.toLocaleTimeString(TIME_LOCALE, {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: SERVICE_TIMEZONE,
  });
};

/** `formatTime` with the date as well, for instants that are not today. */
export const formatDateTime = (iso) => {
  if (!iso) return "—";

  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";

  return date.toLocaleString(TIME_LOCALE, {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: SERVICE_TIMEZONE,
  });
};

/**
 * How long ago an instant was, in words.
 *
 * Used for "waiting since", where the passenger cares about duration rather than
 * clock time. Negative ages are clamped to "just now": a clock skew between the
 * browser and the server should not produce "in 3 seconds ago".
 *
 * ---------------------------------------------------------------------------
 * CLIENT-ONLY, AND IT HAS TO BE
 * ---------------------------------------------------------------------------
 * Unlike the two helpers above, this one depends on *when it is called* — so it
 * cannot be rendered on the server at all. A page rendered at 07:47:03 would say
 * "57 seconds ago" in the HTML and "58 seconds ago" a moment later in the browser,
 * and React throws that HTML away and rebuilds the tree. Pass an explicit `now`
 * from the client clock, and render an absolute time until you have one.
 *
 * @param {string | null | undefined} iso
 * @param {{ now: number }} options
 */
export const formatElapsed = (iso, { now }) => {
  if (!iso) return "—";

  const started = new Date(iso).getTime();
  if (Number.isNaN(started)) return "—";

  const seconds = Math.max(0, Math.round((now - started) / 1000));
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds} seconds ago`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return minutes === 1 ? "a minute ago" : `${minutes} minutes ago`;

  const hours = Math.floor(minutes / 60);
  return hours === 1 ? "an hour ago" : `${hours} hours ago`;
};
