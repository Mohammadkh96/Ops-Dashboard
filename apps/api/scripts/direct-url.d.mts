/**
 * Types for direct-url.mjs.
 *
 * The helper is plain ESM because `deploy-migrations.mjs` runs it with bare
 * node during the build, before anything is compiled. prisma.config.ts is
 * TypeScript and imports the same function, and without this it arrives as
 * `any` — which is how a config file that decides which DATABASE the
 * migrations run against loses every type check on it.
 */
export declare function migrationUrl(env?: NodeJS.ProcessEnv): {
  /** The connection string to migrate with, or undefined if none is set. */
  url: string | undefined;
  /** Host only — safe to log; the URL carries the password. */
  host: string;
  /** Where it came from, for the build log. */
  why: string;
};
