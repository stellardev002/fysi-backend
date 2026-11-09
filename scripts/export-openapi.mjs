// Saves the OpenAPI spec of a running API to docs/openapi.json, so the frontend
// repo (which cannot see this code) gets the exact contract as a file.
//
//   pnpm start:dev                      # in another terminal, SWAGGER_ENABLED=true
//   pnpm docs:openapi                   # or: pnpm docs:openapi https://<host>
import { writeFile } from 'node:fs/promises';

const base = (process.argv[2] ?? 'http://localhost:4000').replace(/\/+$/, '');
const res = await fetch(`${base}/docs-json`);
if (!res.ok) {
  console.error(
    `GET ${base}/docs-json answered ${res.status}. Is the API running with SWAGGER_ENABLED=true?`,
  );
  process.exit(1);
}
const spec = await res.json();
await writeFile('docs/openapi.json', `${JSON.stringify(spec, null, 2)}\n`);
console.log(
  `Saved docs/openapi.json (${Object.keys(spec.paths).length} paths) from ${base}`,
);
