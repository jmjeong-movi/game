"use strict";

// NOTE
// -----
// This stage tool bundles a copy of the real game stage compiler under:
//   src/lib/runtime/stage/compileRuntimeFromV2.ts
//
// The validator_tools runtime (Board/GameFlow/UnitLineRack) depends on StageCompiler
// via CommonJS `require("./StageCompiler")`.
//
// To guarantee 100% matching between:
// - the editor/export pipeline,
// - the replay simulator (validator_tools), and
// - the actual game logic (game_patched_v7),
// we re-export the single source of truth compiler from src/lib/runtime/StageCompiler.

Object.defineProperty(exports, "__esModule", { value: true });
exports.compileRuntimeFromV2 = void 0;

// Load the CommonJS-compiled copy of the runtime StageCompiler.
//
// Why this exists:
// - The stage tool itself is ESM/TS (Vite).
// - validator_tools is CommonJS (headless game runtime).
// - We keep the single source of truth in src/lib/runtime/*.ts,
//   then compile a small CJS mirror into src/validator_tools/runtime_cjs so
//   Node can `require()` it without ESM boundary issues.
const mod = require("../runtime_cjs/stage/compileRuntimeFromV2");
const fn = (mod && mod.compileRuntimeFromV2) || (mod && mod.default);

if (typeof fn !== "function") {
  throw new Error("validator_tools: runtime compileRuntimeFromV2 not found");
}

exports.compileRuntimeFromV2 = fn;
