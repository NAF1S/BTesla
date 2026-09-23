import bcrypt from 'bcryptjs';

import { env } from '../config/env.js';

/**
 * Password hashing.
 *
 * bcryptjs implements the bcrypt adaptive hash in pure JavaScript -- the
 * algorithm is never hand-rolled here, and no password is ever stored, logged
 * or returned in a reversible form. The work factor comes from BCRYPT_COST and
 * defaults to bcrypt's conventional 10.
 *
 * Note: bcrypt ignores input beyond 72 bytes. Callers reject longer passwords
 * (see utils/validation.js) rather than letting them be silently truncated.
 */

const COST = env.bcryptCost;

export const hashPassword = async (plainPassword) => {
  const salt = await bcrypt.genSalt(COST);
  return bcrypt.hash(plainPassword, salt);
};

/**
 * A hash to compare against when there is nothing to compare against.
 *
 * Without it, a login for an unknown identifier would return faster than a
 * login with the wrong password, which leaks whether an account exists. The
 * value is a fixed dummy string, computed once and cached; it is not a secret
 * and never belongs to a user.
 */
let timingEqualisingHash = null;
const dummyHash = () => {
  timingEqualisingHash ??= hashPassword('timing-equalising-placeholder');
  return timingEqualisingHash;
};

/**
 * Verifies a password against a stored hash.
 *
 * Never throws and never reveals why it failed: a missing hash (an account
 * with no credentials), a malformed hash and a wrong password all produce
 * `false`, so callers have exactly one failure path to handle.
 */
export const verifyPassword = async (plainPassword, passwordHash) => {
  if (typeof plainPassword !== 'string' || plainPassword === '') return false;

  if (!passwordHash) {
    await bcrypt.compare(plainPassword, await dummyHash());
    return false;
  }

  try {
    return await bcrypt.compare(plainPassword, passwordHash);
  } catch {
    return false;
  }
};
