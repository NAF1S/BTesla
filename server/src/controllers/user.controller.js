import { ApiError } from '../utils/ApiError.js';
import * as userService from '../services/user.service.js';

// Express 5 forwards rejected promises to the error handler automatically.
export const listUsers = async (_req, res) => {
  res.json({ data: await userService.findAll() });
};

export const getUser = async (req, res) => {
  const user = await userService.findById(req.params.id);
  if (!user) throw new ApiError(404, `User ${req.params.id} not found`);
  res.json({ data: user });
};

export const createUser = async (req, res) => {
  const { name, email } = req.body ?? {};
  if (!name || !email) throw new ApiError(400, 'name and email are required');
  if (!email.includes('@')) throw new ApiError(400, 'email must be a valid address');

  const user = await userService.create({ name, email });
  res.status(201).json({ data: user });
};
