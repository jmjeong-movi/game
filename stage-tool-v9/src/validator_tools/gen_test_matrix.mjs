#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { generateRandomStage } from '../lib/randomStageGenerator.ts';

const blockCounts = [500, 1000, 1500, 2000];
const difficulties = [
  { name: 'easy', d: 3 },
  { name: 'normal', d: 6 },
  { name: 'hard', d: 9 },
];

const baseStage = {
  id: 1,
  meta: { blockCount: 500, colorCount: 12, layerCount: 1 },
  board: { objects: [] },
  supply: { mode: 'PATTERN', pages: [] },
  cards: { mode: 'GENERATE' },
};

const stages = [];
let sid = 1;
for (const bc of blockCounts) {
  for (const dif of difficulties) {
    for (let i = 0; i < 10; i++) {
      const seed = (bc * 1000) + (dif.d * 100) + i;
      const st = generateRandomStage({ ...baseStage, id: sid }, {
        blockCount: bc,
        difficulty: dif.d,
        includeLarge: true,
        includeLargeHidden: true,
        includeHidden: true,
        includeSpawner: true,
        includeChain: true,
        includeKeyLock: true,
        includePillar: true,
        symmetry: 'RANDOM',
      }, seed);
      st.meta = { ...(st.meta ?? {}), colorCount: 12, testTag: { bc, difficulty: dif.name, idx: i, seed } };
      stages.push(st);
      sid += 1;
    }
  }
}

const out = {
  schemaVersion: 2,
  buildId: `matrix_${Date.now()}`,
  stages,
};

const outDir = path.resolve(process.cwd(), 'stage-tool-v9');
const outFile = path.join(outDir, 'stagepack_v2_test_matrix.json');
fs.writeFileSync(outFile, JSON.stringify(out, null, 2));
console.log(`[gen_test_matrix] wrote ${stages.length} stages -> ${outFile}`);
