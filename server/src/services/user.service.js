import { randomUUID } from 'node:crypto';

// In-memory store — swap for a real database later.
const users = [
  { id: '1', name: 'Ada Lovelace', email: 'ada@example.com' },
  { id: '2', name: 'Alan Turing', email: 'alan@example.com' },
];

export const findAll = () => users;

export const findById = (id) => users.find((user) => user.id === id) ?? null;

export const create = ({ name, email }) => {
  const user = { id: randomUUID(), name, email };
  users.push(user);
  return user;
};
