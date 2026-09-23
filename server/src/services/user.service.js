import { prisma } from '../db/prisma.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SELECT = { id: true, name: true, email: true, createdAt: true };

/**
 * Prisma names the column `createdAt`; the users API has always returned
 * `created_at`. The wire shape is preserved here so switching the data layer
 * does not silently break existing consumers.
 */
const toRow = (user) => ({
  id: user.id,
  name: user.name,
  email: user.email,
  created_at: user.createdAt,
});

export const findAll = async () => {
  const users = await prisma.user.findMany({
    select: SELECT,
    orderBy: [{ createdAt: 'asc' }, { name: 'asc' }],
  });
  return users.map(toRow);
};

export const findById = async (id) => {
  // Avoid a database round-trip (and a cast error) for malformed ids.
  if (!UUID_RE.test(id)) return null;

  const user = await prisma.user.findUnique({ where: { id }, select: SELECT });
  return user ? toRow(user) : null;
};

export const findByEmail = async (email) => {
  // Case-insensitive match, replacing the previous `lower(email) = lower($1)`.
  const user = await prisma.user.findFirst({
    where: { email: { equals: email, mode: 'insensitive' } },
    select: SELECT,
  });
  return user ? toRow(user) : null;
};

export const create = async ({ name, email }) => {
  const user = await prisma.user.create({ data: { name, email }, select: SELECT });
  return toRow(user);
};
