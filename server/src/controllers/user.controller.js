import { ApiError } from '../utils/ApiError.js';
import * as userService from '../services/user.service.js';

export const listUsers = (_req, res) => {
  res.json({ data: userService.findAll() });
};

export const getUser = (req, res) => {
  const user = userService.findById(req.params.id);
  if (!user) throw new ApiError(404, `User ${req.params.id} not found`);
  res.json({ data: user });
};

export const createUser = (req, res) => {
  const { name, email } = req.body ?? {};
  if (!name || !email) throw new ApiError(400, 'name and email are required');

  const user = userService.create({ name, email });
  res.status(201).json({ data: user });
};
