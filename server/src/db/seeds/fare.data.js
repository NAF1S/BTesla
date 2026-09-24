/**
 * Demo solo-fare pricing policies.
 *
 * ---------------------------------------------------------------------------
 * DEMO CONFIGURATION -- NOT OFFICIAL TRANSPORT PRICING
 * ---------------------------------------------------------------------------
 * These numbers are invented to make the fare pipeline demonstrable and
 * testable. They are not Dhaka taxi, rickshaw, ride-share or regulatory rates,
 * and nothing here should be quoted to anybody as a real price. Edit this file
 * to review or change the whole pricing surface, then re-run `npm run db:seed`.
 *
 * ---------------------------------------------------------------------------
 * MONEY IS ALWAYS A STRING HERE
 * ---------------------------------------------------------------------------
 * Every monetary value and multiplier is written as a decimal *string* --
 * '40.00', not 40.00 -- because a JavaScript number is binary floating point and
 * `0.1 + 0.2` is not `0.3`. Strings are parsed exactly by decimal.js, so what the
 * seed says is what the database stores. The only numbers in this file are
 * counts (the TTL and the rounding scale), which are integers.
 *
 * ---------------------------------------------------------------------------
 * VERSIONING
 * ---------------------------------------------------------------------------
 * `(code, version)` identifies a policy. Never edit the rates of a version that
 * has been quoted -- the database refuses it, because a quote must stay
 * explainable. Change the price by adding a *new* version with a later
 * `effectiveFrom`, and optionally close the previous one by setting its
 * `effectiveTo` to the same instant. The seeder only ever writes a version it
 * owns and never touches one that quotes already reference.
 */

/** Fixed instant so the seed is reproducible; not "now". */
const RETAIL_FROM = '2020-01-01T00:00:00.000Z';

/**
 * The one active development policy.
 *
 * `normalTrafficMultiplier` is 1.00 on purpose: off-peak traffic is the baseline
 * the base/per-kilometre/per-minute rates already describe, so there is exactly
 * one traffic adjustment in the formula rather than a hidden second one.
 */
export const FARE_POLICIES = [
  {
    code: 'dhaka-solo',
    version: 1,
    name: 'Dhaka solo fare (demo)',
    currency: 'BDT',
    baseFare: '40.00',
    perKilometerRate: '18.00',
    perMinuteRate: '2.00',
    minimumFare: '80.00',
    normalTrafficMultiplier: '1.0000',
    rushHourMultiplier: '1.1000',
    quoteTtlSeconds: 300,
    roundingScale: 2,
    effectiveFrom: RETAIL_FROM,
    effectiveTo: null,
    active: true,
  },
];
