import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import morgan from 'morgan';

import { env } from './config/env.js';
import routes from './routes/index.js';
import { errorHandler } from './middleware/errorHandler.js';
import { notFound } from './middleware/notFound.js';

const app = express();

app.disable('x-powered-by');
app.use(cors({ origin: env.clientOrigin, credentials: true }));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
// Unsigned cookies: the authentication cookie is a signed JWT whose integrity is
// checked on verify, so no cookie-signing secret is involved.
app.use(cookieParser());
if (env.nodeEnv !== 'test') app.use(morgan('dev'));

// All API routes live under /api
app.use('/api', routes);

app.use(notFound);
app.use(errorHandler);

export default app;
