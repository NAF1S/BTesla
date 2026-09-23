-- Authentication, roles and role-specific profiles. Safe to run repeatedly.
--
-- This file remains the source of truth for the physical schema; Prisma only
-- describes it (see README "ORM (Prisma)"). Role and driver status use real
-- PostgreSQL enums, which Prisma maps onto the `Role` and `DriverStatus`
-- enums in server/prisma/schema.prisma.
--
-- Deletion policy: profiles and vehicles are `ON DELETE CASCADE`, so removing a
-- user can never leave behind a profile (or a vehicle) that points at nothing.
-- A profile is meaningless without its user, and a vehicle is meaningless
-- without its driver, so cascading is the correct semantics here rather than
-- blocking the delete.

-- ---------------------------------------------------------------------------
-- 1. Enums
-- PostgreSQL has no CREATE TYPE IF NOT EXISTS, so this is guarded by catalog.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'user_role') THEN
    CREATE TYPE user_role AS ENUM ('PASSENGER', 'DRIVER', 'ADMIN');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'driver_status') THEN
    CREATE TYPE driver_status AS ENUM ('OFFLINE', 'AVAILABLE', 'ON_RIDE');
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. users
--
-- password_hash is nullable on purpose: rows created before this migration
-- (for example the sample users in 02-seed.sql) have no credentials. A NULL
-- hash can never authenticate, so these users simply cannot log in rather than
-- being deleted or given a fake password.
--
-- The default role is PASSENGER, so a client can never obtain ADMIN by
-- omitting a field -- only an explicit, privileged assignment can do that.
-- ---------------------------------------------------------------------------
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS password_hash TEXT,
  ADD COLUMN IF NOT EXISTS role          user_role   NOT NULL DEFAULT 'PASSENGER',
  ADD COLUMN IF NOT EXISTS active        BOOLEAN     NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS updated_at    TIMESTAMPTZ NOT NULL DEFAULT now();

-- The login identifier is the email, normalised to lower case by the
-- application. A UNIQUE index on lower(email) makes case-variant duplicates
-- impossible even for a direct SQL writer, which the plain UNIQUE on email
-- does not prevent. Refuse loudly rather than silently dropping data if such
-- duplicates already exist.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM users GROUP BY lower(email) HAVING count(*) > 1) THEN
    RAISE EXCEPTION
      'users contains emails differing only by case; resolve them before applying 04-auth.sql';
  END IF;
END $$;

-- Replaces the non-unique users_email_idx declared in 01-schema.sql.
DROP INDEX IF EXISTS users_email_idx;
CREATE UNIQUE INDEX IF NOT EXISTS users_email_idx ON users (lower(email));

CREATE INDEX IF NOT EXISTS users_role_idx ON users (role);

-- ---------------------------------------------------------------------------
-- 3. Role-specific profiles
--
-- user_id is UNIQUE, so "at most one passenger profile" and "at most one
-- driver profile" are enforced by the database and not only by the service.
--
-- Which profile a user *should* have for their role cannot be expressed as a
-- foreign key, so that rule is validated in the application service
-- (server/src/services/user.service.js) and covered by tests.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS passenger_profiles (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID        NOT NULL UNIQUE REFERENCES users (id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS driver_profiles (
  id         UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID          NOT NULL UNIQUE REFERENCES users (id) ON DELETE CASCADE,
  status     driver_status NOT NULL DEFAULT 'OFFLINE',
  created_at TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ   NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- 4. Vehicles
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS vehicles (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id     UUID        NOT NULL REFERENCES driver_profiles (id) ON DELETE CASCADE,
  name          TEXT        NOT NULL CHECK (btrim(name) <> ''),
  seat_capacity INTEGER     NOT NULL CHECK (seat_capacity > 0),
  active        BOOLEAN     NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS vehicles_driver_id_idx ON vehicles (driver_id);

-- A driver cannot register the same vehicle name twice, which is also what
-- makes the demo seed's vehicle upsert deterministic.
CREATE UNIQUE INDEX IF NOT EXISTS vehicles_driver_name_key ON vehicles (driver_id, lower(btrim(name)));

-- ---------------------------------------------------------------------------
-- 5. Backfill profiles for users that predate roles
--
-- Rows created before this migration picked up the default PASSENGER role, so
-- without this they would be passengers with no passenger profile -- precisely
-- the state the application must never leave behind. Idempotent, and it only
-- ever adds a missing profile.
-- ---------------------------------------------------------------------------
INSERT INTO passenger_profiles (user_id)
SELECT id FROM users WHERE role = 'PASSENGER'
ON CONFLICT (user_id) DO NOTHING;

INSERT INTO driver_profiles (user_id)
SELECT id FROM users WHERE role = 'DRIVER'
ON CONFLICT (user_id) DO NOTHING;
