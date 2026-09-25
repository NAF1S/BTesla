# `client/public/` — static files served at the site root

Anything here is reachable at `/name` from the browser, served as-is by Next with
no build step, no bundling and no transformation.

## Why it matters

* **The path is the URL.** `public/logo.svg` is `/logo.svg`. There is no `public`
  segment in the address, and no way to rename a file here without changing every
  reference to it.
* **Nothing here is fingerprinted or cache-busted.** A file replaced at the same
  path may be served from a browser's cache, so a changed asset keeps its old name
  only if it is meant to be overwritten — otherwise version it
  (`marker-v2.svg`).
* **Size is paid on every request.** These are not bundled or tree-shaken.

## What is here

The five SVGs Next.js scaffolds a new app with — `next.svg`, `vercel.svg`,
`file.svg`, `globe.svg`, `window.svg`.

**Nothing references them any more.** The scaffold's demo page used them as
decoration; that page now lives at `/status` and renders data rather than icons, so
these are dead weight that can be deleted whenever somebody wants. They are left in
place because removing scaffold assets is not part of any milestone, and a deleted
file is one more thing to explain in a diff.

Add application assets (a logo, a marker icon, an `og` image, `robots.txt`,
`favicon.ico`) beside them.

## Depends on / depended on by

Depends on nothing. Depended on by `../src/app/` — a component refers to an asset
by its root-relative URL (`/next.svg`), so a file renamed or moved here breaks the
component that names it.

## What not to put here

* **No API responses and no data files.** A JSON file here is a second source of
  truth that no test covers; the server owns the data.
* **No secrets.** Everything in this folder is public by definition.
