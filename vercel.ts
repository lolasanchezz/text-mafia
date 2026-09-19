import type { VercelConfig } from '@vercel/config/v1';

export const config: VercelConfig = {
  // The project was imported while this repo still had an Express server, so
  // Vercel detected the "express" preset and looks for an app/index/server
  // entrypoint. There is no such entrypoint any more — the handlers in api/
  // are picked up on their own, which only happens with no framework set.
  framework: null,

  // With no framework, every file outside api/ is served as a static asset,
  // which would publish the source at /linq.ts and /tsconfig.json. Point the
  // static root at an empty directory instead; api/ is routed regardless.
  outputDirectory: 'public',
};
