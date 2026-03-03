#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

unzip -oq "$ROOT/stage-tool-v9_patched_src_fixed21.zip" -d "$TMP"
CLI="$TMP/stage-tool-v9/src/validator_tools/cli.js"

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
const COLORS=['R','O','Y','G','B','P','M','C','S','L','K','W'];
function baseStage(id, blockCount, diffName, di, idx){
  const o=[];
  o.push({type:'BLOCK_SMALL',x:0,y:9,color:'R',layer:0});
  o.push({type:'BLOCK_NORMAL',x:1,y:9,color:'G',layer:0});
  o.push({type:'BLOCK_HIDDEN',x:2,y:9,color:'B',layer:0});
  o.push({type:'BLOCK_LARGE',x:3,y:8,color:'Y',hp:40,layer:0});
  o.push({type:'BLOCK_LARGE_HIDDEN',x:6,y:8,color:'P',hp:40,layer:0});
  o.push({type:'CHAIN_BARRIER',x:0,y:7,color:'C',layer:0,chainId:`ch_${id}`,chainOrder:0,chainLen:3});
  o.push({type:'CHAIN_BARRIER',x:1,y:7,color:'C',layer:0,chainId:`ch_${id}`,chainOrder:1,chainLen:3});
  o.push({type:'CHAIN_BARRIER',x:2,y:7,color:'C',layer:0,chainId:`ch_${id}`,chainOrder:2,chainLen:3});
  o.push({type:'KEY',x:4,y:9,keyId:'A',layer:0});
  o.push({type:'PILLAR',x:9,y:0,h:4,layer:0});
  o.push({type:'SPAWNER_BOX',x:7,y:2,hp:8,spawn:{poolColors:['R','G']},layer:0});

  const pages=[];
  for(let p=0;p<3;p++){
    const po=[];
    for(let i=0;i<20;i++){
      const x=(i*3+p)%10; const y=(i*7+p)%10; const c=COLORS[(i+p+di)%COLORS.length];
      const t=(i%5===0)?'BLOCK_HIDDEN':'BLOCK_NORMAL';
      po.push({type:t,x,y,color:c,layer:0});
    }
    po.push({type:'BLOCK_LARGE',x:8,y:8,color:COLORS[(p+2)%COLORS.length],hp:30,layer:0});
    pages.push({objects:po});
  }
  return {
    id,
    meta:{blockCount,colorCount:12,layerCount:1,slotCount:5,waitLineCount:3,pickerCols:3,pickerMaxCards:120,seed:10000+id,difficulty:diffName,difficultyIndex:di,matrixIndex:idx},
    board:{objects:o},
    supply:{mode:'PATTERN',pages},
    cards:{mode:'GENERATE'},
    shooters:[],
  };
}
(async()=>{
  const bcs=[500,1000,1500,2000];
  const diffs=[['easy',3],['normal',6],['hard',9]];
  const stages=[];
  let id=1;
  for (const bc of bcs) for (const [name,di] of diffs) for(let i=0;i<10;i++) stages.push(baseStage(id++,bc,name,di,i));
  const pack={schemaVersion:2,buildId:'matrix_120',stages};
  fs.writeFileSync(outPack,JSON.stringify(pack,null,2));

  const t=Date.now();
  const {report}=await cli.repairStagePack(pack,8000,20,30,{enabled:true,depth:4,window:6,beam:4,simSteps:1000},undefined);
  const results=Array.isArray(report?.results)?report.results:[];
  const summary={
    total: results.length,
    solved: results.filter(r=>String(r?.status)==='SOLVED').length,
    stuck: results.filter(r=>String(r?.status)==='STUCK').length,
    unknown: results.filter(r=>String(r?.status)==='UNKNOWN').length,
    error: results.filter(r=>String(r?.status)==='ERROR').length,
    elapsedMs: Date.now()-t,
  };
  const byBlockCount={};
  const byDifficulty={};
  for (let i=0;i<results.length;i++){
    const st=stages[i]||{};
    const bc=String(st?.meta?.blockCount??'NA');
    const df=String(st?.meta?.difficulty??'NA');
    byBlockCount[bc]=byBlockCount[bc]||{total:0,solved:0};
    byDifficulty[df]=byDifficulty[df]||{total:0,solved:0};
    byBlockCount[bc].total++; byDifficulty[df].total++;
    if(String(results[i]?.status)==='SOLVED'){byBlockCount[bc].solved++; byDifficulty[df].solved++;}
  }
  fs.writeFileSync(outReport, JSON.stringify({summary,byBlockCount,byDifficulty},null,2));
  console.log('[matrix_validation]', summary);
})();
NODE

echo "validation outputs:"
echo "- $ROOT/stagepack_v2_replay_solved_fixed21_validation.json"
echo "- $ROOT/stagepack_v2_matrix_120.json"
echo "- $ROOT/stagepack_v2_matrix_120_report.json"
