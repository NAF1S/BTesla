/**
 * Demo cast for the ride-pooling MVP.
 *
 * ---------------------------------------------------------------------------
 * DEVELOPMENT / DEMO DATA ONLY -- NOT FOR PRODUCTION
 * ---------------------------------------------------------------------------
 * No password is stored in this file. Every demo account is given the password
 * from DEMO_SEED_PASSWORD, hashed before it reaches the database. The seeder
 * refuses to run when NODE_ENV=production unless ALLOW_DEMO_SEED=true, and then
 * requires DEMO_SEED_PASSWORD to be set explicitly, so no built-in credential
 * can ever reach a production database.
 *
 * Identifiers follow the email convention already used by 02-seed.sql.
 */

/** Nusrat, Rafiq and Shirin are passengers; Jashim is their driver. */
export const seedUsers = [
  { name: 'Nusrat', email: 'nusrat@example.com', role: 'PASSENGER' },
  { name: 'Rafiq', email: 'rafiq@example.com', role: 'PASSENGER' },
  { name: 'Shirin', email: 'shirin@example.com', role: 'PASSENGER' },
  { name: 'Jashim', email: 'jashim@example.com', role: 'DRIVER' },
];

/** Jashim's three-seat electric vehicle. */
export const seedVehicles = [
  { driverEmail: 'jashim@example.com', name: 'Bullet', seatCapacity: 3, active: true },
];
