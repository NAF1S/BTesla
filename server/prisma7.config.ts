// Prisma CLI configuration.
//
// The datasource URL is resolved through the application's own env module so
// the CLI and the API always agree on the connection string -- including the
// docker-compose defaults used when no .env file exists.
//
// There is deliberately no `migrations` block: the physical schema is owned by
// the idempotent SQL files in server/db (applied by `npm run db:migrate`).
// Prisma is used to read and write that schema, not to own it.
import "dotenv/config";
import { defineConfig } from "prisma/config";

import { env } from "./src/config/env.js";

export default defineConfig({
  schema: "prisma/schema.prisma",
  datasource: {
    url: env.databaseUrl,
  },
});
