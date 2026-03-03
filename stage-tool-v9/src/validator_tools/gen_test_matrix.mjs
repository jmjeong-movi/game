#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const blockCounts = [500, 1000, 1500, 2000];
const difficulties = [
  { name: 'easy', d: 3 },
  { name: 'normal', d: 6 },
  { name: 'hard', d: 9 },
];
const COLORS = ['R','O','Y','G','B','P','M','C','S','L','K','W'];
const ALLOWED_SUPPLY_TYPES = new Set(['BLOCK_SMALL','BLOCK_NORMAL','BLOCK_HIDDEN','BLOCK_LARGE','BLOCK_LARGE_HIDDEN']);

function sanitizeSupplyPagesToBlocksOnly(stage) {
  const pages = Array.isArray(stage?.supply?.pages) ? stage.supply.pages : [];
  for (const page of pages) {
    const objects = Array.isArray(page?.objects) ? page.objects : [];
    page.objects = objects.filter((o) => ALLOWED_SUPPLY_TYPES.has(String(o?.type ?? '')));
  }
}

function makeStage(id, bc, diffName, diff, idx) {
  const color = COLORS[(id + idx) % COLORS.length];
  const board = [
    { type: 'BLOCK_SMALL', x: 0, y: 9, color, layer: 0 },
    { type: 'BLOCK_NORMAL', x: 1, y: 9, color: COLORS[(id + 3) % COLORS.length], layer: 0 },
    { type: 'BLOCK_HIDDEN', x: 2, y: 9, color: COLORS[(id + 6) % COLORS.length], layer: 0 },
    { type: 'BLOCK_LARGE', x: 3, y: 8, color, hp: 20, layer: 0 },
    { type: 'BLOCK_LARGE_HIDDEN', x: 6, y: 8, color, hp: 20, layer: 0 },
    { type: 'CHAIN_BARRIER', x: 0, y: 2, color: 'C', layer: 0, chainId: `ch_${id}`, chainOrder: 0, chainLen: 2 },
    { type: 'CHAIN_BARRIER', x: 1, y: 2, color: 'C', layer: 0, chainId: `ch_${id}`, chainOrder: 1, chainLen: 2 },
    { type: 'KEY', x: 9, y: 1, keyId: `K${id}`, layer: 0 },
    { type: 'PILLAR', x: 9, y: 0, h: 1, layer: 0 },
    { type: 'SPAWNER_BOX', x: 8, y: 1, hp: 2, spawn: { poolColors: [color] }, layer: 0 },
  ];

  const pages = [];
  for (let p = 0; p < 3; p++) {
    const objects = [];
    for (let i = 0; i < 24; i++) {
      objects.push({
        type: i % 7 === 0 ? 'BLOCK_HIDDEN' : 'BLOCK_NORMAL',
        x: (i * 3 + p) % 10,
        y: (i * 5 + p) % 10,
        color: COLORS[(i + p + diff) % COLORS.length],
        layer: 0,
      });
    }
    // filtered by sanitizer
    objects.push({ type: 'CHAIN_BARRIER', x: 0, y: 0, color: 'C', layer: 0 });
    objects.push({ type: 'PILLAR', x: 1, y: 0, h: 2, layer: 0 });
    objects.push({ type: 'SPAWNER_BOX', x: 2, y: 0, hp: 2, spawn: { poolColors: [color] }, layer: 0 });
    pages.push({ objects });
  }

  const stage = {
    id,
    meta: { blockCount: bc, colorCount: 12, layerCount: 1, difficulty: diffName, difficultyIndex: diff, matrixIndex: idx },
    board: { objects: board },
    supply: { mode: 'PATTERN', pages },
    cards: { mode: 'GENERATE' },
    shooters: [],
  };
  sanitizeSupplyPagesToBlocksOnly(stage);
  return stage;
}

const stages = [];
let sid = 1;
for (const bc of blockCounts) {
  for (const dif of difficulties) {
    for (let i = 0; i < 10; i++) {
      stages.push(makeStage(sid++, bc, dif.name, dif.d, i));
    }
  }
}

const out = { schemaVersion: 2, buildId: `matrix_${Date.now()}`, stages };
const outDir = process.cwd();
const outFile = path.join(outDir, 'stagepack_v2_matrix_120_seed.json');
fs.writeFileSync(outFile, JSON.stringify(out, null, 2));
console.log(`[gen_test_matrix] wrote ${stages.length} stages -> ${outFile}`);
