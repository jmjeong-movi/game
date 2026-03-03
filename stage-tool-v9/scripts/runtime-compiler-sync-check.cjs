const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const repoRoot = path.resolve(__dirname, '..', '..');
const toolRoot = path.resolve(__dirname, '..');
const tmpRoot = path.join(repoRoot, '.tmp_sync_check');
fs.mkdirSync(tmpRoot, { recursive: true });

function run(cmd) { cp.execSync(cmd, { stdio: 'inherit', cwd: toolRoot }); }
function compileTs(entryAbs, rootAbs, outRel) {
  const outAbs = path.join(tmpRoot, outRel);
  fs.mkdirSync(outAbs, { recursive: true });
  run(['npx tsc', JSON.stringify(path.relative(toolRoot, entryAbs)), '--module commonjs', '--target es2019', '--esModuleInterop false', '--skipLibCheck', '--outDir', JSON.stringify(path.relative(toolRoot, outAbs)), '--rootDir', JSON.stringify(path.relative(toolRoot, rootAbs))].join(' '));
  return outAbs;
}

function sumRemaining(rt) {
  let total = 0;
  for (let r = 0; r < 10; r++) for (let c = 0; c < 10; c++) {
    if (rt.largeMask?.[r]?.[c]) continue;
    const sp = rt.special?.[r]?.[c] ?? null;
    if (sp?.t === 'CHAIN') total += Math.max(1, sp.hp | 0);
    else {
      const st = rt.boardStacks?.[r]?.[c];
      if (Array.isArray(st) && st.length > 0) total += st.length;
      else if ((rt.board?.[r]?.[c] ?? -1) >= 0) total += 1;
    }
    if (sp?.t === 'SPAWNER' || sp?.t === 'SPAWNER_BOX') total += Array.isArray(sp.queue) ? sp.queue.length : 0;
  }
  for (const lb of (rt.largeBlocks ?? [])) total += Math.max(1, (lb.hpMax ?? lb.hp ?? 1) | 0);
  for (const col of (rt.columnSupply ?? [])) if (Array.isArray(col)) total += col.length;
  for (const sb of (rt.spawnerBoxes ?? [])) total += Array.isArray(sb?.queue) ? sb.queue.length : 0;
  return total;
}

function summarize(rt, stageId) {
  const keyCount = (rt.special ?? []).flat().filter((v) => v?.t === 'KEY' || v?.t === 'LOCK').length;
  const spawnerBoxes = rt.spawnerBoxes ?? [];
  const spawnerQueue = spawnerBoxes.reduce((acc, sb) => acc + ((sb?.queue?.length) || 0), 0);
  return { stageId, totalBlocks: rt.totalBlocks ?? null, derivedRemaining: sumRemaining(rt), keyCount, spawnerBoxCount: spawnerBoxes.length, spawnerQueue };
}

const gameTs = fs.readFileSync(path.join(repoRoot, 'game/stage/compileRuntimeFromV2.ts'), 'utf8');
const toolTs = fs.readFileSync(path.join(repoRoot, 'stage-tool-v9/src/lib/runtime/stage/compileRuntimeFromV2.ts'), 'utf8');
if (gameTs !== toolTs) {
  throw new Error('game/stage/compileRuntimeFromV2.ts and stage-tool runtime ts are not identical');
}

const toolOut = compileTs(path.join(repoRoot, 'stage-tool-v9/src/lib/runtime/stage/compileRuntimeFromV2.ts'), path.join(repoRoot, 'stage-tool-v9/src/lib/runtime'), 'tool');
const toolCompiler = require(path.join(toolOut, 'stage/compileRuntimeFromV2.js')).compileRuntimeFromV2;
const validatorCompiler = require(path.join(repoRoot, 'stage-tool-v9/src/validator_tools/runtime_cjs/stage/compileRuntimeFromV2.js')).compileRuntimeFromV2;

const pack = JSON.parse(fs.readFileSync(path.join(repoRoot, 'stagepack_v2_replay_solved_fixed21.json'), 'utf8'));
const stages = (pack.stages || []).filter((st) => {
  const objs = st?.board?.objects || [];
  let hasSpawner = false; let hasKey = false;
  for (const o of objs) { if (o?.type === 'SPAWNER_BOX') hasSpawner = true; if (o?.type === 'KEY' || o?.type === 'LOCK') hasKey = true; }
  return hasSpawner || hasKey;
}).slice(0, 5);
if (!stages.length) throw new Error('No candidate stages with SPAWNER_BOX/KEY/LOCK found');

const dump = [];
for (const st of stages) {
  const a = summarize(toolCompiler(st, { enableStacks: true }), st.id);
  const b = summarize(validatorCompiler(st, { enableStacks: true }), st.id);
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    console.error('Mismatch detected for stage', st.id);
    console.error({ tool: a, validator: b });
    process.exit(1);
  }
  dump.push(a);
}

const outFile = path.join(toolRoot, 'tests/runtime-compiler-sync.snapshot.json');
fs.writeFileSync(outFile, JSON.stringify({ base: 'game/stage/compileRuntimeFromV2.ts', dump }, null, 2));
console.log('Wrote snapshot:', path.relative(repoRoot, outFile));
