import type { StagePackV2, StageV2, BoardObject } from './schema';
import { COLOR12 } from './schema';
import { uid } from './ids';
import { calcInitialBlocks, countsAsBlock } from './board';
import { buildClearGuaranteedAuthoredCards } from './guaranteedCards';
import { compileRuntimeFromV2 } from './runtime/StageCompiler';
import { COLOR_TOKEN_ORDER, colorIdFromToken } from './runtime/Types';
import {
  simulateGuaranteedEquipPlan,
  simulateGuaranteedEquipPlanGuaranteed,
  simulateGuaranteedEquipPlanGuaranteedAsync,
  applyPlanToCards,
  verifyGuaranteedEquipPlan,
} from './runtime/CoreSim';


const GAME_ZIP_BASELINE = {
  zip: 'game_fixed_spawner_chain_under_fix.zip',
  version: '2026-02-27',
  compilerSha256: '7dfdffd60e477905d16c0b2ee2694ed720117b0fbe6b3054d3b3d8d4d17d554d',
  fnv1a32: '3484e01a',
  normalizedSourceLength: 58644,
};

function fnv1a32Hex(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

function assertRuntimeCompilerBaselineForExport(): void {
  const src = String((compileRuntimeFromV2 as any)?.toString?.() ?? '').replace(/\s+/g, ' ');
  const hash = fnv1a32Hex(src);
  const ok = src.length === GAME_ZIP_BASELINE.normalizedSourceLength && hash === GAME_ZIP_BASELINE.fnv1a32;
  if (!ok) {
    throw new Error(
      `[EXPORT_BLOCKED_COMPILER_MISMATCH] expected ${GAME_ZIP_BASELINE.zip}@${GAME_ZIP_BASELINE.version} ` +
      `(sha256=${GAME_ZIP_BASELINE.compilerSha256}, fnv=${GAME_ZIP_BASELINE.fnv1a32}/${GAME_ZIP_BASELINE.normalizedSourceLength}) ` +
      `but got fnv=${hash}/${src.length}. Runtime compiler sync is required before export.`
    );
  }
}

function objWeight(o: BoardObject): number {
  if (!countsAsBlock(o)) return 0;
  if (o.type === 'BLOCK_LARGE' || o.type === 'BLOCK_LARGE_HIDDEN') {
    return Math.max(1, Math.floor((o as any).hp ?? 80));
  }
  return 1;
}

function sortForTrim(a: BoardObject, b: BoardObject): number {
  // ✅ y=0 라인부터(아래에서 위로), 같은 y면 x=0부터
  const ay = Math.floor(a.y);
  const by = Math.floor(b.y);
  if (ay !== by) return ay - by;
  const ax = Math.floor(a.x);
  const bx = Math.floor(b.x);
  if (ax !== bx) return ax - bx;
  const al = Math.floor((a as any).layer ?? 0);
  const bl = Math.floor((b as any).layer ?? 0);
  if (al !== bl) return al - bl;
  return String(a.type).localeCompare(String(b.type));
}

function trimPatternToBudget(pattern: BoardObject[], budget: number): BoardObject[] {
  if (budget <= 0) return [];
  const sorted = pattern.slice().sort(sortForTrim);
  const out: BoardObject[] = [];
  let remain = budget;

  for (const o of sorted) {
    const w = objWeight(o);
    if (w <= 0) {
      // blockCount에 포함되지 않는 오브젝트는 포함/제외가 공급량과 무관하므로 그대로 포함하지 않습니다(혼동 방지).
      continue;
    }
    if (remain <= 0) break;

    if ((o.type === 'BLOCK_LARGE' || o.type === 'BLOCK_LARGE_HIDDEN') && w > remain) {
      // ✅ 라지 블록은 hp로 카운트되므로 남은 수량에 맞춰 hp를 줄여서 정확히 맞춥니다.
      out.push({ ...(o as any), hp: remain } as BoardObject);
      remain = 0;
      break;
    }

    if (w <= remain) {
      out.push(o);
      remain -= w;
    }
  }

  return out;
}

// ✅ Supply(공급) 페이지에는 "낙하해서 채워지는 블럭"만 존재해야 합니다.
// - 체인/생성박스/기둥/키/락 등은 고정 오브젝트이므로 supply에 들어가면 안 됩니다.
// - 런타임 StageCompiler는 supply.pages에서 BLOCK_*만 파싱하므로,
//   export/materialize 단계에서도 동일하게 필터링해 게임/툴 불일치를 원천 차단합니다.
function isSupplyMovableBlock(o: BoardObject): boolean {
  const t = (o as any)?.type;
  return (
    t === 'BLOCK_NORMAL' ||
    t === 'BLOCK_SMALL' ||
    t === 'BLOCK_HIDDEN' ||
    t === 'BLOCK_LARGE' ||
    t === 'BLOCK_LARGE_HIDDEN'
  );
}

function filterSupplyPattern(pattern: BoardObject[]): BoardObject[] {
  const arr = Array.isArray(pattern) ? pattern : [];
  return arr.filter(isSupplyMovableBlock);
}

function materializeSupplyPagesForExport(stage: StageV2): Array<{ objects: BoardObject[] }> {
  const initialAll = stage.board.objects ?? [];
  // ✅ initialCount는 "전체 고정/특수 오브젝트"를 포함한 실제 필요 타수 기준이어야 합니다.
  // (스포너 hp/라지 hp/체인 등)
  const initialCount = calcInitialBlocks(initialAll, 10, 10);
  const goal = Math.max(0, Math.floor((stage.meta as any).blockCount ?? 0));
  let need = Math.max(0, goal - initialCount);
  if (need <= 0) return [];

  // ✅ supply.pages는 낙하 블럭만 유효합니다.
  // - 사용자가 실수로 체인/스포너/기둥 등을 넣어도 export 단계에서 자동 제외합니다.
  const initial = filterSupplyPattern(initialAll);

  const rawSupplyPages = stage.supply?.pages ?? [];
  const supplyPatterns = rawSupplyPages.map((p) => filterSupplyPattern((p?.objects ?? []) as any));
  const seqLen = 1 + supplyPatterns.length; // [초기] + [공급1..]

  const out: Array<{ objects: BoardObject[] }> = [];
  // ✅ supply 패턴이 비어있을 때의 상속 대상도 "낙하 블럭"만 포함해야 합니다.
  let lastEffective: BoardObject[] = initial;

  // k=1부터 시작: (초기) 이후부터 pages에 기록해야 하므로
  for (let k = 1; need > 0; k++) {
    const idx = seqLen > 0 ? k % seqLen : 0;
    const raw = idx === 0 ? initial : supplyPatterns[idx - 1];
    const effective = raw && raw.length > 0 ? raw : lastEffective;
    if (effective.length > 0) lastEffective = effective;

    const pageCount = calcInitialBlocks(effective, 10, 10);
    if (pageCount <= 0) {
      // 공급 패턴이 완전히 비어있으면 더 이상 채울 수 없으므로 종료(validator가 잡도록)
      break;
    }

    if (need >= pageCount) {
      out.push({ objects: effective.slice() });
      need -= pageCount;
    } else {
      out.push({ objects: trimPatternToBudget(effective, need) });
      need = 0;
    }
  }

  return out;
}

function asNumber(v: any, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clampInt(n: number, lo: number, hi: number): number {
  const v = Math.floor(Number.isFinite(n) ? n : 0);
  return Math.max(lo, Math.min(hi, v));
}

function applySimAndMakeHint(stage: StageV2, authored: any[]): { authored: any[]; equipOrder: string[] } {
  // StageCompiler의 시뮬레이션 게이트(보드 룰 반영)를 그대로 이용해
  // 카드 덱 순서를 '막힘이 없도록' 보정한 결과를 힌트 순번(1..N)으로 사용합니다.
  // - 컴파일러는 color/token을 normalize하므로 authored에는 color 또는 colorId가 있어야 합니다.
  const tmpStage: any = JSON.parse(JSON.stringify(stage));
  tmpStage.cards = { mode: 'AUTHORED', authored: authored.map((a: any) => ({ color: a.color, ammo: a.ammo, shotCount: a.shotCount })) };
  // compileRuntimeFromV2는 내부에서 cards 배열을 보정(프로모트/힌트 당김)하며,
  // AUTHORED 합계 검증도 수행합니다.
  const rt: any = compileRuntimeFromV2(tmpStage as any);
  const outAuthored: any[] = [];
  const outEquip: string[] = [];
  const cards: any[] = rt.cards ?? [];
  for (let i = 0; i < cards.length; i++) {
    const c = cards[i];
    const token = COLOR_TOKEN_ORDER[c.colorId] ?? 'R';
    const sc = (c.shotCount === 2 ? 2 : 1);
    outAuthored.push({ color: token, ammo: c.ammo, shotCount: sc, hintStep: i + 1 });
    outEquip.push(`${token}${sc}`);
  }
  return { authored: outAuthored, equipOrder: outEquip };
}



function applySimOrderToAuthored(stage: any, authored: any[]) {
  // "진짜 A" : 게임 StageCompiler로 StageRuntime을 만든 뒤,
  // 엔진-비의존 시뮬(CoreSim)로 "slot full & all no-target => FAIL" 기준을 통과하는
  // 장착 시퀀스를 찾아 hintStep(1..N) + equipOrder(전체 덱)로 저장합니다.
  const stageForCompile: any = JSON.parse(JSON.stringify(stage));
  stageForCompile.cards = { mode: 'AUTHORED', authored: authored.map((a: any) => ({
    colorId: colorIdFromToken(String(a.color).toUpperCase()),
    ammo: a.ammo,
    shotCount: (a.shotCount ?? 1),
  })) };

  const rt: any = compileRuntimeFromV2(stageForCompile);
  const plan = simulateGuaranteedEquipPlan(rt);

  // ✅ Export 직전 "보장 검증"(PASS/FAIL)
  // - FAIL이면 JSON을 내보내지 않고, 어디서 막혔는지 스냅샷을 에러로 던집니다.
  try {
    const vr = verifyGuaranteedEquipPlan(rt, plan, COLOR_TOKEN_ORDER as any);
    if (!vr.ok) {
      const msg = `GUARANTEE_VERIFY_FAILED stageId=${(stage?.id ?? -1)} failEquipStep=${vr.failEquipStep} remaining=${vr.remainingTiles}`;
      console.error(msg, vr.snapshot);
      throw new Error(msg);
    }
  } catch (e) {
    // rethrow to block export
    throw e;
  }
  const { ordered, equipOrder } = applyPlanToCards(rt, plan, COLOR_TOKEN_ORDER);
  const out = ordered.map((c: any) => {
    const token = COLOR_TOKEN_ORDER[c.colorId] ?? 'R';
    return { color: token, ammo: c.ammo, shotCount: (c.shotCount ?? 1) as 1 | 2, hintStep: c.hintStep };
  });
  return { authored: out, equipOrder };
}
function normalizeObjects(objs: any[]): BoardObject[] {
  if (!Array.isArray(objs)) return [];
  const out: BoardObject[] = [];
  for (const o of objs) {
    if (!o || typeof o !== 'object') continue;
    const type = String(o.type ?? '');
    const x = asNumber(o.x, 0);
    const y = asNumber(o.y, 0);
    const u = typeof o.uid === 'string' ? o.uid : uid();
    const layer = o.layer == null ? 0 : clampInt(asNumber(o.layer, 0), 0, 4);

    // color normalize
    const color = COLOR12.includes(o.color) ? o.color : 'R';

    switch (type) {
      case 'BLOCK_NORMAL':
        out.push({ uid: u, type: 'BLOCK_NORMAL', x, y, color, layer });
        break;
      case 'BLOCK_LARGE':
        out.push({
          uid: u,
          type: 'BLOCK_LARGE',
          x,
          y,
          w: 2,
          h: 2,
          color,
          hp: clampInt(asNumber((o as any).hp, 80), 1, 999999),
          layer,
        });
        break;
      case 'BLOCK_LARGE_HIDDEN':
        out.push({
          uid: u,
          type: 'BLOCK_LARGE_HIDDEN',
          x,
          y,
          w: 2,
          h: 2,
          color,
          hp: clampInt(asNumber((o as any).hp, 80), 1, 999999),
          revealRule: 'REACH_BOTTOM',
          layer,
        });
        break;
      case 'PILLAR':
        out.push({ uid: u, type: 'PILLAR', x, y, h: asNumber(o.h, 10), layer });
        break;
      case 'BLOCK_HIDDEN':
        out.push({ uid: u, type: 'BLOCK_HIDDEN', x, y, color,
          revealRule: 'REACH_BOTTOM', layer });
        break;
      case 'CHAIN_BARRIER':
        out.push({
          uid: u,
          type: 'CHAIN_BARRIER',
          x,
          y,
          color,
          layer,
          chainId: (o as any).chainId ?? (o as any).chainGroupId ?? undefined,
          chainOrder: (o as any).chainOrder ?? undefined,
          chainLen: (o as any).chainLen ?? undefined,
        });
        break;
      case 'KEY':
        out.push({ uid: u, type: 'KEY', x, y, keyId: String(o.keyId ?? 'A'), layer });
        break;
      case 'LOCK':
        out.push({ uid: u, type: 'LOCK', x, y, lockId: String(o.lockId ?? 'A'), layer });
        break;
      case 'SPAWNER_BOX':
        out.push({
          uid: u,
          type: 'SPAWNER_BOX',
          x,
          y,
          // ✅ 생성박스(2x2) 정규화
          w: 2,
          h: ((): 1 | 2 => {
            const hh = Math.floor(asNumber((o as any).h, 2));
            return (hh === 1 ? 1 : 2) as 1 | 2;
          })(),
          hp: asNumber((o as any).hp, asNumber(o.spawnCount, 10)),
          // 구버전 호환(남겨두되, 신규 로직은 hp 우선)
          spawnCount: (o as any).spawnCount != null ? asNumber(o.spawnCount, 0) : undefined,
          spawn: {
            poolColors: Array.isArray((o as any).spawn?.poolColors)
              ? (o as any).spawn.poolColors.filter((c: any) => COLOR12.includes(c))
              : Array.isArray((o as any).poolColors)
                ? (o as any).poolColors.filter((c: any) => COLOR12.includes(c))
                : ['R'],
          },
          layer,
        });
        break;
      default:
        // unknown type: ignore
        break;
    }
  }
  return out;
}

function normalizeSupply(stage: any): StageV2['supply'] {
  // ✅ 신규 포맷: supply.pages
  const rawNew = stage?.supply?.pages;
  if (Array.isArray(rawNew)) {
    return { mode: 'PATTERN', pages: rawNew.map((p: any) => ({ objects: normalizeObjects(p?.objects ?? []) })) };
  }

  // ✅ 구버전 호환: supplyPages.pages
  const rawOld = stage?.supplyPages?.pages;
  if (Array.isArray(rawOld)) {
    return { mode: 'PATTERN', pages: rawOld.map((p: any) => ({ objects: normalizeObjects(p?.objects ?? []) })) };
  }

  // ✅ 기본: 공급 패턴 없음(초기 패턴 반복 규칙)
  return { mode: 'PATTERN', pages: [] };
}

export function parsePack(jsonText: string): StagePackV2 {
  const raw = JSON.parse(jsonText) as any;
  if (!raw || typeof raw !== 'object') throw new Error('JSON 형식이 올바르지 않습니다.');
  if (raw.schemaVersion !== 2) throw new Error(`schemaVersion=2 JSON만 Import 가능합니다. (현재: ${raw.schemaVersion})`);

  const stagesRaw = Array.isArray(raw.stages) ? raw.stages : [];
  const stages: StageV2[] = stagesRaw
		.map((s: any, idx: number) => {
      const id = clampInt(asNumber(s?.id, idx + 1), 1, 999999);
      const objects = normalizeObjects(s?.board?.objects ?? []);
      const initial = calcInitialBlocks(objects, 10, 10);

      const meta = {
        blockCount: clampInt(asNumber(s?.meta?.blockCount, initial), 1, 999999),
        layerCount: clampInt(asNumber(s?.meta?.layerCount, 1), 1, 5),
        // colorCount는 툴에서 “실제 배치된 색” 기반으로 자동 계산되므로, Import 기본값은 1로 둡니다.
        colorCount: clampInt(asNumber(s?.meta?.colorCount, 1), 1, COLOR12.length),
        // ✅ 캐넌 장착 슬롯/대기라인(3~5)
        slotCount: clampInt(asNumber(s?.meta?.slotCount, 3), 3, 5),
        // waitLineCount는 3~5 범위에서 편집 가능
        waitLineCount: clampInt(asNumber(s?.meta?.waitLineCount, 3), 3, 5),

        // ✅ 슈터 카운트(툴 설정값)
        connectShooterCount: clampInt(asNumber(s?.meta?.connectShooterCount, 0), 0, 99),
        hiddenShooterCount: clampInt(asNumber(s?.meta?.hiddenShooterCount, 0), 0, 99),
        // lockShooterCount는 LOCK 블록 기반 자동(여기선 일단 값만 받아두고, store.recalcSupply에서 덮어씁니다)
        lockShooterCount: clampInt(asNumber(s?.meta?.lockShooterCount, 0), 0, 999),
        ammoMin: clampInt(asNumber(s?.meta?.ammoMin, 40), 10, 99999),
        ammoMax: clampInt(asNumber(s?.meta?.ammoMax, 50), 10, 99999),
        seed: s?.meta?.seed == null ? undefined : clampInt(asNumber(s?.meta?.seed, 1000 + id), 0, 0x7fffffff),
        pickerCols: clampInt(asNumber(s?.meta?.pickerCols, 2), 1, 10),
        // pickerMaxCards는 (대기라인 x 피커 열수)로 자동 계산
        pickerMaxCards: clampInt(
          clampInt(asNumber(s?.meta?.pickerCols, 2), 1, 10) * clampInt(asNumber(s?.meta?.waitLineCount, 3), 3, 5),
          1,
          50,
        ),
      };

      // ✅ 안전장치: Import 데이터가 ammoMin > ammoMax로 들어오는 경우가 있어
      // 툴 내부 상태에서는 항상 min<=max를 유지합니다.
      if (meta.ammoMin > meta.ammoMax) {
        const t = meta.ammoMin;
        meta.ammoMin = meta.ammoMax;
        meta.ammoMax = t;
      }

      const supply = normalizeSupply(s);

      const cards = {
        mode: (s?.cards?.mode === 'AUTHORED' ? 'AUTHORED' : 'GENERATE') as 'GENERATE' | 'AUTHORED',
        rules: s?.cards?.rules ?? { ammoStep: 10, totalAmmoEquals: 'BOARD_BLOCKS' },
        authored: Array.isArray(s?.cards?.authored) ? s.cards.authored : undefined,
      };

      const shooters = {
        slots: Array.isArray(s?.shooters?.slots) ? s.shooters.slots : [],
      };

      const stage: StageV2 = {
        id,
        meta,
        board: { w: 10, h: 10, objects },
        supply,
        cards,
        shooters,
      };

      return stage;
		})
		.sort((a: StageV2, b: StageV2) => a.id - b.id);

  return { schemaVersion: 2, stages };
}

export function uidTimeForExport(u: string): number {
  const parts = String(u ?? '').split('_');
  const t36 = parts[parts.length - 1] ?? '';
  const t = parseInt(t36, 36);
  return Number.isFinite(t) ? t : 0;
}

// ✅ Export 전용: CHAIN_BARRIER를 "체인 묶음"으로 동작시키기 위한 보조 필드(chainId/chainOrder)를 굽습니다.
// - 내부 편집 데이터는 uid 기반으로 머리/꼬리를 표시하지만, 게임에 Export할 때 uid는 제거됩니다.
// - 따라서 Export 시점에만 chainId/chainOrder를 추가해서 '꼬리부터 줄어드는' 실제 로직이 재현되도록 합니다.
// - 그룹 기준: 같은 layer 내에서 4방향 인접(connected-component)
function exportObjectsStripUidAndBakeChain(objs: any[]): any[] {
  const all = (objs ?? []) as any[];

  // ✅ 체인은 “가로(행)로 연속된 셀”을 1개의 체인으로 묶어 export 합니다.
  // - chainId가 이미 있으면 그 그룹을 유지(단, layer를 포함해서 충돌 방지)
  // - chainId가 없으면: (layer, y, color) 기준으로 x 연속 구간을 자동 그룹핑
  const chainObjs = all.filter((o: any) => o?.type === 'CHAIN_BARRIER') as any[];

  const uidToBake = new Map<string, { chainId: string; chainOrder: number; chainLen: number }>();
  let autoSeq = 0;

  const getLayer = (o: any) => (Math.floor(o?.layer ?? 0) | 0) as number;
  const getColor = (o: any) => normalizeColor(o?.color);

  // 1) explicit chainId groups
  const explicitGroups = new Map<string, any[]>();
  const missing: any[] = [];

  for (const o of chainObjs) {
    const layer = getLayer(o);
    const raw = String(o?.chainId ?? o?.chainGroupId ?? '').trim();
    if (raw) {
      const key = `${layer}|${raw}`;
      const arr = explicitGroups.get(key) ?? [];
      arr.push(o);
      explicitGroups.set(key, arr);
    } else {
      missing.push(o);
    }
  }

  for (const [key, arr] of explicitGroups) {
    const [layerStr, raw] = key.split('|');
    const layer = parseInt(layerStr, 10) || 0;
    const cid = `CHAIN_L${layer}_${raw}`;

    // 같은 row에서 x 증가 순으로 정렬(체인은 가로)
    arr.sort((a, b) => ((a.y ?? 0) | 0) - ((b.y ?? 0) | 0) || (((a.x ?? 0) | 0) - ((b.x ?? 0) | 0)));

    // row별로 split (혹시 다른 y가 섞여 있으면 분리)
    const byRow = new Map<number, any[]>();
    for (const o of arr) {
      const y = (o.y ?? 0) | 0;
      const r = byRow.get(y) ?? [];
      r.push(o);
      byRow.set(y, r);
    }

    for (const [, rowArr] of byRow) {
      rowArr.sort((a, b) => (((a.chainOrder ?? 1e9) as number) - ((b.chainOrder ?? 1e9) as number)) || (((a.x ?? 0) | 0) - ((b.x ?? 0) | 0)));
      const chainLen = rowArr.length;
      for (let i = 0; i < rowArr.length; i++) {
        const u = rowArr[i].uid;
        uidToBake.set(u, { chainId: cid, chainOrder: i, chainLen });
      }
    }
  }

  // 2) missing chainId -> auto group by (layer,y,color) + consecutive x runs
  const byKey = new Map<string, any[]>();
  for (const o of missing) {
    const layer = getLayer(o);
    const y = (o.y ?? 0) | 0;
    const c = getColor(o);
    const k = `${layer}|${y}|${c}`;
    const arr = byKey.get(k) ?? [];
    arr.push(o);
    byKey.set(k, arr);
  }

  for (const [k, arr] of byKey) {
    arr.sort((a, b) => (((a.x ?? 0) | 0) - ((b.x ?? 0) | 0)));
    let run: any[] = [];

    const flush = (layer: number, y: number, c: string) => {
      if (!run.length) return;
      const cid = `CHAIN_AUTO_${layer}_${y}_${c}_${autoSeq++}`;
      const chainLen = run.length;
      for (let i = 0; i < run.length; i++) {
        const u = run[i].uid;
        uidToBake.set(u, { chainId: cid, chainOrder: i, chainLen });
      }
      run = [];
    };

    const [layerStr, yStr, c] = k.split('|');
    const layer = parseInt(layerStr, 10) || 0;
    const y = parseInt(yStr, 10) || 0;

    for (let i = 0; i < arr.length; i++) {
      const o = arr[i];
      if (!run.length) {
        run.push(o);
        continue;
      }
      const prev = run[run.length - 1];
      const px = (prev.x ?? 0) | 0;
      const x = (o.x ?? 0) | 0;
      if (x === px + 1) run.push(o);
      else {
        flush(layer, y, c);
        run.push(o);
      }
    }
    flush(layer, y, c);
  }

  // 3) Export: uid 제거 + baked chain 필드 적용
  return all.map((o: any) => {
    const u = o.uid;
    const baked = uidToBake.get(u);

    // uid 제거
    const { uid, ...rest } = o;

    if (!baked) return rest;

    return {
      ...rest,
      chainId: baked.chainId,
      chainOrder: baked.chainOrder,
      chainLen: baked.chainLen,
    };
  });
}


// Export pack JSON for the game.
// - opts.exportClearGuaranteedCards=true: bake supply pages + authored cards + equipOrder (guaranteed clear)
// - default(false): export as-is (still bakes chain fields & materializes supply pages)
export function packToJson(pack: StagePackV2, opts?: { exportClearGuaranteedCards?: boolean }): string {
  assertRuntimeCompilerBaselineForExport();
  // ✅ buildId: 게임에서 "이 JSON이 실제로 로드됐는지" 강제 확인용
  // - Export마다 달라져야 하므로 ISO time 기반으로 생성
  const buildId = new Date().toISOString();

  const plain = {
    schemaVersion: 2,
    buildId,
    stages: pack.stages
      .slice()
			.sort((a: StageV2, b: StageV2) => a.id - b.id)
      .map((s) => ({
        ...s,
        // ✅ 클리어보장 Export에서는 ammoMin/ammoMax를 20/30 우선도에 맞게 고정합니다.
        // - stage.meta에 10이 남아있으면 authored가 10 위주로 분할되어(또는 게임 측의 기대와 어긋나)
        //   데드락/불일치가 발생할 수 있습니다.
        meta: (() => {
          if (!opts?.exportClearGuaranteedCards) return s.meta;
          const m: any = { ...(s.meta as any) };
          m.ammoMin = 20;
          m.ammoMax = 30;
          return m;
        })(),
        board: {
          ...s.board,
          objects: exportObjectsStripUidAndBakeChain(s.board.objects),
        },
        // ✅ Export 시점에만 supply.pages를 “목표 blockCount를 만족하도록” 구체화(materialize)합니다.
        // 역할:
        // - 사용자가 공급을 안 건드렸다면: 초기 패턴을 반복해서 필요한 만큼 supply.pages에 기록
        // - supply 패턴이 있다면: [초기 → 공급1 → ...] 순차 반복으로 supply.pages를 기록
        // - 페이지가 비어있으면(objects=[]): 직전 패턴을 상속(inherit)
        // - 마지막 페이지는 부족분만큼 y=0 라인부터 잘라서 채움(라지는 hp를 줄여 정확히 맞춤)
        supply: (() => {
          const mats = materializeSupplyPagesForExport(s);
          return {
            mode: 'PATTERN',
            pages: mats.map((p) => ({
              objects: exportObjectsStripUidAndBakeChain(p.objects ?? []),
            })),
          };
        })(),
        // ✅ 옵션: Export 시 “클리어 보장 분배(=AUTHORED cards)”를 함께 내보냅니다.
        // - stage.cards.mode는 AUTHORED로 바뀌고
        // - authored는 (초기 보드 + materialize된 supply.pages)의 색상별 필요 타수에 정확히 일치하도록 생성됩니다.
        cards: (() => {
          if (!opts?.exportClearGuaranteedCards) return s.cards;
          const mats = materializeSupplyPagesForExport(s);

          // 1) 색상별 필요 타수(초기 보드 + materialize된 supply.pages)에 정확히 맞춘 authored 생성
          const authored0 = buildClearGuaranteedAuthoredCards(s, mats);

          // 2) ✅ 게임 StageCompiler(시뮬 게이트 포함)로 컴파일하여
          //    - authored ammo mismatch를 강제 검증하고
          //    - deadlock 완화 정렬(promoteColorIntoShooters 등)이 적용된 "최종 카드 순서"를 얻습니다.
          const stageForCompile: any = {
            ...s,
            supply: {
              mode: 'PATTERN',
              pages: mats.map((p) => ({
                objects: exportObjectsStripUidAndBakeChain(p.objects ?? []),
              })),
            },
            cards: { mode: 'AUTHORED', authored: authored0 },
          };

          const rt = compileRuntimeFromV2(stageForCompile);

          // 3) ✅ CoreSim 기준으로 "slot full & all no-target => FAIL"까지 포함해
          //    실제 클리어 보장 검증을 통과한 장착 시퀀스를 산출합니다.
          // Try hard to find a guaranteed non-deadlocking equip sequence.
          // Some authored stages require escaping early "slot full & no-target" deadlocks.
          const r = simulateGuaranteedEquipPlanGuaranteed(rt as any, COLOR_TOKEN_ORDER as any, { maxAttempts: 5000 });
          if (!r.verify.ok) {
            const vr: any = r.verify as any;
            const msg = `GUARANTEE_VERIFY_FAILED stageId=${(s?.id ?? -1)} failEquipStep=${vr.failEquipStep} remaining=${vr.remainingTiles}`;
            const err: any = new Error(msg);
            err.name = 'GUARANTEE_VERIFY_FAILED';
            err.details = { stageId: (s?.id ?? -1), failEquipStep: vr.failEquipStep, remainingTiles: vr.remainingTiles, desiredColor: vr.desiredColor ?? null, snapshot: vr.snapshot ?? null, stats: (r as any).stats ?? null };
            console.error(msg, vr.snapshot);
            throw err;
          }

          const { ordered } = applyPlanToCards(rt as any, r.plan as any, COLOR_TOKEN_ORDER as any);

          // 4) ordered(=최종 순서)를 token 기반 authored로 되돌리고, hintStep(1..N)을 모든 카드에 부여
          const authored: any[] = [];
          for (let i = 0; i < (ordered?.length ?? 0); i++) {
            const c: any = ordered[i];
            const colorId = (c.colorId ?? 0) | 0;
            const token = (COLOR_TOKEN_ORDER as any)[colorId] ?? 'R';
            const ammo = (c.ammo ?? 0) | 0;
            const sc = (c.shotCount ?? (ammo >= 30 ? 2 : 1)) as 1 | 2;
            authored.push({ color: token, ammo, shotCount: sc, hintStep: c.hintStep ?? i + 1 });
          }

          return { mode: 'AUTHORED', authored } as any;
        })(),

        // ✅ 힌트: "순번대로 장착/사용"하면 클리어되도록 설계된 덱 순서(덱 전체)
        // - cards.authored[*].hintStep(1..N)와 1:1로 대응
        equipOrder: (() => {
          if (!opts?.exportClearGuaranteedCards) return (s as any).equipOrder;
          const mats = materializeSupplyPagesForExport(s);
          const authored0 = buildClearGuaranteedAuthoredCards(s, mats);
          const stageForCompile: any = {
            ...s,
            supply: {
              mode: 'PATTERN',
              pages: mats.map((p) => ({
                objects: exportObjectsStripUidAndBakeChain(p.objects ?? []),
              })),
            },
            cards: { mode: 'AUTHORED', authored: authored0 },
          };
          const rt = compileRuntimeFromV2(stageForCompile);
          const r = simulateGuaranteedEquipPlanGuaranteed(rt as any, COLOR_TOKEN_ORDER as any, { maxAttempts: 5000 });
          if (!r.verify.ok) {
            const vr: any = r.verify as any;
            const msg = `GUARANTEE_VERIFY_FAILED stageId=${(s?.id ?? -1)} failEquipStep=${vr.failEquipStep} remaining=${vr.remainingTiles}`;
            const err: any = new Error(msg);
            err.name = 'GUARANTEE_VERIFY_FAILED';
            err.details = { stageId: (s?.id ?? -1), failEquipStep: vr.failEquipStep, remainingTiles: vr.remainingTiles, desiredColor: vr.desiredColor ?? null, snapshot: vr.snapshot ?? null, stats: (r as any).stats ?? null };
            console.error(msg, vr.snapshot);
            throw err;
          }
          const { equipOrder } = applyPlanToCards(rt as any, r.plan as any, COLOR_TOKEN_ORDER as any);
          return equipOrder;
        })(),
      })),

  };
  return JSON.stringify(plain, null, 2);
}

export type ExportGuaranteeProgress = {
  stageId: number;
  stageIndex: number;
  stageCount: number;
  attempt: number;
  maxAttempts: number;
  phase: 'attempt' | 'refine' | 'done';
  refineIter?: number;
  failEquipStep?: number;
  remainingTiles?: number;
  deadlyRejected?: number;
  deadlyTotal?: number;
  pushOutCandidates?: number;
  pushOutImproved?: number;
};

// ✅ Export 전용(클리어 보장 + 재시도 + 진행률)
// - UI가 멈추지 않도록 async planner를 사용하고 주기적으로 yield 합니다.
// - PASS가 나온 경우에만 JSON을 반환합니다(FAIL이면 throw).
export async function packToJsonClearGuaranteedAsync(
  pack: StagePackV2,
  onProgress?: (p: ExportGuaranteeProgress) => void
): Promise<string> {
  assertRuntimeCompilerBaselineForExport();
  const buildId = new Date().toISOString();
  const stages = pack.stages.slice().sort((a: StageV2, b: StageV2) => a.id - b.id);
  const stageCount = stages.length;

  const outStages: any[] = [];
  for (let si = 0; si < stages.length; si++) {
    const s = stages[si];
    const id = (s?.id ?? -1) | 0;

    // meta 고정(ammo 20/30)
    const meta: any = { ...(s.meta as any) };
    meta.ammoMin = 20;
    meta.ammoMax = 30;

    const mats = materializeSupplyPagesForExport(s);

    // 1) authored 생성
    const authored0 = buildClearGuaranteedAuthoredCards(s, mats);

    // 2) stage 컴파일
    const stageForCompile: any = {
      ...s,
      meta,
      supply: {
        mode: 'PATTERN',
        pages: mats.map((p) => ({
          objects: (p.objects ?? []).map((o: any) => {
            const { uid: _uid, ...rest } = o;
            return rest;
          }),
        })),
      },
      cards: { mode: 'AUTHORED', authored: authored0 },
    };
    const rt = compileRuntimeFromV2(stageForCompile);

    // 3) async planner + verify
    const r = await simulateGuaranteedEquipPlanGuaranteedAsync(rt as any, COLOR_TOKEN_ORDER as any, {
      maxAttempts: 5000,
      yieldEveryAttempts: 10,
      onProgress: (p) =>
        onProgress?.({
          stageId: id,
          stageIndex: si + 1,
          stageCount,
          attempt: p.attempt,
          maxAttempts: p.maxAttempts,
          phase: p.phase,
          refineIter: p.refineIter,
          failEquipStep: p.failEquipStep,
          remainingTiles: p.remainingTiles,
          deadlyRejected: (p as any).deadlyRejected,
          deadlyTotal: (p as any).deadlyTotal,
          pushOutCandidates: (p as any).pushOutCandidates,
          pushOutImproved: (p as any).pushOutImproved,
        }),
    });

    if (!r.verify.ok) {
      const vr: any = r.verify as any;
      const msg = `GUARANTEE_VERIFY_FAILED stageId=${id} failEquipStep=${vr.failEquipStep} remaining=${vr.remainingTiles}`;
      const err: any = new Error(msg);
      err.name = 'GUARANTEE_VERIFY_FAILED';
      err.details = { stageId: id, failEquipStep: vr.failEquipStep, remainingTiles: vr.remainingTiles, desiredColor: vr.desiredColor ?? null, snapshot: vr.snapshot ?? null, stats: (r as any).stats ?? null };
      console.error(msg, vr.snapshot);
      throw err;
    }

    const { ordered, equipOrder } = applyPlanToCards(rt as any, r.plan as any, COLOR_TOKEN_ORDER as any);

    const authored: any[] = [];
    for (let i = 0; i < (ordered?.length ?? 0); i++) {
      const c: any = ordered[i];
      const colorId = (c.colorId ?? 0) | 0;
      const token = (COLOR_TOKEN_ORDER as any)[colorId] ?? 'R';
      const ammo = (c.ammo ?? 0) | 0;
      const sc = (c.shotCount ?? (ammo >= 30 ? 2 : 1)) as 1 | 2;
      authored.push({ color: token, ammo, shotCount: sc, hintStep: c.hintStep ?? i + 1 });
    }

    outStages.push({
      ...s,
      meta,
      board: {
        ...s.board,
        objects: s.board.objects.map((o: any) => {
          const { uid: _uid, ...rest } = o;
          return rest;
        }),
      },
      supply: {
        mode: 'PATTERN',
        pages: mats.map((p) => ({
          objects: (p.objects ?? []).map((o: any) => {
            const { uid: _uid, ...rest } = o;
            return rest;
          }),
        })),
      },
      cards: { mode: 'AUTHORED', authored },
      equipOrder,
    });
  }

  return JSON.stringify({ schemaVersion: 2, buildId, stages: outStages }, null, 2);
}
