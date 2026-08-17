// Vercel Function entry.
//
// Deliberately plain CommonJS pointing at the tsc-compiled output rather than a
// TypeScript file importing ../src. Vercel compiles function sources with
// esbuild, which does not implement emitDecoratorMetadata — the metadata NestJS
// reads to resolve constructor dependencies. A .ts entry therefore builds fine
// and then fails at runtime with unresolvable-dependency errors. `nest build`
// (tsc) emits that metadata, so the function loads the built app instead.
//
// vercel.json rewrites every path to this file; Nest does the routing.
module.exports = require('../dist/src/serverless').handler;
