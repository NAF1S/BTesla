-- TeslaB schema. Safe to run repeatedly.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL,
  email      TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- UNIQUE because the email is the login identifier and is normalised to lower
-- case by the application; this stops case-variant duplicates at the database
-- level. Databases created before 04-auth.sql declared it non-unique are
-- upgraded by that file.
CREATE UNIQUE INDEX IF NOT EXISTS users_email_idx ON users (lower(email));
