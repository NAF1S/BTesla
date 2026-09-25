import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Router } from 'express';

// Mounted at /api/docs.
const router = Router();

/**
 * The API description, served as the file it is.
 *
 * There is no Swagger UI and no `swagger-jsdoc`: this project has no OpenAPI
 * toolchain among its dependencies, and adding one to publish a document would be
 * a dependency for a documentation problem. `openapi.yaml` is a hand-written file
 * that a human reviews in a diff, exactly like `README.md`, and this route serves
 * it so tooling (Swagger Editor, Redoc, Postman, `openapi-generator`) and a
 * curious reader with `curl` can fetch it from the running API rather than from
 * the repository.
 *
 * The file is sent verbatim, deliberately. Nothing here parses, rewrites or
 * validates it: a YAML parser small enough to be dependency-free would be a
 * half-implementation whose bugs would look exactly like spec bugs, and a parser
 * correct enough to trust is a dependency. `test/unit/openapi.test.js` checks the
 * document against the routes instead -- which is the drift that actually happens.
 *
 * The path is resolved with `fileURLToPath`, not `new URL(…).pathname`. On Windows
 * the latter yields `/C:/Users/…` with a leading slash, which `res.sendFile` cannot
 * resolve, so the route answers 404 with an `ENOENT` instead of the document -- a
 * failure that looks like a typo in the URL rather than a path bug.
 */
const SPEC_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'openapi.yaml');

router.get('/', (_req, res) => {
  res.sendFile(SPEC_PATH, {
    headers: { 'Content-Type': 'text/yaml; charset=utf-8' },
  });
});

export default router;
