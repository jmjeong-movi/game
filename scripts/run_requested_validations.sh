#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

unzip -oq "$ROOT/stage-tool-v9_patched_src_fixed21.zip" -d "$TMP"
CLI="$TMP/stage-tool-v9/src/validator_tools/cli.js"

if [ ! -f "$CLI" ]; then
  echo "validator CLI not found in extracted zip: $CLI" >&2
  exit 2
fi

node - <<'NODE' "$ROOT/stagepack_v2_replay_solved_fixed21.json" "$CLI" "$ROOT/stagepack_v2_replay_solved_fixed21_validation.json"
const fs=require('fs');
const [packFile,cliFile,outFile]=process.argv.slice(2);
const cli=require(cliFile);
const pack=JSON.parse(fs.readFileSync(packFile,'utf8'));
(async()=>{
  const {report}=await cli.repairStagePack(pack,50000,120,180,{enabled:true,depth:10,window:12,beam:10,simSteps:5000},undefined);
  const results=Array.isArray(report?.results)?report.results:[];
  const summary={
    total: results.length,
    solved: results.filter(r=>String(r?.status)==='SOLVED').length,
    stuck: results.filter(r=>String(r?.status)==='STUCK').length,
    unknown: results.filter(r=>String(r?.status)==='UNKNOWN').length,
    error: results.filter(r=>String(r?.status)==='ERROR').length,
  };
  fs.writeFileSync(outFile, JSON.stringify({summary, results},null,2));
  console.log('[fixed21_validation]', summary);
})();
NODE

node - <<'NODE' "$CLI" "$ROOT/stagepack_v2_matrix_120.json" "$ROOT/stagepack_v2_matrix_120_report.json"
const fs=require('fs');
const [cliFile,outPack,outReport]=process.argv.slice(2);
const cli=require(cliFile);

const BCS=[500,1000,1500,2000];
const DIFFS=[['easy',3],['normal',6],['hard',9]];
const COLORS=['R','O','Y','G','B','P','M','C','S','L','K','W'];
const ALLOWED_SUPPLY_TYPES = new Set(['BLOCK_SMALL','BLOCK_NORMAL','BLOCK_HIDDEN','BLOCK_LARGE','BLOCK_LARGE_HIDDEN']);
const MAX_ATTEMPTS_PER_STAGE = 30;

function sanitizeSupplyPagesToBlocksOnly(stage){
  const pages=Array.isArray(stage?.supply?.pages)?stage.supply.pages:[];
  for (const page of pages){
    const objects=Array.isArray(page?.objects)?page.objects:[];
    page.objects = objects.filter((o)=>ALLOWED_SUPPLY_TYPES.has(String(o?.type ?? '')));
  }
}

function makeCandidate(id, blockCount, diffName, diff, idx, attempt){
  const c0 = COLORS[(id + attempt) % COLORS.length];
  const c1 = COLORS[(id + attempt + 3) % COLORS.length];
  const c2 = COLORS[(id + attempt + 6) % COLORS.length];
  const chainId = `ch_${id}_${attempt}`;

  const board = [
    { type:'BLOCK_SMALL', x:0, y:9, color:c0, layer:0 },
    { type:'BLOCK_NORMAL', x:1, y:9, color:c1, layer:0 },
    { type:'BLOCK_HIDDEN', x:2, y:9, color:c2, layer:0 },
    { type:'BLOCK_LARGE', x:3, y:8, color:c0, hp:20, layer:0 },
    { type:'BLOCK_LARGE_HIDDEN', x:6, y:8, color:c1, hp:20, layer:0 },

    // requested obstacle/object types kept on board (not in supply)
    { type:'CHAIN_BARRIER', x:0, y:2, color:'C', layer:0, chainId, chainOrder:0, chainLen:2 },
    { type:'CHAIN_BARRIER', x:1, y:2, color:'C', layer:0, chainId, chainOrder:1, chainLen:2 },
    { type:'KEY', x:9, y:1, keyId:`K${id}`, layer:0 },
    { type:'PILLAR', x:9, y:0, h:1, layer:0 },
    { type:'SPAWNER_BOX', x:8, y:1, hp:2, spawn:{poolColors:[c0,c1]}, layer:0 },
  ];

  const pages=[];
  for (let p=0; p<3; p++){
    const objs=[];
    for(let i=0;i<24;i++){
      const x=(i*3+p)%10;
      const y=(i*5+p)%10;
      const color=COLORS[(i + p + attempt + diff) % COLORS.length];
      const type=(i%7===0)?'BLOCK_HIDDEN':'BLOCK_NORMAL';
      objs.push({type, x, y, color, layer:0});
    }
    objs.push({type:'BLOCK_LARGE', x:7, y:7, color:COLORS[(p+2)%COLORS.length], hp:18, layer:0});
    // negative test objects: must be removed by sanitizer
    objs.push({type:'CHAIN_BARRIER',x:0,y:0,color:'C',layer:0});
    objs.push({type:'PILLAR',x:1,y:0,h:2,layer:0});
    objs.push({type:'SPAWNER_BOX',x:2,y:0,hp:2,spawn:{poolColors:[c0]},layer:0});
    pages.push({objects: objs});
  }

  const stage = {
    id,
    meta:{
      blockCount,
      colorCount:12,
      layerCount:1,
      slotCount:5,
      waitLineCount:3,
      pickerCols:3,
      pickerMaxCards:240,
      seed:(100000 + id * 131 + attempt) >>> 0,
      difficulty:diffName,
      difficultyIndex:diff,
      matrixIndex:idx,
      attempt,
    },
    board:{objects:board},
    supply:{mode:'PATTERN',pages},
    cards:{mode:'GENERATE'},
    shooters:[],
  };
  sanitizeSupplyPagesToBlocksOnly(stage);
  return stage;
}

async function solveOne(target){
  for (let attempt=0; attempt<MAX_ATTEMPTS_PER_STAGE; attempt++){
    const draft = makeCandidate(target.id, target.blockCount, target.diffName, target.diff, target.idx, attempt);
    const onePack = {schemaVersion:2, stages:[draft]};
    const {pack,report}=await cli.repairStagePack(onePack,60000,160,220,{enabled:true,depth:10,window:12,beam:10,simSteps:6000},undefined);
    const r=report?.results?.[0] ?? {};
    if (String(r?.status) === 'SOLVED') {
      const fixed = Array.isArray(pack?.stages) ? pack.stages[0] : draft;
      return { ok:true, stage:fixed, result:r, attempt };
    }
  }
  return { ok:false };
}

(async()=>{
  const targets=[];
  let id=1;
  for (const bc of BCS) for (const [diffName,diff] of DIFFS) for (let idx=0; idx<10; idx++) {
    targets.push({id:id++, blockCount:bc, diffName, diff, idx});
  }

  const solvedStages=[];
  const results=[];
  const failures=[];
  const started=Date.now();

  for (const t of targets){
    const out = await solveOne(t);
    if (!out.ok){
      failures.push(t);
      results.push({id:t.id, status:'STUCK', reason:'retry_exhausted'});
      continue;
    }
    solvedStages.push(out.stage);
    results.push({id:t.id, ...out.result, genAttempt:out.attempt});
  }

  const summary={
    total: targets.length,
    solved: results.filter(r=>String(r?.status)==='SOLVED').length,
    stuck: results.filter(r=>String(r?.status)==='STUCK').length,
    unknown: results.filter(r=>String(r?.status)==='UNKNOWN').length,
    error: results.filter(r=>String(r?.status)==='ERROR').length,
    elapsedMs: Date.now()-started,
  };

  const byBlockCount={};
  const byDifficulty={};
  for (const t of targets){
    byBlockCount[t.blockCount]=byBlockCount[t.blockCount]||{total:0,solved:0};
    byDifficulty[t.diffName]=byDifficulty[t.diffName]||{total:0,solved:0};
    byBlockCount[t.blockCount].total++;
    byDifficulty[t.diffName].total++;
    const r = results.find((x)=>x.id===t.id);
    if (String(r?.status)==='SOLVED'){
      byBlockCount[t.blockCount].solved++;
      byDifficulty[t.diffName].solved++;
    }
  }

  const reportObj = {summary, byBlockCount, byDifficulty, failures, results};
  fs.writeFileSync(outReport, JSON.stringify(reportObj, null, 2));

  if (summary.solved !== summary.total){
    console.error('[matrix_validation] FAILED: some stages remain unsolved', summary);
    process.exit(3);
  }

  const solvedPack={schemaVersion:2, buildId:`matrix_120_solved_${Date.now()}`, stages:solvedStages};
  fs.writeFileSync(outPack, JSON.stringify(solvedPack, null, 2));
  console.log('[matrix_validation] PASS', summary);
})();
NODE

echo "validation outputs:"
echo "- $ROOT/stagepack_v2_replay_solved_fixed21_validation.json"
echo "- $ROOT/stagepack_v2_matrix_120.json"
echo "- $ROOT/stagepack_v2_matrix_120_report.json"
