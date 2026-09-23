import { query } from '../db/pool.js';

const COLUMNS = 'id, name, email, created_at';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const findAll = async () => {
  const { rows } = await query(`SELECT ${COLUMNS} FROM users ORDER BY created_at, name`);
  return rows;
};

export const findById = async (id) => {
  // Avoid a Postgres cast error (and a round-trip) for malformed ids.
  if (!UUID_RE.test(id)) return null;

  const { rows } = await query(`SELECT ${COLUMNS} FROM users WHERE id = $1`, [id]);
  return rows[0] ?? null;
};

export const findByEmail = async (email) => {
  const { rows } = await query(`SELECT ${COLUMNS} FROM users WHERE lower(email) = lower($1)`, [email]);
  return rows[0] ?? null;
};

export const create = async ({ name, email }) => {
  const { rows } = await query(
    `INSERT INTO users (name, email) VALUES ($1, $2) RETURNING ${COLUMNS}`,
    [name, email],
  );
  return rows[0];
};
