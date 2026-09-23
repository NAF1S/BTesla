import '../helpers/test-env.js';

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { env } from '../../src/config/env.js';
import { prisma } from '../../src/db/prisma.js';
import { createWithProfile } from '../../src/services/user.service.js';
import { hashPassword, verifyPassword } from '../../src/utils/password.js';
import { MIN_PASSWORD_LENGTH } from '../../src/utils/validation.js';
import { startApiServer } from '../helpers/api-server.js';
import { closePool, prepareDatabase } from '../helpers/db.js';

/**
 * End-to-end authentication tests, driven through the real Express app over
 * HTTP against the real PostgreSQL database.
 *
 * Requirements: `npm run db:up` (PostgreSQL reachable via DATABASE_URL). The
 * suite applies server/db/*.sql and both seeds itself, then creates its own
 * accounts so the demo cast is never mutated, and removes them afterwards.
 */

const DEMO_PASSWORD = env.demoSeedPassword;
const TEST_PASSWORD = 'TestPass123!';

const TEST_EMAILS = {
  admin: 'test-admin@example.com',
  driver: 'test-driver@example.com',
  passenger: 'test-passenger@example.com',
  inactive: 'test-inactive@example.com',
};

let api;

const post = (path, body, cookie) =>
  api.request(path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(cookie ? { cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const get = (path, cookie) => api.request(path, { headers: cookie ? { cookie } : {} });

/** Logs in and returns the cookie the API issued, ready to replay. */
const login = async (email, password = DEMO_PASSWORD) => {
  const res = await post('/auth/login', { email, password });
  return { ...res, cookie: res.setCookie ? res.setCookie.split(';')[0] : null };
};

const readLastLoginAt = async (email) => {
  const user = await prisma.user.findUnique({ where: { email }, select: { lastLoginAt: true } });
  return user.lastLoginAt;
};

/** Accounts created by the sign-up tests, cleaned up by their email domain. */
const SIGNUP_EMAIL_DOMAIN = '@signup.example.com';

const clearSignupAccounts = () =>
  prisma.user.deleteMany({ where: { email: { endsWith: SIGNUP_EMAIL_DOMAIN } } });

before(async () => {
  await prepareDatabase();

  // Make the suite re-runnable even if a previous run was interrupted.
  await prisma.user.deleteMany({ where: { email: { in: Object.values(TEST_EMAILS) } } });
  await clearSignupAccounts();

  const passwordHash = await hashPassword(TEST_PASSWORD);
  await createWithProfile({ name: 'Test Admin', email: TEST_EMAILS.admin, passwordHash, role: 'ADMIN' });
  await createWithProfile({ name: 'Test Driver', email: TEST_EMAILS.driver, passwordHash, role: 'DRIVER' });
  await createWithProfile({ name: 'Test Passenger', email: TEST_EMAILS.passenger, passwordHash, role: 'PASSENGER' });
  await createWithProfile({ name: 'Test Inactive', email: TEST_EMAILS.inactive, passwordHash, role: 'PASSENGER' });

  await prisma.user.update({ where: { email: TEST_EMAILS.inactive }, data: { active: false } });

  api = await startApiServer();
});

after(async () => {
  await prisma.user.deleteMany({ where: { email: { in: Object.values(TEST_EMAILS) } } });
  await clearSignupAccounts();
  await api?.close();
  await closePool();
});

describe('POST /auth/login', () => {
  it('logs Nusrat in with the demo credentials', async () => {
    const { status, body, cookie } = await login('nusrat@example.com');

    assert.strictEqual(status, 200);
    assert.strictEqual(body.user.name, 'Nusrat');
    assert.strictEqual(body.user.role, 'PASSENGER');
    assert.strictEqual(body.user.active, true);
    assert.ok(body.user.passengerProfile?.id, 'expected a passenger profile id');
    assert.ok(cookie, 'expected an authentication cookie to be issued');
  });

  it('logs Jashim in and returns DRIVER information with his vehicle', async () => {
    const { status, body } = await login('jashim@example.com');

    assert.strictEqual(status, 200);
    assert.strictEqual(body.user.role, 'DRIVER');
    assert.ok(body.user.driverProfile?.id, 'expected a driver profile id');
    assert.ok(!('passengerProfile' in body.user), 'a driver must not be given a passenger profile');

    // Bullet belongs to Jashim and has exactly three seats.
    assert.strictEqual(body.user.driverProfile.vehicles.length, 1);
    assert.strictEqual(body.user.driverProfile.vehicles[0].name, 'Bullet');
    assert.strictEqual(body.user.driverProfile.vehicles[0].seatCapacity, 3);
  });

  it('normalises the login identifier, so case and padding do not matter', async () => {
    const { status, body } = await login('  NUSRAT@Example.COM ');

    assert.strictEqual(status, 200);
    assert.strictEqual(body.user.name, 'Nusrat');
  });

  it('returns one identical generic error for a wrong password and an unknown account', async () => {
    const wrongPassword = await post('/auth/login', {
      email: 'nusrat@example.com',
      password: 'definitely-not-it',
    });
    const unknownAccount = await post('/auth/login', {
      email: 'nobody@example.com',
      password: DEMO_PASSWORD,
    });

    assert.strictEqual(wrongPassword.status, 401);
    assert.strictEqual(unknownAccount.status, 401);
    assert.deepStrictEqual(
      wrongPassword.body,
      unknownAccount.body,
      'a wrong password and an unknown account must be indistinguishable',
    );
    assert.match(wrongPassword.body.error.message, /invalid email or password/i);
  });

  it('rejects an inactive account with the same generic error', async () => {
    const { status, body } = await post('/auth/login', {
      email: TEST_EMAILS.inactive,
      password: TEST_PASSWORD,
    });

    assert.strictEqual(status, 401);
    assert.match(body.error.message, /invalid email or password/i);
  });

  it('rejects malformed requests without echoing the password', async () => {
    const secret = 'SuperSecret1!';
    const cases = [
      [{ password: secret }, /email is required/],
      [{ email: 'not-an-email', password: secret }, /valid email/],
      [{ email: 'nusrat@example.com' }, /password is required/],
    ];

    for (const [body, pattern] of cases) {
      const res = await post('/auth/login', body);

      assert.strictEqual(res.status, 400);
      assert.match(res.body.error.message, pattern);
      assert.ok(
        !JSON.stringify(res.body).includes(secret),
        'a validation error must never echo the submitted password',
      );
    }
  });

  it('rejects body fields it does not accept', async () => {
    const res = await post('/auth/login', {
      email: 'nusrat@example.com',
      password: DEMO_PASSWORD,
      role: 'ADMIN',
    });

    assert.strictEqual(res.status, 400);
    assert.match(res.body.error.message, /Unsupported body field/);
  });

  it('does not record a login before it succeeds', async () => {
    const email = TEST_EMAILS.passenger;
    await prisma.user.update({ where: { email }, data: { lastLoginAt: null } });

    const failed = await post('/auth/login', { email, password: 'wrong-password' });
    assert.strictEqual(failed.status, 401);
    assert.strictEqual(await readLastLoginAt(email), null, 'a failed login must not move lastLoginAt');

    const succeeded = await post('/auth/login', { email, password: TEST_PASSWORD });
    assert.strictEqual(succeeded.status, 200);
    assert.ok(await readLastLoginAt(email), 'a successful login must record lastLoginAt');
  });
});

describe('GET /auth/me', () => {
  it('rejects an unauthenticated request', async () => {
    const res = await get('/auth/me');

    assert.strictEqual(res.status, 401);
    assert.ok(res.body.error.message);
  });

  it('rejects a malformed, tampered or foreign cookie', async () => {
    const cookies = [
      'teslab_auth=not-a-jwt',
      'teslab_auth=eyJhbGciOiJIUzI1NiJ9.e30.tampered',
      'teslab_auth=',
      'something_else=abc',
    ];

    for (const cookie of cookies) {
      const res = await get('/auth/me', cookie);
      assert.strictEqual(res.status, 401, `expected 401 for cookie "${cookie}"`);
    }
  });

  it('returns the authenticated user', async () => {
    const { cookie, body: loginBody } = await login('nusrat@example.com');
    const res = await get('/auth/me', cookie);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.user.name, 'Nusrat');
    assert.strictEqual(res.body.user.role, 'PASSENGER');
    assert.strictEqual(res.body.user.id, loginBody.user.id);
    assert.ok(res.body.user.passengerProfile?.id);
  });

  it('never returns a password hash', async () => {
    const { cookie, body: loginBody } = await login('jashim@example.com');
    const me = await get('/auth/me', cookie);

    for (const payload of [loginBody, me.body]) {
      const serialised = JSON.stringify(payload);

      assert.ok(!/passwordHash|password_hash|"password"/.test(serialised), 'a password field leaked');
      assert.ok(!serialised.includes('$2b$'), 'a bcrypt hash leaked');
    }
  });

  it('rejects a user deactivated after their token was issued', async () => {
    const { cookie } = await login(TEST_EMAILS.passenger, TEST_PASSWORD);
    assert.strictEqual((await get('/auth/me', cookie)).status, 200);

    await prisma.user.update({ where: { email: TEST_EMAILS.passenger }, data: { active: false } });
    try {
      const res = await get('/auth/me', cookie);
      assert.strictEqual(res.status, 401, 'an inactive user must be rejected despite a valid token');
    } finally {
      await prisma.user.update({ where: { email: TEST_EMAILS.passenger }, data: { active: true } });
    }
  });

  it('rejects a user deleted after their token was issued', async () => {
    const email = 'test-deleted@example.com';
    await prisma.user.deleteMany({ where: { email } });
    const passwordHash = await hashPassword(TEST_PASSWORD);
    await createWithProfile({ name: 'Test Deleted', email, passwordHash, role: 'PASSENGER' });

    const { cookie } = await login(email, TEST_PASSWORD);
    assert.strictEqual((await get('/auth/me', cookie)).status, 200);

    await prisma.user.deleteMany({ where: { email } });
    assert.strictEqual((await get('/auth/me', cookie)).status, 401);
  });
});

describe('POST /auth/logout', () => {
  it('clears the authentication state and is safe to retry', async () => {
    const { cookie } = await login('nusrat@example.com');
    assert.strictEqual((await get('/auth/me', cookie)).status, 200);

    const cleared = await post('/auth/logout', undefined, cookie);

    assert.strictEqual(cleared.status, 204);
    assert.match(cleared.setCookie ?? '', /teslab_auth=;/, 'the cookie must be cleared');

    // Replay exactly what a browser would send after the clear.
    const [clearedCookie] = cleared.setCookie.split(';');
    assert.strictEqual((await get('/auth/me', clearedCookie)).status, 401);

    const retried = await post('/auth/logout', undefined, clearedCookie);
    assert.strictEqual(retried.status, 204, 'logout must be safe to retry');
  });

  it('does not require a valid session', async () => {
    const res = await post('/auth/logout');

    assert.strictEqual(res.status, 204);
  });

  it('issues a cookie that JavaScript cannot read', async () => {
    const { setCookie } = await login('nusrat@example.com');

    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /SameSite=Lax/i);
    assert.match(setCookie, /Path=\//i);
  });
});

describe('role authorization', () => {
  it('rejects an unauthenticated request with 401', async () => {
    const res = await post('/users', { name: 'Nope', email: 'nope@example.com' });

    assert.strictEqual(res.status, 401);
  });

  it('rejects a passenger and a driver from an ADMIN-only resource with 403', async () => {
    const passenger = await login(TEST_EMAILS.passenger, TEST_PASSWORD);
    const driver = await login(TEST_EMAILS.driver, TEST_PASSWORD);

    for (const [role, cookie] of [
      ['passenger', passenger.cookie],
      ['driver', driver.cookie],
    ]) {
      const res = await post('/users', { name: 'Nope', email: 'nope@example.com' }, cookie);
      assert.strictEqual(res.status, 403, `a ${role} must not reach an ADMIN-only resource`);
    }
  });

  it('lets an admin through the same guard', async () => {
    const admin = await login(TEST_EMAILS.admin, TEST_PASSWORD);

    assert.strictEqual(admin.status, 200);
    assert.strictEqual(admin.body.user.role, 'ADMIN');
    assert.ok(!('passengerProfile' in admin.body.user));
    assert.ok(!('driverProfile' in admin.body.user));

    const email = 'test-created-by-admin@example.com';
    await prisma.user.deleteMany({ where: { email } });

    try {
      const res = await post('/users', { name: 'Created By Admin', email }, admin.cookie);

      assert.strictEqual(res.status, 201);
      assert.strictEqual(res.body.data.email, email);
    } finally {
      await prisma.user.deleteMany({ where: { email } });
    }
  });
});

describe('POST /auth/register', () => {
  const signup = (body) => post('/auth/register', body);
  const emailFor = (localPart) => `${localPart}${SIGNUP_EMAIL_DOMAIN}`;
  const PASSWORD = 'BrandNewPass1!';

  it('creates a passenger, signs them in and returns the sanitized user', async () => {
    const address = emailFor('new-passenger');
    const res = await signup({ name: '  New Passenger  ', email: address, password: PASSWORD });

    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.user.name, 'New Passenger', 'the name should be stored trimmed');
    assert.strictEqual(res.body.user.role, 'PASSENGER');
    assert.ok(res.body.user.passengerProfile?.id, 'a passenger must get a passenger profile');
    assert.ok(!('driverProfile' in res.body.user));
    assert.ok(res.setCookie, 'signing up should establish a session');

    // The session is usable straight away, without a second request.
    const [cookie] = res.setCookie.split(';');
    const me = await get('/auth/me', cookie);
    assert.strictEqual(me.status, 200);
    assert.strictEqual(me.body.user.id, res.body.user.id);
  });

  it('creates a driver who starts OFFLINE with no vehicle', async () => {
    const address = emailFor('new-driver');
    const res = await signup({ name: 'New Driver', email: address, password: PASSWORD, role: 'DRIVER' });

    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.user.role, 'DRIVER');
    assert.strictEqual(res.body.user.driverProfile.status, 'OFFLINE');

    const user = await prisma.user.findUnique({
      where: { email: address },
      select: {
        role: true,
        passengerProfile: { select: { id: true } },
        driverProfile: { select: { vehicles: true } },
      },
    });

    assert.strictEqual(user.role, 'DRIVER');
    assert.strictEqual(user.passengerProfile, null, 'a driver must not get a passenger profile');
    assert.deepStrictEqual(user.driverProfile.vehicles, [], 'a self-registered driver starts with no vehicle');
  });

  it('defaults to PASSENGER when no role is requested', async () => {
    const res = await signup({ name: 'No Role', email: emailFor('no-role'), password: PASSWORD });

    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.user.role, 'PASSENGER');
  });

  it('does not let a client choose ADMIN', async () => {
    for (const role of ['ADMIN', 'admin', 'SUPERUSER']) {
      const res = await signup({ name: 'Sneaky Admin', email: emailFor('sneaky'), password: PASSWORD, role });

      assert.strictEqual(res.status, 400, `role "${role}" must be rejected`);
      assert.match(res.body.error.message, /role must be one of/);
    }

    const created = await prisma.user.count({ where: { email: emailFor('sneaky') } });
    assert.strictEqual(created, 0, 'a rejected sign-up must not create anything');
  });

  it('rejects an email that is already registered, including a case variant', async () => {
    const address = emailFor('duplicate');
    assert.strictEqual((await signup({ name: 'First', email: address, password: PASSWORD })).status, 201);

    const again = await signup({ name: 'Second', email: address, password: PASSWORD });
    assert.strictEqual(again.status, 409);
    assert.match(again.body.error.message, /already exists/);

    const caseVariant = await signup({ name: 'Third', email: address.toUpperCase(), password: PASSWORD });
    assert.strictEqual(caseVariant.status, 409, 'the identifier is normalised, so case must not slip past');

    assert.strictEqual(await prisma.user.count({ where: { email: address } }), 1);
  });

  it('does not let a sign-up impersonate a seeded account', async () => {
    const res = await signup({ name: 'Impostor', email: 'nusrat@example.com', password: PASSWORD });

    assert.strictEqual(res.status, 409);
  });

  it('normalises the email it stores, so the new account can log in', async () => {
    const address = emailFor('normalised');
    const created = await signup({ name: 'Normalised', email: `  ${address.toUpperCase()} `, password: PASSWORD });

    assert.strictEqual(created.status, 201);
    assert.ok(
      await prisma.user.findUnique({ where: { email: address }, select: { id: true } }),
      'the account should be stored under the normalised address',
    );

    const loggedIn = await post('/auth/login', { email: address.toUpperCase(), password: PASSWORD });
    assert.strictEqual(loggedIn.status, 200);
    assert.strictEqual(loggedIn.body.user.id, created.body.user.id);
  });

  it('stores a hash rather than the password', async () => {
    const address = emailFor('hashed');
    await signup({ name: 'Hashed', email: address, password: PASSWORD });

    const user = await prisma.user.findUnique({
      where: { email: address },
      select: { passwordHash: true },
    });

    assert.notStrictEqual(user.passwordHash, PASSWORD);
    assert.match(user.passwordHash, /^\$2[aby]\$\d{2}\$/, 'expected a bcrypt hash');
    assert.strictEqual(await verifyPassword(PASSWORD, user.passwordHash), true);
  });

  it('never returns a password hash', async () => {
    const res = await signup({ name: 'No Leak', email: emailFor('no-leak'), password: PASSWORD });
    const serialised = JSON.stringify(res.body);

    assert.ok(!/passwordHash|password_hash|"password"/.test(serialised), 'a password field leaked');
    assert.ok(!serialised.includes('$2b$'), 'a bcrypt hash leaked');
  });

  it('rejects a password shorter than the minimum, without echoing it', async () => {
    const secret = 'short1';
    const res = await signup({ name: 'Short', email: emailFor('short'), password: secret });

    assert.strictEqual(res.status, 400);
    assert.match(res.body.error.message, new RegExp(`at least ${MIN_PASSWORD_LENGTH}`));
    assert.ok(!JSON.stringify(res.body).includes(secret), 'the password was echoed back');
    assert.strictEqual(await prisma.user.count({ where: { email: emailFor('short') } }), 0);
  });

  it('rejects missing or malformed fields', async () => {
    const cases = [
      [{ email: emailFor('a'), password: PASSWORD }, /name is required/],
      [{ name: 'No Email', password: PASSWORD }, /email is required/],
      [{ name: 'No Password', email: emailFor('b') }, /password is required/],
      [{ name: '   ', email: emailFor('c'), password: PASSWORD }, /name must not be empty/],
      [{ name: 'Bad Email', email: 'nope', password: PASSWORD }, /valid email/],
    ];

    for (const [body, pattern] of cases) {
      const res = await signup(body);

      assert.strictEqual(res.status, 400, `expected 400 for ${JSON.stringify(body)}`);
      assert.match(res.body.error.message, pattern);
    }
  });

  it('rejects fields a client must not set', async () => {
    for (const extra of [{ active: true }, { passwordHash: 'x' }, { id: 'client-chosen' }]) {
      const res = await signup({
        name: 'Extra Fields',
        email: emailFor('extra'),
        password: PASSWORD,
        ...extra,
      });

      assert.strictEqual(res.status, 400);
      assert.match(res.body.error.message, /Unsupported body field/);
    }
  });
});
