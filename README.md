# TeslaB

Monorepo with a **Next.js** frontend and an **Express** REST API.

## Structure

```
TeslaB/
├── client/                 # Next.js 16 (App Router, JavaScript, Tailwind CSS v4)
│   ├── src/
│   │   ├── app/            # Routes, layouts, and pages
│   │   │   ├── layout.js
│   │   │   ├── page.js     # Home page; fetches from the Express API
│   │   │   └── globals.css
│   │   └── lib/
│   │       └── api.js      # fetch wrapper for the Express API
│   ├── public/             # Static assets
│   ├── next.config.mjs     # /api/* proxy rewrite -> Express
│   └── .env.local.example
├── server/                 # Express 5 API (ESM)
│   ├── src/
│   │   ├── index.js        # HTTP server bootstrap + graceful shutdown
│   │   ├── app.js          # Express app: middleware, routes, error handling
│   │   ├── config/env.js   # Environment configuration
│   │   ├── routes/         # Route definitions (index, health, users)
│   │   ├── controllers/    # Request handlers
│   │   ├── services/       # Business logic / data access
│   │   ├── middleware/     # notFound, errorHandler
│   │   └── utils/          # ApiError, helpers
│   └── .env.example
├── package.json            # npm workspaces + dev/build scripts
└── .gitignore
```

## Getting started

```bash
npm install          # installs workspace deps (client + server)
cp client/.env.local.example client/.env.local
cp server/.env.example server/.env
npm run dev          # starts Express (:4000) and Next.js (:3000) together
```

Open http://localhost:3000 — the home page calls `GET /api/health` and `GET /api/users`.

## Scripts (run from the repo root)

| Script                 | Description                                     |
| ---------------------- | ----------------------------------------------- |
| `npm run dev`        | Run the API and the web client concurrently     |
| `npm run dev:server` | Express only, with`node --watch` on port 4000 |
| `npm run dev:client` | Next.js dev server on port 3000                 |
| `npm run build`      | Production build of the Next.js client          |
| `npm start`          | Run both apps in production mode                |
| `npm run lint`       | ESLint for the client                           |

## API

Base URL: `http://localhost:4000/api`

| Method   | Endpoint       | Description                                   |
| -------- | -------------- | --------------------------------------------- |
| `GET`  | `/health`    | Service status and uptime                     |
| `GET`  | `/users`     | List users                                    |
| `GET`  | `/users/:id` | Get a single user (`404` if missing)        |
| `POST` | `/users`     | Create a user — body:`{ "name", "email" }` |

Errors use a consistent shape:

```json
{ "error": { "message": "User 99 not found" } }
```

## How the client talks to the API

- The browser requests `/api/...` on the Next.js origin; `next.config.mjs` rewrites those calls to the Express server (`API_PROXY_TARGET`, default `http://localhost:4000`). No CORS round-trip needed in the browser.
- Server components use `API_URL` from `client/.env.local` because relative URLs cannot be fetched on the server.
- Direct cross-origin calls still work — the API sends `Access-Control-Allow-Origin` for `CLIENT_ORIGIN`.

## Next steps

- Swap the in-memory store in `server/src/services/user.service.js` for a database.
- Add validation (e.g. `zod`) in the controllers.
- Add tests (`vitest` or `node --test` for the API, Playwright for the client).
