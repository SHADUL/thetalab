// runBacktest.ts imports api/intraday.js's named exports directly (see
// its own header comment for why) — that file has no .d.ts, and it's
// outside this tsconfig's rootDir, so TS can't infer anything from it.
// This shim tells TS to treat any plain-.js import as `any` rather than
// erroring — it does not affect type-checking of this project's own
// .ts modules, which stay fully strict.
declare module '*.js';
