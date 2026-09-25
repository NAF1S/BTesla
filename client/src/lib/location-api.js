import { apiFetch } from "./api";

/**
 * Where the places are.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT IN passenger-api.js
 * ---------------------------------------------------------------------------
 * Service areas and service points are **public, global reference data** — the
 * API serves them without a session, and both halves of the product are built on
 * them. A passenger picks two to travel between; a driver picks one to come online
 * at, because the dispatcher routes from a service point and a driver with no
 * point can never be a candidate.
 *
 * So this belongs to neither role. It sits beside `auth-api.js` for the same
 * reason: role-independent facts, in a module named for what it is rather than for
 * who happens to use it first.
 *
 * These are the only endpoints in the client that work before sign-in.
 */

/**
 * Every active service area, for grouping the location dropdowns.
 *
 * @returns {Promise<import("./types").Zone[]>}
 */
export const listZones = () => apiFetch("/location/zones");

/**
 * Every active service point, optionally narrowed to one zone.
 *
 * The full list is a few hundred small rows and is what both a passenger's
 * dropdown and a driver's "where am I" selector are built from. Narrowing by zone
 * is a courtesy, not a requirement.
 *
 * @param {{ zoneCode?: string }} [options]
 * @returns {Promise<import("./types").ServicePoint[]>}
 */
export const listServicePoints = ({ zoneCode } = {}) =>
  apiFetch(`/location/points${zoneCode ? `?zoneCode=${encodeURIComponent(zoneCode)}` : ""}`);
