/**
 * Time-of-day helpers behind the routing traffic profiles.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * An edge carries a normal duration and a rush-hour duration, and a route
 * estimate has to pick one. Which of the two applies depends on what the
 * *local* clock reads in Dhaka when the passenger departs, so departure
 * instants have to be converted into Asia/Dhaka wall-clock time.
 *
 * Rules this module implements, and the rest of the codebase relies on:
 *
 *   * an instant is always stored and transported as UTC (a `Date`, or an ISO
 *     8601 string with an explicit offset). The zone below is used *only* to
 *     answer "is it rush hour in Dhaka?", never to store a local time;
 *   * a window is half-open: it starts at <start> and ends at <end>, where the
 *     start minute counts as rush hour and the end minute does not. So with
 *     `07:30-10:30`, 07:30 is rush hour and 10:30 is not;
 *   * a window whose end is not after its start wraps past midnight, which lets
 *     a night-time window be configured as e.g. `22:00-02:00`;
 *   * the whole route is estimated with a single profile, chosen from its
 *     departure instant. A journey that starts at 10:29 is estimated entirely
 *     with rush-hour costs even though it crosses 10:30 -- see the README.
 *
 * Asia/Dhaka has no daylight saving, so the offset is a constant +06:00 today.
 * The conversion still goes through Intl rather than a hard-coded offset, so
 * that a rule change does not silently produce wrong answers.
 */

/** The only zone used to decide a traffic profile. */
export const DHAKA_TIME_ZONE = 'Asia/Dhaka';

export const TRAFFIC_PROFILE = Object.freeze({
  NORMAL: 'NORMAL',
  RUSH_HOUR: 'RUSH_HOUR',
});

/**
 * Demo morning and evening peaks, used when RUSH_HOUR_WINDOWS is not set.
 * These are plausible demo windows, not measured Dhaka traffic data.
 */
export const DEFAULT_RUSH_HOUR_WINDOWS = '07:30-10:30,16:30-20:00';

// Minutes-of-day bounds, allowing "7:30" as well as "07:30".
const TIME_OF_DAY = /^([01]?\d|2[0-3]):([0-5]\d)$/;

const toMinutes = (text) => {
  const match = TIME_OF_DAY.exec(text.trim());
  if (!match) {
    throw new Error(`"${text}" is not a time of day in 24-hour HH:MM form`);
  }
  return Number(match[1]) * 60 + Number(match[2]);
};

/**
 * Parses a comma-separated window list such as "07:30-10:30,16:30-20:00" into
 * minutes-of-day pairs.
 *
 * Throws on a malformed specification. This is configuration, so a typo must
 * fail loudly when the process starts rather than quietly routing every request
 * with the wrong costs.
 */
export const parseRushHourWindows = (spec = DEFAULT_RUSH_HOUR_WINDOWS) => {
  if (typeof spec !== 'string' || spec.trim() === '') {
    throw new Error('RUSH_HOUR_WINDOWS must be a non-empty "HH:MM-HH:MM[,HH:MM-HH:MM]" list');
  }

  const windows = spec
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
    .map((entry) => {
      const bounds = entry.split('-');
      if (bounds.length !== 2) {
        throw new Error(`rush-hour window "${entry}" must be written as HH:MM-HH:MM`);
      }
      const [startMinutes, endMinutes] = bounds.map(toMinutes);
      if (startMinutes === endMinutes) {
        throw new Error(`rush-hour window "${entry}" is empty (start and end are the same minute)`);
      }
      return { startMinutes, endMinutes };
    });

  if (windows.length === 0) {
    throw new Error('RUSH_HOUR_WINDOWS must contain at least one HH:MM-HH:MM window');
  }

  return Object.freeze(windows);
};

// Intl formatters are comparatively expensive to build, and one request builds
// none of them more than once.
const formatters = new Map();

const formatterFor = (timeZone) => {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hourCycle: 'h23',
      hour: '2-digit',
      minute: '2-digit',
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
};

/** The wall-clock time in `timeZone` at `instant`, as minutes since midnight. */
export const minutesSinceMidnightIn = (instant, timeZone = DHAKA_TIME_ZONE) => {
  const parts = formatterFor(timeZone).formatToParts(instant);
  const read = (type) => parts.find((part) => part.type === type)?.value;
  const hour = Number(read('hour'));
  const minute = Number(read('minute'));

  if (!Number.isInteger(hour) || !Number.isInteger(minute)) {
    throw new Error(`could not resolve the local time in ${timeZone}`);
  }

  // Defensive: some ICU builds report midnight as "24" even for h23.
  return (hour % 24) * 60 + minute;
};

/**
 * True when the instant falls inside any window, evaluated in `timeZone`.
 *
 * Windows are half-open -- [start, end) -- and a window whose end is not after
 * its start wraps around midnight.
 */
export const isWithinRushHour = (
  instant,
  windows = parseRushHourWindows(DEFAULT_RUSH_HOUR_WINDOWS),
  timeZone = DHAKA_TIME_ZONE,
) => {
  const minutes = minutesSinceMidnightIn(instant, timeZone);

  return windows.some(({ startMinutes, endMinutes }) =>
    startMinutes <= endMinutes
      ? minutes >= startMinutes && minutes < endMinutes
      : minutes >= startMinutes || minutes < endMinutes,
  );
};

/** The single traffic profile a route is estimated with. */
export const resolveTrafficProfile = (
  instant,
  windows = parseRushHourWindows(DEFAULT_RUSH_HOUR_WINDOWS),
  timeZone = DHAKA_TIME_ZONE,
) =>
  isWithinRushHour(instant, windows, timeZone)
    ? TRAFFIC_PROFILE.RUSH_HOUR
    : TRAFFIC_PROFILE.NORMAL;
