// Export-time "replay strict" repair.
//
// 목표:
// - 실제 게임에 가까운 replay 시뮬레이터(sim_replay.ts) 기준으로 STUCK이 발생하면
//   카드(유닛) 배치 순서(=deck order)만 수정해서 SOLVED 될 때까지 자동으로 재검증합니다.
// - StageCompiler/게임 로직을 건드릴 수 없는 상황에서도,
//   Export된 JSON 자체가 "리플레이에서도 스턱이 안 나는" 상태가 되도록 합니다.
//
// 제약:
// - 보드 배치/오브젝트는 절대 변경하지 않습니다.
// - 카드의 색/탄약 합계(색상별 총합)는 변경하지 않습니다. (StageCompiler AUTHORED 합계 검증 통과 목적)
// - 기본 전략: (1) STUCK 슬롯에 필요한 색을 스왑 주입 → (2) 남은 덱에서 필요한 색을 앞으로 당김

import { simulateStageReplay, type SimReplayResult } from './sim_replay';
import { COLOR_TOKEN_ORDER, colorIdFromToken, type ColorToken } from './runtime/Types';

type AuthoredCard = {
  color?: string | number;
  colorId?: number;
  ammo?: number;
  shotCount?: number;
  hintStep?: number;
  hintRank?: number;
  kind?: any;
};

export type ReplayRepairOpts = {
  maxIters?: number;
  maxRounds?: number;
  maxShots?: number;
  /**
   * strict 모드(기본 true): 덱 순서 재배치 + 탄약 재분배 외 연산(강제 GENERATE baseline, GA 탐색, hint-step GA)을 금지합니다.
   */
  strictDeckAmmoOnly?: boolean;
  /**
   * If true (default), when a stage is not SOLVED on the first replay pass,
   * we rebuild a baseline deck by forcing StageCompiler GENERATE once and then repair again.
   * This improves convergence for some complex stages.
   */
  forceGenerateBaseline?: boolean;
  /** Debug/console logging toggle (UI may pass this). */
  verbose?: boolean;
  /**
   * Fallback stochastic search. Used when deterministic repairs can't resolve a replay STUCK.
   * Designed mainly for small/medium decks; automatically skipped for very large decks.
   */
  ga?: {
    enabled?: boolean;
    maxGens?: number;
    popSize?: number;
    elite?: number;
    maxEvals?: number;
  };

  /**
   * Hint-step GA (multi-column interleave).
   *
   * NOTE: The current StageCompiler normalizes hintStep in AUTHORED/FIXED mode,
   * so this is only meaningful for experimentation / MANUAL mode workflows.
   * It is disabled by default.
   */
  hintGa?: {
    enabled?: boolean;
    popSize?: number;
    elite?: number;
    maxGens?: number;
    maxEvals?: number;
  };
};

export type ReplayRepairReport = {
  iters: number;
  solved: boolean;
  lastStatus: SimReplayResult['status'];
  lastReason?: string;
  lastStuck?: SimReplayResult['stuck'];
  /** supply.pages 에서 제거된(=잘못 들어간) 고정 오브젝트 수 */
  supplySanitized?: { removed: number };
  history: Array<{
    iter: number;
    status: SimReplayResult['status'];
    reason?: string;
    deckIdx?: number;
    remaining?: number;
    clicked?: number;
    rounds?: number;
    shots?: number;
    nextHint?: number;
    didSlotSwap?: boolean;
    didReorder?: boolean;
    didDefer?: boolean;
    didShuffle?: boolean;
    didAmmoShift?: boolean;
    /**
     * Emergency escape for catastrophic deadlocks like FULL_AND_NO_TARGETS.
     * - swaps a needed-color card into a stuck slot position
     * - caps its ammo to a very small value (and shifts the remainder to the future)
     */
    didEscape?: boolean;
    didGa?: boolean;
    didHintGa?: boolean;
    backjump?: number;
  }>;
};


// ⚠️ Optional helper: supply.pages에서 BLOCK_*만 남기는 정리(=sanitize).
// - 현재 솔버/리페어 파이프라인에서는 '공급보드에 찍은 건 건들면 안 된다' 요구사항 때문에
//   기본적으로 호출하지 않습니다(=stage 원본 유지).
// - 참고: 런타임 StageCompiler는 supply.pages에서 BLOCK_*만 파싱하므로, 비-블럭 오브젝트가 있어도
//   게임/시뮬레이션 로직에는 영향이 없습니다(단, 데이터 정합성을 위해 별도 단계에서 호출할 수는 있음).
export function sanitizeSupplyPagesInPlace(stage: any): { removed: number } {
  const pages = stage?.supply?.pages;
  if (!Array.isArray(pages) || pages.length <= 0) return { removed: 0 };

  const isAllowed = (t: any): boolean =>
    t === 'BLOCK_NORMAL' || t === 'BLOCK_SMALL' || t === 'BLOCK_HIDDEN' || t === 'BLOCK_LARGE' || t === 'BLOCK_LARGE_HIDDEN';

  let removed = 0;
  for (let pi = 0; pi < pages.length; pi++) {
    const objs = pages[pi]?.objects;
    if (!Array.isArray(objs) || objs.length <= 0) continue;
    const before = objs.length;
    const afterArr = objs.filter((o: any) => isAllowed(String(o?.type ?? '')));
    const diff = before - afterArr.length;
    if (diff > 0) {
      removed += diff;
      pages[pi].objects = afterArr;
    }
  }
  return { removed };
}

// Keep in sync with the game compiler hard limits.
// (We use local constants here to avoid importing StageCompiler internals.)
const AMMO_HARD_MIN = 1;
// StageCompiler clamps authored ammo to 50 (see src/lib/runtime/stage/compileRuntimeFromV2.ts).
// If we exceed this during repair, the compiler will silently clamp and break per-color totals,
// potentially undoing fixes or causing "authored ammo mismatch" on the next compile.
const AMMO_HARD_MAX = 50;

function getCardColorId(cd: AuthoredCard): number {
  const v = (cd as any)?.colorId;
  if (typeof v === 'number') return v | 0;
  const c = (cd as any)?.color;
  if (typeof c === 'number') return c | 0;
  if (typeof c === 'string') return colorIdFromToken(c);
  return -1;
}

function pickTopNeedColors(need: Int32Array | number[], k: number): number[] {
  const ids: number[] = [];
  for (let i = 0; i < need.length; i++) {
    if (((need as any)[i] | 0) > 0) ids.push(i);
  }
  ids.sort((a, b) => (((need as any)[b] | 0) - ((need as any)[a] | 0)));
  return ids.slice(0, Math.max(0, k | 0));
}

// Pull a small set of "needed" colored cards to the front of a local window.
function reorderUpcomingDeckByNeed(
  deck: AuthoredCard[],
  deckIdx: number,
  needCounts: Int32Array,
  bringN: number,
  scanLimit = 64,
): boolean {
  if (!Array.isArray(deck) || deckIdx >= deck.length) return false;
  const bringCards = Math.max(1, bringN | 0);
  const needed: number[] = [];
  for (let c = 0; c < 12; c++) if ((needCounts[c] | 0) > 0) needed.push(c);
  if (needed.length <= 0) return false;

  const perColorCap = needed.length <= 1 ? bringCards : Math.max(2, Math.floor(bringCards / needed.length) + 2);
  const scanN = Math.max(bringCards, Math.max(8, scanLimit | 0));
  const scanEnd = Math.min(deck.length, deckIdx + scanN);
  const remain = deck.slice(deckIdx, scanEnd);
  if (remain.length <= 0) return false;

  const scored: Array<{ i: number; c: number; score: number }> = [];
  for (let i = 0; i < remain.length; i++) {
    const cd = remain[i];
    const c = getCardColorId(cd);
    if (c < 0 || c >= 12) continue;
    const n = needCounts[c] | 0;
    if (n <= 0) continue;
    const a = Math.max(0, ((cd as any)?.ammo ?? 0) | 0);
    const score = Math.min(999, Math.max(0, n)) * 1000 + Math.min(99, a);
    scored.push({ i, c, score });
  }
  if (scored.length <= 0) return false;
  scored.sort((x, y) => (y.score - x.score) || (x.i - y.i));

  const pickedIdx = new Set<number>();
  const perPicked = new Int32Array(12);
  for (const s of scored) {
    if (pickedIdx.size >= bringCards) break;
    if (needed.length > 1 && (perPicked[s.c] | 0) >= perColorCap) continue;
    pickedIdx.add(s.i);
    perPicked[s.c] += 1;
  }
  if (pickedIdx.size <= 0) return false;

  const picked: AuthoredCard[] = [];
  const rest: AuthoredCard[] = [];
  for (let i = 0; i < remain.length; i++) {
    if (pickedIdx.has(i)) picked.push(remain[i]);
    else rest.push(remain[i]);
  }

  const next = picked.concat(rest);
  for (let i = 0; i < next.length; i++) deck[deckIdx + i] = next[i];
  return true;
}

// Slot-level "swap injection": swap a needed color card from the future into a chosen stuck slot's deck position.
function repairSwapNeededIntoStuckSlots(deck: AuthoredCard[], stuck: NonNullable<SimReplayResult['stuck']>, need: Int32Array): boolean {
  if (!stuck || !Array.isArray(deck) || deck.length <= 0) return false;
  const deckIdx = (stuck.deckIdx ?? 0) | 0;
  const slotColors = Array.isArray(stuck.slotColors) ? stuck.slotColors : [];
  const slotAmmo = Array.isArray(stuck.slotAmmo) ? stuck.slotAmmo : [];
  const slotDeckPos = Array.isArray(stuck.slotDeckPos) ? stuck.slotDeckPos : [];
  const cap = slotColors.length | 0;
  if (cap <= 0 || slotDeckPos.length !== cap) return false;

  const presentCnt = new Int32Array(12);
  for (const c0 of slotColors) {
    const c = (c0 ?? -1) | 0;
    if (c >= 0 && c < 12) presentCnt[c] += 1;
  }

  // ✅ 남은 덱에 "실제로 존재하는" 색만 대상으로 삼습니다.
  // - 기존 로직은 needCounts가 같은 값(예: 1)인 경우, 덱에 없는 색(R/Y 등)을 먼저 고르는 바람에
  //   donor를 못 찾아 slot swap이 실패 → STUCK이 반복될 수 있었습니다.
  const deckColorCounts = Array.isArray((stuck as any).deckColorCounts) ? ((stuck as any).deckColorCounts as any[]) : [];
  const hasRemainingCard = (c: number) => ((deckColorCounts?.[c] ?? 0) | 0) > 0;

  // Pick ONE target color to inject.
  let target = -1;
  let bestW = -1;
  for (let c = 0; c < 12; c++) {
    const w = need[c] | 0;
    if (w <= 0) continue;
    if ((presentCnt[c] | 0) > 0) continue;
    if (!hasRemainingCard(c)) continue;
    if (w > bestW) {
      bestW = w;
      target = c;
    }
  }
  if (target < 0) {
    // fallback: 필요도가 높은 색 중에서 "덱에 남아있는" 후보를 찾습니다.
    const top = pickTopNeedColors(need, 8);
    let pick = -1;
    for (const c0 of top) {
      const c = (c0 ?? -1) | 0;
      if (c < 0 || c >= 12) continue;
      if ((presentCnt[c] | 0) > 0) continue;
      if (!hasRemainingCard(c)) continue;
      pick = c;
      break;
    }
    if (pick < 0) return false;
    target = pick;
  }

  // Pick a slot to replace.
  let pickSlot = -1;
  let bestScore = -1e18;
  for (let i = 0; i < cap; i++) {
    const sc = (slotColors[i] ?? -1) | 0;
    const pos = (slotDeckPos[i] ?? -1) | 0;
    if (pos < 0 || pos >= deck.length) continue;
    if (sc === target) continue;
    const a = (slotAmmo[i] ?? 0) | 0;
    const have = sc >= 0 && sc < 12 ? (presentCnt[sc] | 0) : 0;
    const neededNow = sc >= 0 && sc < 12 ? ((need[sc] | 0) > 0) : false;
    let score = 0;
    if (!neededNow) score += 2200;
    if (have >= 2) score += 800;
    score += Math.min(120, Math.max(0, a)) * 3;
    score += Math.max(0, pos - Math.max(0, deckIdx - 6)) * 0.15;
    if (score > bestScore) {
      bestScore = score;
      pickSlot = i;
    }
  }

  if (pickSlot < 0) {
    let bestA = -1;
    for (let i = 0; i < cap; i++) {
      const pos = (slotDeckPos[i] ?? -1) | 0;
      if (pos < 0 || pos >= deck.length) continue;
      const a = (slotAmmo[i] ?? 0) | 0;
      if (a > bestA) {
        bestA = a;
        pickSlot = i;
      }
    }
  }
  if (pickSlot < 0) return false;

  const pickPos = (slotDeckPos[pickSlot] ?? -1) | 0;
  if (pickPos < 0 || pickPos >= deck.length) return false;

  function findDonorLocal(colorId: number, startFrom: number, scanN: number): number {
    const start = Math.max(0, startFrom | 0);
    const end = Math.min(deck.length, start + Math.max(1, scanN | 0));
    for (let j = start; j < end; j++) {
      if (getCardColorId(deck[j]) === (colorId | 0)) return j;
    }
    return -1;
  }

  const startFrom = Math.max(0, deckIdx);
  let donor = findDonorLocal(target, startFrom, 80);
  if (donor < 0) donor = findDonorLocal(target, startFrom + 80, deck.length);
  if (donor < 0 || donor === pickPos) return false;

  const tmp = deck[pickPos];
  deck[pickPos] = deck[donor];
  deck[donor] = tmp;
  return true;
}

// More aggressive variant for catastrophic deadlocks (e.g., FULL_AND_NO_TARGETS):
// perform up to `maxSwaps` swap injections in one iteration.
function repairSwapNeededIntoStuckSlotsMulti(
  deck: AuthoredCard[],
  stuck: NonNullable<SimReplayResult['stuck']>,
  need: Int32Array,
  maxSwaps: number,
): boolean {
  if (!stuck || !Array.isArray(deck) || deck.length <= 0) return false;
  const cap = Math.max(0, (Array.isArray(stuck.slotColors) ? stuck.slotColors.length : 0) | 0);
  if (cap <= 0) return false;
  const limit = Math.max(1, Math.min(cap, maxSwaps | 0));

  const deckIdx = (stuck.deckIdx ?? 0) | 0;
  const slotColors = Array.isArray(stuck.slotColors) ? stuck.slotColors : [];
  const slotAmmo = Array.isArray(stuck.slotAmmo) ? stuck.slotAmmo : [];
  const slotDeckPos = Array.isArray(stuck.slotDeckPos) ? stuck.slotDeckPos : [];
  if (slotDeckPos.length !== cap) return false;

  const presentCnt = new Int32Array(12);
  for (const c0 of slotColors) {
    const c = (c0 ?? -1) | 0;
    if (c >= 0 && c < 12) presentCnt[c] += 1;
  }

  // NOTE: stuck.deckColorCounts represents suffix-counts from the stuck moment.
  // For FULL_AND_NO_TARGETS we often need to pull a needed color from *anywhere* in the deck
  // (because the replay will restart after we patch the authored deck).
  const deckColorCounts = Array.isArray((stuck as any).deckColorCounts) ? ((stuck as any).deckColorCounts as any[]) : [];
  const hasRemainingCard = (c: number) => ((deckColorCounts?.[c] ?? 0) | 0) > 0;
  const hasAnyCard = (c: number): boolean => {
    const cid = (c | 0);
    if (cid < 0 || cid >= 12) return false;
    for (let j = 0; j < deck.length; j++) {
      if (getCardColorId(deck[j]) === cid) return true;
    }
    return false;
  };

  const computeRescueCap = (colorId: number): number => {
    const n = Math.max(0, (need[colorId] ?? 0) | 0);
    // We want the injected slot-card to empty quickly to free the next click.
    // Too small(=1) can fail to expose follow-up targets; give a little slack.
    // Keep it small to avoid re-entering FULL_AND_NO_TARGETS with huge leftover ammo.
    const soft = Math.max(2, Math.min(12, n));
    return Math.max(AMMO_HARD_MIN, Math.min(AMMO_HARD_MAX, soft));
  };


// We want to inject "needed" colors into the stuck shooter slots.
// For FULL_AND_NO_TARGETS, all current slot colors have 0 shootable targets right now.
//
// Old behavior avoided injecting duplicate colors (presentCnt[c]>0), which can fail when the board
// currently only exposes 1~2 needed colors but the shooter has 3+ active slots.
// In that situation, leaving untouched "never-shoot" colors in other slots can permanently block progress.
//
// New behavior:
// - Prefer injecting colors missing from slots (diversity).
// - If missing-colors are fewer than available slots, allow duplicates by cycling top-needed colors.
const neededAll: number[] = [];
const neededMissing: number[] = [];

for (let c = 0; c < 12; c++) {
  const w = need[c] | 0;
  if (w <= 0) continue;
  if (!hasRemainingCard(c) && !hasAnyCard(c)) continue;
  neededAll.push(c);
  if ((presentCnt[c] | 0) <= 0) neededMissing.push(c);
}

neededAll.sort((a, b) => ((need[b] | 0) - (need[a] | 0)));
neededMissing.sort((a, b) => ((need[b] | 0) - (need[a] | 0)));

let targets: number[] = neededMissing.slice(0, Math.max(1, limit));

// Fallback: if nothing is strictly missing from slots, still try top-needed colors that exist.
if (targets.length <= 0) {
  targets = neededAll.slice(0, 8);
}
if (targets.length <= 0) return false;

// Fill to the swap budget by allowing duplicates (cycle through neededAll).
if (targets.length < limit && neededAll.length > 0) {
  let t = 0;
  while (targets.length < limit) {
    targets.push(neededAll[t % neededAll.length]);
    t += 1;
  }
}

  const usedSlots = new Set<number>();
  const usedDeckPos = new Set<number>();
  let did = false;
  let swaps = 0;

  const findDonor = (colorId: number, startFrom: number): number => {
    const cid = (colorId | 0);
    const start = Math.max(0, startFrom | 0);
    for (let j = start; j < deck.length; j++) {
      if (usedDeckPos.has(j)) continue;
      if (getCardColorId(deck[j]) === cid) return j;
    }
    // fallback: search the whole deck (still safe: swap doesn't change per-color totals)
    for (let j = 0; j < start; j++) {
      if (usedDeckPos.has(j)) continue;
      if (getCardColorId(deck[j]) === cid) return j;
    }
    return -1;
  };

  for (const target of targets) {
    if (swaps >= limit) break;

    // Pick a slot to replace (prefer high-ammo, non-needed colors, and duplicated colors).
    let pickSlot = -1;
    let bestScore = -1e18;
    for (let i = 0; i < cap; i++) {
      if (usedSlots.has(i)) continue;
      const sc = (slotColors[i] ?? -1) | 0;
      const pos = (slotDeckPos[i] ?? -1) | 0;
      if (pos < 0 || pos >= deck.length) continue;
      if (usedDeckPos.has(pos)) continue;
      if (sc === (target | 0)) continue;

      const a = (slotAmmo[i] ?? 0) | 0;
      const have = sc >= 0 && sc < 12 ? (presentCnt[sc] | 0) : 0;
      const neededNow = sc >= 0 && sc < 12 ? ((need[sc] | 0) > 0) : false;

      let score = 0;
      if (!neededNow) score += 2400;
      if (have >= 2) score += 900;
      score += Math.min(120, Math.max(0, a)) * 3;
      score += Math.max(0, pos - Math.max(0, deckIdx - 6)) * 0.15;
      // keep the first card a bit more stable, but do NOT forbid changing it:
      // some stages can deadlock forever if deck[0] is an oversized/no-target color.
      if (pos === 0) score -= 120;

      // Prefer replacing "never-fired" stuck cards first (spent==0).
      // These have contributed nothing so far but permanently block the rack.
      if (pos >= 0 && pos < deck.length) {
        const initAmmo = (((deck[pos] as any)?.ammo ?? 0) | 0);
        if (initAmmo > 0 && a > 0 && a <= initAmmo) {
          const spent = (initAmmo - a) | 0;
          if (spent <= 0) score += 520;
          else if (spent <= 2) score += 120;
        }
      }

      if (score > bestScore) {
        bestScore = score;
        pickSlot = i;
      }
    }

    if (pickSlot < 0) continue;
    const pickPos = (slotDeckPos[pickSlot] ?? -1) | 0;
    if (pickPos < 0 || pickPos >= deck.length) continue;

    const donor = findDonor(target, Math.max(0, deckIdx));
    if (donor < 0 || donor === pickPos) continue;

    // swap-inject
    const oldColor = (slotColors[pickSlot] ?? -1) | 0;
    swapInPlace(deck, pickPos, donor);
    usedSlots.add(pickSlot);
    usedDeckPos.add(pickPos);
    usedDeckPos.add(donor);

    if (oldColor >= 0 && oldColor < 12) presentCnt[oldColor] = Math.max(0, (presentCnt[oldColor] | 0) - 1);
    presentCnt[target] = (presentCnt[target] | 0) + 1;

    // Cap the injected card so it empties reasonably soon and does not re-lock the rack.
    // This is especially important for FULL_AND_NO_TARGETS where the stuck slots are often early deck positions.
    const injected: any = deck[pickPos];
    if (injected) {
      const wantCap = computeRescueCap(target);
      const sc = ((injected?.shotCount ?? 0) | 0);
      if (sc !== 1 && sc !== 2) injected.shotCount = wantCap >= 30 ? 2 : 1;
      capAmmoAndShiftToFuture(deck, pickPos, wantCap, deckIdx);
    }

    did = true;
    swaps += 1;
  }

  return did;
}

// Shift "dead" ammo away from cards that end up occupying shooter slots while having no targets.
// This helps when a shooter retains large leftover ammo and blocks equipping needed colors.
//
// Strategy:
// - For each stuck slot whose color is NOT needed at the stuck moment (need[color]==0),
//   reduce the originating card's ammo by up to `slotAmmo` (but keep >= AMMO_HARD_MIN),
//   and move that ammo into later cards of the same color (or append new cards).
function shiftDeadSlotAmmoToFuture(
  deck: AuthoredCard[],
  stuck: NonNullable<SimReplayResult['stuck']>,
  need: Int32Array,
  maxMoves: number,
): boolean {
  if (!stuck || !Array.isArray(deck) || deck.length <= 0) return false;

  const slotColors = Array.isArray(stuck.slotColors) ? stuck.slotColors : [];
  const slotAmmo = Array.isArray(stuck.slotAmmo) ? stuck.slotAmmo : [];
  const slotDeckPos = Array.isArray(stuck.slotDeckPos) ? stuck.slotDeckPos : [];
  const cap = slotColors.length | 0;
  if (cap <= 0 || slotDeckPos.length !== cap) return false;

  const deckIdx = Math.max(0, (stuck.deckIdx ?? 0) | 0);
  const limit = Math.max(1, Math.min(cap, maxMoves | 0));

  // Prefer large leftover-ammo slots first.
  const order = Array.from({ length: cap }, (_, i) => i);
  order.sort((a, b) => (((slotAmmo[b] ?? 0) | 0) - ((slotAmmo[a] ?? 0) | 0)));

  let did = false;
  let moves = 0;

  for (const si of order) {
    if (moves >= limit) break;

    const sc0 = (slotColors[si] ?? -1) | 0;
    if (sc0 < 0 || sc0 >= 12) continue;
    // Only shift when this color is not currently needed.
    if (((need[sc0] ?? 0) | 0) > 0) continue;

    const pos = (slotDeckPos[si] ?? -1) | 0;
    if (pos < 0 || pos >= deck.length) continue;

    const card: any = deck[pos];
    if (!card) continue;
    const cc = getCardColorId(card);
    const c = (cc >= 0 && cc < 12) ? cc : sc0;

    const a0 = ((card?.ammo ?? 0) | 0);
    const left = ((slotAmmo[si] ?? 0) | 0);
    if (a0 <= AMMO_HARD_MIN) continue;
    if (left <= 0) continue;

    // amount we can safely remove from this card
    const delta = Math.max(0, Math.min(left, a0 - AMMO_HARD_MIN));
    if (delta <= 0) continue;

    // Apply removal.
    card.ammo = (a0 - delta) | 0;

    // Distribute delta into later cards of same color, preferring far-future cards.
    let remaining = delta | 0;
    const start = Math.max(deckIdx, pos + 1);
    for (let j = deck.length - 1; j >= start && remaining > 0; j--) {
      const dj: any = deck[j];
      if (!dj) continue;
      if (getCardColorId(dj) !== c) continue;
      const aj = ((dj?.ammo ?? 0) | 0);
      const room = (AMMO_HARD_MAX - aj) | 0;
      if (room <= 0) continue;
      const take = Math.min(room, remaining);
      dj.ammo = (aj + take) | 0;
      remaining = (remaining - take) | 0;
    }

    // If no recipient existed or couldn't absorb fully, append new card(s).
    while (remaining > 0) {
      const give = Math.min(AMMO_HARD_MAX, remaining);
      const token = tokenFromColorId(c);
      const shotCount = ((card?.shotCount ?? 0) | 0) > 0 ? ((card?.shotCount ?? 1) | 0) : (give >= 30 ? 2 : 1);
      deck.push({
        color: (token === '?' ? (c | 0) : token) as any,
        ammo: give | 0,
        shotCount,
        kind: (card?.kind as any) ?? undefined,
      } as any);
      remaining = (remaining - give) | 0;
    }

    did = true;
    moves += 1;
  }

  return did;
}

// When FULL_AND_NO_TARGETS happens, the rack is full of cards whose colors have 0 shootable targets.
// The immediate blocker is the *remaining ammo* sitting in those stuck slots.
//
// We can often escape without randomization by shrinking each stuck-slot card's authored ammo down
// to exactly the amount it already managed to spend before the deadlock:
//   spent = initialAmmo - remainingAmmo
// Then that card would have been depleted (and ejected) at the deadlock point, freeing a click.
//
// IMPORTANT: we shift the removed ammo to future cards of the same color to keep per-color totals
// consistent with the StageCompiler's expected totals.
function trimSpentAmmoFromStuckSlots(
  deck: AuthoredCard[],
  stuck: NonNullable<SimReplayResult['stuck']>,
  maxSlots: number,
): boolean {
  const slotDeckPos: any[] = Array.isArray((stuck as any).slotDeckPos) ? ((stuck as any).slotDeckPos as any[]) : [];
  const slotAmmo: any[] = Array.isArray((stuck as any).slotAmmo) ? ((stuck as any).slotAmmo as any[]) : [];
  const deckIdx = ((stuck as any).deckIdx ?? 0) | 0;
  if (slotDeckPos.length <= 0 || slotAmmo.length <= 0) return false;

  const order = slotDeckPos.map((_, i) => i);
  // Prefer trimming the largest remaining ammo first.
  order.sort((a, b) => (((slotAmmo[b] ?? 0) | 0) - ((slotAmmo[a] ?? 0) | 0)));

  let did = false;
  let used = 0;
  for (const si of order) {
    if (used >= maxSlots) break;
    const pos = ((slotDeckPos[si] ?? -1) | 0);
    const rem = ((slotAmmo[si] ?? 0) | 0);
    if (pos < 0 || pos >= deck.length) continue;
    const card: any = deck[pos];
    const init = ((card?.ammo ?? 0) | 0);
    if (init <= 0) continue;
    if (rem <= 0) continue;
    if (rem > init) continue; // defensive (shouldn't happen)
    const spent = (init - rem) | 0;
    if (spent <= 0) continue; // card never fired; trimming won't help

    // Cap to spent so this card would have emptied at the deadlock point.
    const cap = Math.max(AMMO_HARD_MIN, Math.min(init, spent));
    capAmmoAndShiftToFuture(deck, pos, cap, deckIdx);
    // Keep shotCount consistent with ammo heuristic.
    const sc = ((card?.shotCount ?? 0) | 0);
    if (sc !== 1 && sc !== 2) card.shotCount = cap >= 30 ? 2 : 1;

    did = true;
    used += 1;
  }

  return did;
}

function xorshift32(seed: number): () => number {
  let x = (seed | 0) || 0x12345678;
  return () => {
    // xorshift32
    x ^= (x << 13);
    x ^= (x >>> 17);
    x ^= (x << 5);
    // unsigned → [0,1)
    return ((x >>> 0) / 4294967296);
  };
}

function swapInPlace<T>(arr: T[], i: number, j: number) {
  const tmp = arr[i];
  arr[i] = arr[j];
  arr[j] = tmp;
}

// Reduce ammo at `pos` down to `capAmmo` and move the removed ammo into future cards of the same color.
//
// Invariant: per-color total ammo is preserved.
function capAmmoAndShiftToFuture(
  deck: AuthoredCard[],
  pos: number,
  capAmmo: number,
  deckIdx: number,
): boolean {
  if (!Array.isArray(deck)) return false;
  if (pos < 0 || pos >= deck.length) return false;

  const card: any = deck[pos];
  if (!card) return false;

  const c = getCardColorId(card);
  if (c < 0 || c >= 12) return false;

  const a0 = ((card?.ammo ?? 0) | 0);
  const cap = Math.max(AMMO_HARD_MIN, Math.min(AMMO_HARD_MAX, (capAmmo | 0)));
  if (a0 <= cap) return false;

  const delta = (a0 - cap) | 0;
  if (delta <= 0) return false;

  // Apply cap.
  card.ammo = cap | 0;

  // Distribute into later cards of the same color.
  let remaining = delta | 0;
  const start = Math.max(0, Math.max(deckIdx | 0, (pos + 1) | 0));
  for (let j = deck.length - 1; j >= start && remaining > 0; j--) {
    const dj: any = deck[j];
    if (!dj) continue;
    if (getCardColorId(dj) !== (c | 0)) continue;
    const aj = ((dj?.ammo ?? 0) | 0);
    const room = (AMMO_HARD_MAX - aj) | 0;
    if (room <= 0) continue;
    const take = Math.min(room, remaining) | 0;
    dj.ammo = (aj + take) | 0;
    remaining = (remaining - take) | 0;
  }

  // If we couldn't absorb fully, append new card(s) of the same color.
  while (remaining > 0) {
    const give = Math.min(AMMO_HARD_MAX, remaining) | 0;
    const token = tokenFromColorId(c);
    const shotCount = ((card?.shotCount ?? 0) | 0) > 0 ? ((card?.shotCount ?? 1) | 0) : (give >= 30 ? 2 : 1);
    deck.push({
      color: (token === '?' ? (c | 0) : token) as any,
      ammo: give | 0,
      shotCount,
      kind: (card?.kind as any) ?? undefined,
    } as any);
    remaining = (remaining - give) | 0;
  }

  return true;
}

// Emergency escape for FULL_AND_NO_TARGETS:
// - swap a needed-color card into one of the stuck slot-origin positions
// - force that injected card to have tiny ammo (default 1) so it can quickly empty and free a slot
// - shift the removed ammo to the future (same color) to preserve per-color totals.
//
// This directly targets the pathological case:
//   "all shooter slots full" + "no shoot targets" → ammo never decreases → cannot equip next hint.
function escapeFullAndNoTargetsBySwapAndCap(
  deck: AuthoredCard[],
  stuck: NonNullable<SimReplayResult['stuck']>,
  need: Int32Array,
  maxSwaps: number,
  capAmmo = 0,
): boolean {
  if (!stuck || !Array.isArray(deck) || deck.length <= 1) return false;
  const capSlots = Math.max(0, (Array.isArray(stuck.slotDeckPos) ? stuck.slotDeckPos.length : 0) | 0);
  if (capSlots <= 0) return false;
  const limit = Math.max(1, Math.min(capSlots, maxSwaps | 0));

  const deckIdx = Math.max(0, (stuck.deckIdx ?? 0) | 0);
  const slotDeckPos = Array.isArray(stuck.slotDeckPos) ? stuck.slotDeckPos : [];
  const slotAmmo = Array.isArray(stuck.slotAmmo) ? stuck.slotAmmo : [];
  const slotColors = Array.isArray(stuck.slotColors) ? stuck.slotColors : [];

  // Candidate needed colors, highest need first.
  const targets = pickTopNeedColors(need, 8);
  if (targets.length <= 0) return false;

  // Prefer freeing the slot with the largest leftover ammo.
  const slotOrder = Array.from({ length: capSlots }, (_, i) => i);
  slotOrder.sort((a, b) => (((slotAmmo[b] ?? 0) | 0) - ((slotAmmo[a] ?? 0) | 0)));

  const usedSlots = new Set<number>();
  const usedDeckPos = new Set<number>();
  let did = false;
  let swaps = 0;

  const findDonor = (colorId: number): number => {
    for (let j = Math.max(0, deckIdx); j < deck.length; j++) {
      if (usedDeckPos.has(j)) continue;
      if (getCardColorId(deck[j]) === (colorId | 0)) return j;
    }
    // If nothing in suffix, allow searching whole deck (still preserves totals by swap+shift).
    for (let j = 1; j < Math.max(1, deckIdx); j++) {
      if (usedDeckPos.has(j)) continue;
      if (getCardColorId(deck[j]) === (colorId | 0)) return j;
    }
    return -1;
  };

  for (const target of targets) {
    if (swaps >= limit) break;
    const t = (target | 0);
    if (t < 0 || t >= 12) continue;
    if ((need[t] | 0) <= 0) continue;

    // pick a replaceable slot position
    let pickSlot = -1;
    for (const si of slotOrder) {
      if (usedSlots.has(si)) continue;
      const pos = (slotDeckPos[si] ?? -1) | 0;
      if (pos < 0 || pos >= deck.length) continue;
      if (usedDeckPos.has(pos)) continue;
      // avoid swapping with same color if already identical
      const sc = (slotColors[si] ?? -1) | 0;
      if (sc === t) continue;
      // keep the very first card stable when possible, but do NOT forbid it.
      // If deck[0] is part of the stuck slots, we may have to rewrite it.
      pickSlot = si;
      break;
    }
    if (pickSlot < 0) continue;

    const pickPos = (slotDeckPos[pickSlot] ?? -1) | 0;
    if (pickPos < 0 || pickPos >= deck.length) continue;

    const donor = findDonor(t);
    if (donor < 0 || donor === pickPos) continue;

    // swap-inject
    swapInPlace(deck, pickPos, donor);
    usedSlots.add(pickSlot);
    usedDeckPos.add(pickPos);
    usedDeckPos.add(donor);
    swaps++;
    did = true;

    // Tune the injected card so it can actually clear the current front-barrier.
    // Capping to 1 often fails when the board needs multiple hits of that color to expose new targets.
    const injected: any = deck[pickPos];
    if (injected) {
      const overrideCap = (capAmmo | 0);
      const n = Math.max(0, (need[t] ?? 0) | 0);
      // Need-based soft cap: keep it small so the slot frees quickly, but not too small.
      // (cap=1 tends to fail to expose follow-up targets on some boards.)
      const autoCap = Math.max(2, Math.min(12, n));
      const wantCap = overrideCap > 0 ? Math.max(AMMO_HARD_MIN, Math.min(AMMO_HARD_MAX, overrideCap)) : autoCap;

      // Keep original shotCount unless it's missing/invalid.
      const sc = ((injected?.shotCount ?? 0) | 0);
      if (sc !== 1 && sc !== 2) {
        injected.shotCount = wantCap >= 30 ? 2 : 1;
      }

      // Cap ammo (optional) and push remainder to the future (same color).
      capAmmoAndShiftToFuture(deck, pickPos, wantCap, deckIdx);
    }
  }

  return did;
}

// Fisher–Yates shuffle on a local window. (index 0은 보호)
function shuffleDeckWindow(deck: AuthoredCard[], start: number, end: number, seed: number): boolean {
  const s = Math.max(1, Math.min(deck.length - 1, start | 0));
  const e = Math.max(s + 1, Math.min(deck.length, end | 0));
  if (e - s <= 1) return false;

  const rng = xorshift32(seed | 0);
  for (let i = e - 1; i > s; i--) {
    const j = s + Math.floor(rng() * (i - s + 1));
    if (j === i) continue;
    swapInPlace(deck, i, j);
  }
  return true;
}

// --- HintStep(=클릭 순서) 전용 GA -------------------------------------------------
// pickerCols(=대기열 컬럼 수)가 2 이상인 경우,
// deck 순서(i=0..n-1)대로 hintStep=1..n을 주면 항상 (0,1,0,1,...) 식으로 컬럼이 교대로 선택됩니다.
// 실제 게임에서는 같은 컬럼을 연속으로 선택하는(merge/interleave) 전략이 필요할 수 있으므로,
// deck은 유지하고 hintStep만 재배치하는 GA를 제공합니다.

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = (typeof v === 'number' && Number.isFinite(v)) ? (v | 0) : fallback;
  return Math.max(min, Math.min(max, n));
}

type HintGAConfig = {
  enabled: boolean;
  popSize: number;
  elite: number;
  maxGens: number;
  maxEvals: number;
};

function buildColumnLists(deckLen: number, pickerCols: number): number[][] {
  const cols = Math.max(1, pickerCols | 0);
  const lists: number[][] = Array.from({ length: cols }, () => []);
  for (let i = 0; i < deckLen; i++) lists[i % cols].push(i);
  return lists;
}

function applyHintStepsFromColumnChoiceSeq(deck: AuthoredCard[], pickerCols: number, choiceSeq: number[]) {
  const lists = buildColumnLists(deck.length, pickerCols);
  const ptr = new Array(lists.length).fill(0);
  for (let s = 0; s < choiceSeq.length; s++) {
    const c = (choiceSeq[s] | 0);
    const li = lists[c];
    const p = ptr[c] | 0;
    const idx = (li && p >= 0 && p < li.length) ? li[p] : -1;
    ptr[c] = p + 1;
    if (idx >= 0) {
      deck[idx].hintStep = s + 1;
      deck[idx].hintRank = s + 1;
    }
  }
}

function makeChoiceBag(pickerCols: number, deckLen: number): number[] {
  const lists = buildColumnLists(deckLen, pickerCols);
  const bag: number[] = [];
  for (let c = 0; c < lists.length; c++) {
    for (let k = 0; k < lists[c].length; k++) bag.push(c);
  }
  return bag;
}

function shuffleInPlaceWithRng(arr: number[], rng: () => number) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    if (j === i) continue;
    const t = arr[i];
    arr[i] = arr[j];
    arr[j] = t;
  }
}

function mutateChoiceSeq(seq: number[], replay: SimReplayResult | undefined, rng: () => number): number[] {
  const out = seq.slice();
  const n = out.length;
  if (n <= 1) return out;

  const stuckIdx = (replay?.stuck?.deckIdx ?? replay?.progress?.clicked ?? -1) | 0;
  const hasStuck = stuckIdx >= 0 && stuckIdx < n;
  const window = hasStuck ? 10 : 0;
  const s = hasStuck ? Math.max(0, stuckIdx - window) : 0;
  const e = hasStuck ? Math.min(n - 1, stuckIdx + window) : (n - 1);

  // 70%: stuck 근처 local swap
  // 30%: global swap
  const local = rng() < 0.7;
  const i = (local ? (s + Math.floor(rng() * (e - s + 1))) : Math.floor(rng() * n)) | 0;
  let j = (local ? (s + Math.floor(rng() * (e - s + 1))) : Math.floor(rng() * n)) | 0;
  if (j === i) j = (i + 1) % n;
  const t = out[i];
  out[i] = out[j];
  out[j] = t;

  // 15%: 추가로 짧은 구간 셔플(카운트 유지)
  if (rng() < 0.15 && n >= 6) {
    const a = s + Math.floor(rng() * Math.max(1, (e - s + 1)));
    const b = s + Math.floor(rng() * Math.max(1, (e - s + 1)));
    const lo = Math.max(0, Math.min(a, b));
    const hi = Math.min(n, Math.max(a, b) + 1);
    const seg = out.slice(lo, hi);
    shuffleInPlaceWithRng(seg, rng);
    for (let k = 0; k < seg.length; k++) out[lo + k] = seg[k];
  }
  return out;
}

async function gaSearchReplaySolvedHints(
  stage: StageV2,
  opts: ReplayRepairOpts,
): Promise<{ replay: SimReplayResult; bestSeq: number[] } | null> {
  const deck = stage.cards?.authored ?? [];
  const n = deck.length | 0;
  if (n <= 1) return null;

  const pickerCols = clampInt(stage?.meta?.pickerCols, 1, 5, 2);
  if (pickerCols <= 1) return null;

  const hintCfg = opts.hintGa;
  if (!hintCfg?.enabled) return null;
  const ga: HintGAConfig = {
    enabled: true,
    popSize: Math.max(8, (hintCfg.popSize ?? 22) | 0),
    elite: Math.max(2, Math.min((hintCfg.elite ?? 6) | 0, (hintCfg.popSize ?? 22) | 0)),
    maxGens: Math.max(4, (hintCfg.maxGens ?? 10) | 0),
    maxEvals: Math.max(80, (hintCfg.maxEvals ?? 160) | 0),
  };

  const bag = makeChoiceBag(pickerCols, n);
  if (bag.length !== n) return null;

  const rng = xorshift32(((stage?.id ?? 0) * 2654435761) ^ (n * 97531) ^ 0xA5A5A5A5);

  type Cand = { seq: number[]; replay: SimReplayResult };
  const seen = new Set<string>();
  let evals = 0;

  async function evalSeq(seq: number[]): Promise<SimReplayResult> {
    applyHintStepsFromColumnChoiceSeq(deck, pickerCols, seq);
    // GA 평가에서는 무한/장기 루프를 피하기 위해 상한을 보수적으로 잡습니다.
    const maxRounds = Math.min(opts.maxRounds ?? 200000, 20000);
    const maxShots = Math.min(opts.maxShots ?? 200000, 20000);
    const r = await simulateStageReplay(stage, {
      strictHintOrder: true,
      captureFrames: false,
      maxRounds,
      maxShots,
      detail: 'round',
    });
    evals++;
    return r;
  }

  function keyOf(seq: number[]): string {
    // cols<=5 이므로 구분자 없이도 충돌 가능성이 낮지만,
    // 안전하게 ',' 사용.
    return seq.join(',');
  }

  const population: Cand[] = [];

  // seed 1) 기본: 라운드로빈(=deck order)
  const baseSeq = Array.from({ length: n }, (_, i) => (i % pickerCols));
  {
    const k = keyOf(baseSeq);
    seen.add(k);
    population.push({ seq: baseSeq, replay: await evalSeq(baseSeq) });
    if (population[0].replay.status === 'SOLVED') {
      return { replay: population[0].replay, bestSeq: population[0].seq };
    }
  }

  // seed 2) 컬럼 몰아서(0..0,1..1,2..2...)
  {
    const seq = bag.slice();
    const k = keyOf(seq);
    if (!seen.has(k)) {
      seen.add(k);
      population.push({ seq, replay: await evalSeq(seq) });
      if (population[population.length - 1].replay.status === 'SOLVED') {
        return { replay: population[population.length - 1].replay, bestSeq: seq };
      }
    }
  }

  // 나머지 seed: 랜덤 셔플
  while (population.length < ga.popSize && evals < ga.maxEvals) {
    const seq = bag.slice();
    shuffleInPlaceWithRng(seq, rng);
    const k = keyOf(seq);
    if (seen.has(k)) continue;
    seen.add(k);
    const replay = await evalSeq(seq);
    population.push({ seq, replay });
    if (replay.status === 'SOLVED') return { replay, bestSeq: seq };
  }

  function sortPop() {
    population.sort((a, b) => (gaBetter(a.replay, b.replay) ? -1 : 1));
  }

  sortPop();

  for (let gen = 0; gen < ga.maxGens && evals < ga.maxEvals; gen++) {
    sortPop();
    const elites = population.slice(0, ga.elite);
    const next: Cand[] = elites.map(e => ({ seq: e.seq.slice(), replay: e.replay }));

    while (next.length < ga.popSize && evals < ga.maxEvals) {
      const parent = elites[Math.floor(rng() * elites.length)];
      const childSeq = mutateChoiceSeq(parent.seq, parent.replay, rng);
      const k = keyOf(childSeq);
      if (seen.has(k)) continue;
      seen.add(k);
      const replay = await evalSeq(childSeq);
      next.push({ seq: childSeq, replay });
      if (replay.status === 'SOLVED') return { replay, bestSeq: childSeq };
    }

    population.length = 0;
    population.push(...next);
  }

  sortPop();
  return population.length ? { replay: population[0].replay, bestSeq: population[0].seq } : null;
}

// -----------------------------
// Fallback stochastic search (GA)
// -----------------------------

function gaBetter(a: SimReplayResult, b: SimReplayResult): boolean {
  // Prefer SOLVED.
  if (a.status === 'SOLVED' && b.status !== 'SOLVED') return true;
  if (a.status !== 'SOLVED' && b.status === 'SOLVED') return false;

  // Primary: lower remaining.
  const ar = a.remaining | 0;
  const br = b.remaining | 0;
  if (ar !== br) return ar < br;

  // Secondary: higher clicked.
  const ac = (a.clicked ?? 0) | 0;
  const bc = (b.clicked ?? 0) | 0;
  if (ac !== bc) return ac > bc;

  // Tertiary: higher rounds.
  const ad = (a.rounds ?? 0) | 0;
  const bd = (b.rounds ?? 0) | 0;
  return ad > bd;
}

function gaRandInt(rng: () => number, n: number): number {
  if (n <= 0) return 0;
  return Math.floor(rng() * n);
}

function gaWeightedPick(rng: () => number, weights: number[]): number {
  let sum = 0;
  for (const w of weights) sum += w > 0 ? w : 0;
  if (sum <= 0) return -1;
  let r = rng() * sum;
  for (let i = 0; i < weights.length; i++) {
    const w = weights[i] > 0 ? weights[i] : 0;
    r -= w;
    if (r < 0) return i;
  }
  return weights.length - 1;
}

function gaOrderKey(order: number[]): string {
  return order.join(',');
}

function gaShuffleOrder(order: number[], rng: () => number) {
  for (let i = order.length - 1; i > 0; i--) {
    const j = gaRandInt(rng, i + 1);
    swapInPlace(order, i, j);
  }
}

function gaMutateOrder(
  baseCards: AuthoredCard[],
  order: number[],
  replay: SimReplayResult | null,
  rng: () => number
): number[] {
  const out = order.slice();
  const stuck = replay?.stuck;

  // No snapshot → random swap.
  if (!stuck) {
    swapInPlace(out, gaRandInt(rng, out.length), gaRandInt(rng, out.length));
    return out;
  }

  const deckIdx = (stuck.deckIdx ?? 0) | 0;
  const need = Array.isArray(stuck.needCounts) ? stuck.needCounts : [];
  const slotPos = Array.isArray(stuck.slotDeckPos) ? stuck.slotDeckPos : [];
  const slotColors = Array.isArray(stuck.slotColors) ? stuck.slotColors : [];

  const needColorId = gaWeightedPick(rng, need);
  if (needColorId < 0 || slotPos.length === 0) {
    swapInPlace(out, gaRandInt(rng, out.length), gaRandInt(rng, out.length));
    return out;
  }

  // donors of the needed color in suffix
  const donors: number[] = [];
  for (let i = Math.max(0, deckIdx); i < out.length; i++) {
    const c = getCardColorId(baseCards[out[i]]);
    if (c === needColorId) donors.push(i);
  }
  if (donors.length === 0) {
    // fallback window shuffle around the deadlock point
    const s = Math.max(1, deckIdx - 2);
    const e = Math.min(out.length, deckIdx + 12);
    if (e - s >= 2) {
      for (let i = e - 1; i > s; i--) {
        const j = s + gaRandInt(rng, i - s + 1);
        if (j !== i) swapInPlace(out, i, j);
      }
    }
    return out;
  }

  const donorPos = donors[gaRandInt(rng, donors.length)];

  // Prefer replacing slots whose current color is NOT needed.
  const slotWeights = slotPos.map((_, si) => {
    const sc = slotColors[si] | 0;
    const w = (need[sc] ?? 0) | 0;
    return w > 0 ? 1 : 3;
  });
  const si = Math.max(0, gaWeightedPick(rng, slotWeights));
  const targetPos = (slotPos[si] ?? -1) | 0;
  if (targetPos >= 0 && targetPos < out.length && targetPos !== donorPos) {
    swapInPlace(out, targetPos, donorPos);
  }

  return out;
}

async function gaSearchReplaySolvedDeck(
  stage: any,
  baseDeck: AuthoredCard[],
  opts: Required<Pick<ReplayRepairOpts, 'maxRounds' | 'maxShots'>> & { ga: Required<NonNullable<ReplayRepairOpts['ga']>> }
): Promise<{ deck: AuthoredCard[]; replay: SimReplayResult } | null> {
  const n = baseDeck.length;
  if (n <= 0 || n > 160) return null;
  if (!opts.ga.enabled) return null;

  const rng = xorshift32(((stage?.id ?? 0) | 0) ^ (n * 2654435761));

  const evalOrder = async (order: number[]): Promise<SimReplayResult> => {
    const deck = order.map((idx, i) => ({ ...baseDeck[idx], hintStep: i + 1 }));
    // Keep the authored array reference stable (helps callers holding a reference).
    const holder: AuthoredCard[] = Array.isArray(stage?.cards?.authored)
      ? stage.cards.authored
      : (stage.cards.authored = []);
    holder.length = 0;
    holder.push(...deck);
    return await simulateStageReplay(stage, {
      strictHintOrder: true,
      captureFrames: false,
      maxRounds: opts.maxRounds,
      maxShots: opts.maxShots,
    });
  };

  const popSize = Math.max(8, opts.ga.popSize | 0);
  const elite = Math.max(2, Math.min(popSize, opts.ga.elite | 0));
  const maxGens = Math.max(1, opts.ga.maxGens | 0);
  const maxEvals = Math.max(popSize, opts.ga.maxEvals | 0);

  type Cand = { order: number[]; replay: SimReplayResult };
  let evals = 0;
  const seen = new Set<string>();

  const baseOrder = Array.from({ length: n }, (_, i) => i);

  // init population
  let pop: Cand[] = [];
  const firstReplay = await evalOrder(baseOrder);
  evals++;
  if (firstReplay.status === 'SOLVED') return { deck: stage.cards.authored, replay: firstReplay };
  pop.push({ order: baseOrder.slice(), replay: firstReplay });
  seen.add(gaOrderKey(baseOrder));

  while (pop.length < popSize && evals < maxEvals) {
    const ord = baseOrder.slice();
    gaShuffleOrder(ord, rng);
    const key = gaOrderKey(ord);
    if (seen.has(key)) continue;
    seen.add(key);
    const rep = await evalOrder(ord);
    evals++;
    if (rep.status === 'SOLVED') return { deck: stage.cards.authored, replay: rep };
    pop.push({ order: ord, replay: rep });
  }

  let best = pop[0];
  for (const c of pop) if (gaBetter(c.replay, best.replay)) best = c;

  for (let gen = 0; gen < maxGens && evals < maxEvals; gen++) {
    pop.sort((a, b) => {
      if (gaBetter(a.replay, b.replay)) return -1;
      if (gaBetter(b.replay, a.replay)) return 1;
      return 0;
    });
    if (gaBetter(pop[0].replay, best.replay)) best = pop[0];
    if (best.replay.status === 'SOLVED') return { deck: stage.cards.authored, replay: best.replay };

    const next: Cand[] = [];
    for (let i = 0; i < elite && i < pop.length; i++) next.push({ order: pop[i].order.slice(), replay: pop[i].replay });

    while (next.length < popSize && evals < maxEvals) {
      const parent = next[gaRandInt(rng, next.length)];
      let child = parent.order.slice();
      const mutCount = 1 + gaRandInt(rng, 3);
      for (let m = 0; m < mutCount; m++) {
        // 75% guided, 25% random
        if (rng() < 0.75) child = gaMutateOrder(baseDeck, child, parent.replay, rng);
        else swapInPlace(child, gaRandInt(rng, child.length), gaRandInt(rng, child.length));
      }
      const key = gaOrderKey(child);
      if (seen.has(key)) continue;
      seen.add(key);
      const rep = await evalOrder(child);
      evals++;
      if (rep.status === 'SOLVED') return { deck: stage.cards.authored, replay: rep };
      next.push({ order: child, replay: rep });
    }

    pop = next;
  }

  // return best improvement
  const bestReplay = await evalOrder(best.order);
  return { deck: stage.cards.authored, replay: bestReplay };
}

// ✅ STUCK 시점에 "필요한 색인데 남은 덱에 0" 인 경우,
//    그 색 카드가 과거에만 몰려 있다는 뜻입니다.
//    → 과거(소모된 구간)에서 하나를 꺼내서 미래(deckIdx 이후)로 보내,
//      이후 구간에서 다시 사용할 수 있게 합니다.
function deferMissingNeededColorFromPast(deck: AuthoredCard[], stuck: NonNullable<SimReplayResult['stuck']>, need: Int32Array): boolean {
  if (!stuck || !Array.isArray(deck) || deck.length <= 2) return false;

  const deckIdx = Math.max(0, (stuck.deckIdx ?? 0) | 0);
  if (deckIdx <= 0 || deckIdx >= deck.length) return false;

  const deckColorCounts = Array.isArray((stuck as any).deckColorCounts) ? ((stuck as any).deckColorCounts as any[]) : [];
  const slotDeckPos = Array.isArray(stuck.slotDeckPos) ? stuck.slotDeckPos : [];
  const slotPosSet = new Set<number>();
  for (const p0 of slotDeckPos) {
    const p = (p0 ?? -1) | 0;
    if (p >= 0) slotPosSet.add(p);
  }
  const slotColors = Array.isArray(stuck.slotColors) ? stuck.slotColors : [];
  const slotColorSet = new Set<number>();
  for (const c0 of slotColors) {
    const c = (c0 ?? -1) | 0;
    if (c >= 0) slotColorSet.add(c);
  }

  // missing candidates (needed but no remaining cards in suffix)
  const missing: number[] = [];
  for (let c = 0; c < 12; c++) {
    const n = need[c] | 0;
    if (n <= 0) continue;
    const remain = (deckColorCounts?.[c] ?? 0) | 0;
    if (remain > 0) continue;
    missing.push(c);
  }
  if (missing.length <= 0) return false;

  // prefer higher need first
  missing.sort((a, b) => ((need[b] | 0) - (need[a] | 0)));

  // helper: find a past card of color c that is NOT currently in slot, and not index 0.
  const findPastIdx = (c: number): number => {
    const start = Math.min(deckIdx - 1, deck.length - 1);
    for (let i = start; i >= 1; i--) {
      if (slotPosSet.has(i)) continue;
      if (getCardColorId(deck[i]) === (c | 0)) return i;
    }
    return -1;
  };

  // helper: pick a future idx to swap with
  const pickFutureIdx = (avoidColor: number): number => {
    let bestJ = -1;
    let bestScore = -1e18;
    for (let j = Math.max(1, deckIdx); j < deck.length; j++) {
      const cj = getCardColorId(deck[j]);
      if (cj < 0 || cj >= 12) continue;
      if (cj === (avoidColor | 0)) continue;

      const needNow = (need[cj] | 0) > 0;
      const remainCj = (deckColorCounts?.[cj] ?? 0) | 0;

      let score = 0;
      if (!needNow) score += 6000;
      if (slotColorSet.has(cj)) score += 1200;
      score += Math.min(10, Math.max(0, remainCj)) * 250;

      const a = Math.max(0, ((deck[j] as any)?.ammo ?? 0) | 0);
      score += Math.min(120, a) * 4;

      score -= Math.min(200, Math.max(0, j - deckIdx)) * 3;

      if (score > bestScore) {
        bestScore = score;
        bestJ = j;
      }
    }
    return bestJ;
  };

  for (const c of missing) {
    const i = findPastIdx(c);
    if (i < 0) continue;
    const j = pickFutureIdx(c);
    if (j < 0 || j === i) continue;

    swapInPlace(deck, i, j);
    return true;
  }

  return false;
}

function normalizeHintSteps(deck: AuthoredCard[]) {
  for (let i = 0; i < deck.length; i++) {
    (deck[i] as any).hintStep = (i + 1) | 0;
    (deck[i] as any).hintRank = (i + 1) | 0;
  }
}

function isAmmoMismatchErr(e: any): boolean {
  const msg = String((e as any)?.message ?? e ?? '');
  return msg.includes('authored ammo mismatch') || msg.includes('ammo sum mismatch');
}

async function bakeAuthoredDeckFromGenerate(
  stage: any,
  opts?: {
    // true면 기존 deck을 무시하고 GENERATE로 강제 생성한 뒤 bake 합니다.
    // 기본(false): 현재 cards.mode 기준으로 컴파일한 runtime.cards를 그대로 bake 합니다.
    forceGenerate?: boolean;
  },
): Promise<void> {
  const cardsObj = stage?.cards ?? (stage.cards = {});

  // preserve optional fields (rules/src)
  const rules = (cardsObj as any).rules;
  const src = (cardsObj as any).src;

  const forceGenerate = opts?.forceGenerate === true;

  // NOTE(Node/headless): use explicit .js so Node ESM resolver can load the CommonJS validator runtime.
  const stageCompilerMod: any = await import('../validator_tools/game/StageCompiler.js');
  const compileRuntimeFromV2: any = stageCompilerMod?.compileRuntimeFromV2 ?? stageCompilerMod?.default?.compileRuntimeFromV2;
  if (typeof compileRuntimeFromV2 !== 'function') throw new Error('validator_tools: compileRuntimeFromV2 not found');

  const layerCount = stage?.meta?.layerCount ?? 1;
  const enableStacks = (layerCount | 0) > 1;
  let rt: any;
  try {
    if (forceGenerate) {
      // 강제 생성: 기존 authored/list를 무시
      (cardsObj as any).mode = 'GENERATE';
      delete (cardsObj as any).authored;
      delete (cardsObj as any).list;
    }
    rt = compileRuntimeFromV2(stage as any, { enableStacks });
  } catch (e) {
    // authored deck이 깨져서 컴파일이 불가한 경우에만 GENERATE로 폴백
    if (!forceGenerate && isAmmoMismatchErr(e)) {
      (cardsObj as any).mode = 'GENERATE';
      delete (cardsObj as any).authored;
      delete (cardsObj as any).list;
      rt = compileRuntimeFromV2(stage as any, { enableStacks });
    } else {
      throw e;
    }
  }

  const baked: AuthoredCard[] = (Array.isArray(rt?.cards) ? rt.cards : []).map((cd: any, idx: number) => ({
    color: (COLOR_TOKEN_ORDER[(cd?.colorId ?? -1) | 0] ?? ((cd?.colorId ?? -1) | 0)) as any,
    ammo: (cd?.ammo ?? 0) | 0,
    shotCount: cd?.shotCount,
    hintStep: ((cd?.hintStep ?? (idx + 1)) | 0),
    hintRank: cd?.hintRank,
    // IMPORTANT: do NOT bake LOCK kind into authored.
    // StageCompiler assigns LOCK shooters from meta.lockShooterCount deterministically,
    // and counting pre-existing LOCK cards would lead to compounding locks across compiles.
    kind: (cd?.kind === 'LOCK') ? undefined : cd?.kind,
  }));

  (cardsObj as any).mode = 'AUTHORED';
  (cardsObj as any).rules = rules;
  (cardsObj as any).authored = baked;
  (cardsObj as any).src = src ?? (cardsObj as any).src ?? 'STAGE_TOOL';

  normalizeHintSteps(baked);
}

export function tokenFromColorId(colorId: number): ColorToken | '?' {
  const t = COLOR_TOKEN_ORDER[colorId | 0] as any;
  return (typeof t === 'string' && t.length > 0 ? t : '?') as any;
}

export async function repairStageUntilReplaySolved(stage: any, opts?: ReplayRepairOpts): Promise<{ stage: any; report: ReplayRepairReport; replay: SimReplayResult }> {
  const maxIters = Math.max(0, (opts?.maxIters ?? 240) | 0);
  const maxRounds = (opts?.maxRounds ?? 200_000) | 0;
  const maxShots = (opts?.maxShots ?? 2_000_000) | 0;
  const strictDeckAmmoOnly = opts?.strictDeckAmmoOnly ?? true;

  // ✅ 요구사항: 보드/공급(supply) 데이터는 절대 수정하지 않습니다.
  // - supply.pages 정리(고정 오브젝트 제거)는 "데이터를 바꾸는 작업"이므로 자동 리페어에서는 수행하지 않습니다.
  // - 필요하면 별도 도구/수동 작업으로 정리한 뒤, 리플레이 검증만 진행하세요.
  const supplySanitized = { removed: 0 };


  const cardsObj = stage?.cards ?? (stage.cards = {});

  // ✅ Replay-repair works only when the deck order is explicit & stable.
  // - If the stage is GENERATE, or authored deck is missing/stale, bake once into AUTHORED.
  if (!strictDeckAmmoOnly) {
    if ((cardsObj as any).mode == null || (cardsObj as any).mode === 'GENERATE') {
      if (!strictDeckAmmoOnly) await bakeAuthoredDeckFromGenerate(stage);
    } else if (!Array.isArray((cardsObj as any).authored) || (cardsObj as any).authored.length <= 0) {
      await bakeAuthoredDeckFromGenerate(stage);
    }
  }

  (cardsObj as any).mode = 'AUTHORED';

  // NOTE:
  // In the game StageCompiler, authored order / hintStep are only preserved when `cards.src` is truthy.
  // If `src` is null/empty, the compiler may reorder cards, making any replay-repair reordering ineffective.
  // We force a stable marker so the solved deck order stays exactly as validated here.
  if (!(cardsObj as any).src) (cardsObj as any).src = 'STAGE_TOOL';

  // Always bake once from the runtime compiler to absorb StageCompiler auto-fixes
  // (per-color ammo reconciliation, lock placement constraints, etc.) into authored.
  // Without this, later compiles can silently mutate ammo/kinds and undo our repair steps.
  await bakeAuthoredDeckFromGenerate(stage);

  let deck: AuthoredCard[] = Array.isArray((cardsObj as any).authored) ? (cardsObj as any).authored : [];

  // Ensure hintStep is always sequential by deck order.
  normalizeHintSteps(deck);

  let prevSig = '';
  let stagnation = 0;
  let backjump = 0;

  const history: ReplayRepairReport['history'] = [];
  let lastReplay: SimReplayResult;
  try {
    lastReplay = await simulateStageReplay(stage, {
      strictHintOrder: true,
      captureFrames: false,
      maxRounds,
      maxShots,
    });
  } catch (e: any) {
    // If the stage was edited (blockCount/board/supply) without rebuilding deck,
    // StageCompiler can throw "authored ammo mismatch".
    if (isAmmoMismatchErr(e) && !strictDeckAmmoOnly) {
      await bakeAuthoredDeckFromGenerate(stage);
      deck = Array.isArray((cardsObj as any).authored) ? (cardsObj as any).authored : [];
      normalizeHintSteps(deck);
      lastReplay = await simulateStageReplay(stage, {
        strictHintOrder: true,
        captureFrames: false,
        maxRounds,
        maxShots,
      });
    } else {
      throw e;
    }
  }

  if (lastReplay.status === 'SOLVED') {
    return {
      stage,
      replay: lastReplay,
      report: { iters: 0, solved: true, lastStatus: lastReplay.status, lastReason: lastReplay.reason, supplySanitized, history },
    };
  }

  // ✅ 1차 검증에서 바로 풀리지 않는 경우:
  // - 일부 authored deck(특히 spawner/large/chain이 섞인 스테이지)은
  //   "색상 합계만 맞는" 상태라도 슬롯-타깃 타이밍이 맞지 않아 repair가 국소 swap/cap으로는
  //   수렴하지 않는 케이스가 존재합니다.
  // - 이때는 StageCompiler의 GENERATE(=runtime 기반 분포)로 덱을 한 번 재구성(bake)한 뒤
  //   동일한 repair 루틴을 적용하면 수렴성이 크게 좋아집니다.
  // - 이미 SOLVED인 스테이지는 위에서 return 되므로, 여기서는 unsolved만 대상으로 합니다.
  if (!strictDeckAmmoOnly && (opts?.forceGenerateBaseline ?? true)) {
    await bakeAuthoredDeckFromGenerate(stage, { forceGenerate: true });
    deck = Array.isArray((cardsObj as any).authored) ? (cardsObj as any).authored : [];
    normalizeHintSteps(deck);
    lastReplay = await simulateStageReplay(stage, {
      strictHintOrder: true,
      captureFrames: false,
      maxRounds,
      maxShots,
    });
    if (lastReplay.status === 'SOLVED') {
      return {
        stage,
        replay: lastReplay,
        report: { iters: 0, solved: true, lastStatus: lastReplay.status, lastReason: lastReplay.reason, supplySanitized, history },
      };
    }
  }

  // (옵션) Hint GA: deck은 그대로 두고 hintStep만 interleave 해서 SOLVED를 먼저 시도합니다.
  // - StageCompiler가 AUTHORED/FIXED hintStep을 정규화하는 경우에는 효과가 없으므로 기본 OFF.
  if (!strictDeckAmmoOnly && (opts.hintGa?.enabled ?? false)) {
    const hintTry = await gaSearchReplaySolvedHints(stage, opts);
    if (hintTry && hintTry.replay.status === 'SOLVED') {
      history.push({
        iter: 0,
        status: 'SOLVED',
        reason: hintTry.replay.reason,
        remaining: hintTry.replay.remaining,
        clicked: hintTry.replay.progress.clicked,
        deckIdx: (hintTry.replay.progress.nextHint - 1) | 0,
        didHintGa: true,
      });
      return {
        stage,
        replay: hintTry.replay,
        report: { iters: 0, solved: true, lastStatus: 'SOLVED', lastReason: hintTry.replay.reason, lastStuck: hintTry.replay.stuck, supplySanitized, history },
      };
    }
    // 실패하면 hintStep이 변경되어 있을 수 있으니 baseline(sequential)로 복구
    normalizeHintSteps(deck);
    // (lastReplay는 baseline 기준으로 유지)
  }


  // Snapshot of the current deck order (used to keep GA available even if the greedy loop balloons deck length).
  let baseDeckSnapshot: AuthoredCard[] = deck.map((c) => ({ ...(c as any) }));

  // ✅ Pre-GA (Deck Reorder)
  // - 카드 수가 큰(대략 80~160장) 스테이지에서 FULL_AND_NO_TARGETS가 나면,
  //   국소 swap/cap 루프가 덱을 비대하게 만들어(160장 초과) GA 자체가 비활성화되는 경우가 있습니다.
  // - 그래서 "큰 덱 + 하드 데드락"에서는 먼저 작은 GA 패스로 전역 재정렬을 시도합니다.
  const GA_MAX_N = 160;
  const PRE_GA_MIN_N = 60;
  if (
    lastReplay.status === 'STUCK' &&
    lastReplay.reason === 'FULL_AND_NO_TARGETS' &&
    (!strictDeckAmmoOnly && (opts?.ga?.enabled ?? true)) &&
    deck.length >= PRE_GA_MIN_N &&
    deck.length <= GA_MAX_N
  ) {
    const preGaCfg = {
      enabled: true,
      popSize: Math.min(opts?.ga?.popSize ?? 40, 24),
      elite: Math.min(opts?.ga?.elite ?? 10, 8),
      maxGens: Math.min(opts?.ga?.maxGens ?? 800, 180),
      maxEvals: Math.min(opts?.ga?.maxEvals ?? 12000, 1200),
      mutationRate: opts?.ga?.mutationRate ?? 0.18,
      crossoverRate: opts?.ga?.crossoverRate ?? 0.55,
      tournamentK: opts?.ga?.tournamentK ?? 3,
    };

    const preBaseDeck = baseDeckSnapshot.map((c) => ({ ...c }));
    const gaRes = await gaSearchReplaySolvedDeck(stage, preBaseDeck, {
      maxRounds,
      maxShots,
      ga: preGaCfg,
    });

    if (gaRes && gaBetter(gaRes.replay, lastReplay)) {
      lastReplay = gaRes.replay;
      // GA는 stage.cards.authored를 best deck으로 갱신해둡니다.
      baseDeckSnapshot = deck.map((d) => ({ ...d }));
      history.push({
        iter: history.length + 1,
        status: lastReplay.status,
        reason: lastReplay.reason,
        didGa: true,
      });

      if (lastReplay.status === 'SOLVED') {
        return {
          stage,
          replay: lastReplay,
          report: {
            iters: history.length,
            solved: true,
            lastStatus: lastReplay.status,
            lastReason: lastReplay.reason,
            supplySanitized,
            history,
          },
        };
      }
    }
  }

  // Track best progress to avoid endlessly cycling on cosmetic state changes.
  let bestReplay = lastReplay;
  let bestDeckSnapshot: AuthoredCard[] = deck.map((c) => ({ ...(c as any) }));
  let noImprove = 0;
  let inLoopHintGa = 0;

  for (let it = 1; it <= maxIters; it++) {
    const stuck = lastReplay.stuck;
    if (!stuck) {
      history.push({ iter: it, status: lastReplay.status, reason: lastReplay.reason });
      break;
    }

    // Signature tracking
    {
      const sig = `${stuck.deckIdx}|${(stuck.slotColors ?? []).join(',')}|${(stuck.slotDeckPos ?? []).join(',')}|${(stuck.needCounts ?? []).join(',')}`;
      if (sig === prevSig) {
        stagnation += 1;
      } else {
        prevSig = sig;
        stagnation = 0;
        // Don't aggressively reset backjump when we're not improving.
        if (noImprove <= 0) backjump = 0;
      }
      if (stagnation >= 2 || noImprove >= 6) backjump = Math.min(80, backjump + 20);
    }

    const need = new Int32Array(12);
    need.fill(0);
    const nc = Array.isArray(stuck.needCounts) ? stuck.needCounts : [];
    for (let i = 0; i < 12; i++) need[i] = (nc[i] ?? 0) | 0;

    const rawDeckIdx = Math.max(0, (stuck.deckIdx ?? 0) | 0);
    const slotPos = Array.isArray(stuck.slotDeckPos) ? stuck.slotDeckPos : [];
    let minSlotPos = rawDeckIdx;
    for (const p0 of slotPos) {
      const p = (p0 ?? -1) | 0;
      if (p >= 0) minSlotPos = Math.min(minSlotPos, p);
    }
    const pivotBase = Math.max(0, Math.min(rawDeckIdx, minSlotPos));
    const pivotDeckIdx = Math.max(0, pivotBase - (backjump | 0));

    const neededColors = pickTopNeedColors(need, 12);
    const capSlots = (Array.isArray(stuck.slotColors) ? stuck.slotColors.length : 0) | 0;
    const bringCards = neededColors.length <= 1 ? Math.min(12, Math.max(4, capSlots + 3)) : Math.min(24, Math.max(8, capSlots * 4));
    const scanLimit = neededColors.length <= 1 ? 56 : 72;

    const severe = String((stuck as any)?.reason ?? lastReplay.reason ?? '') === 'FULL_AND_NO_TARGETS';

    // If we hit the catastrophic deadlock in multi-column stages, try an escalated hint GA once or twice.
    if (
      severe &&
      (opts.hintGa?.enabled ?? false) &&
      clampInt(stage?.meta?.pickerCols, 1, 5, 2) >= 2 &&
      inLoopHintGa < 2 &&
      (it === 1 || noImprove >= 3)
    ) {
      inLoopHintGa += 1;
      const hintOpts: ReplayRepairOpts = {
        ...opts,
        hintGa: {
          enabled: true,
          popSize: Math.max(opts?.hintGa?.popSize ?? 22, 48),
          elite: Math.max(opts?.hintGa?.elite ?? 6, 10),
          maxGens: Math.max(opts?.hintGa?.maxGens ?? 10, 40),
          maxEvals: Math.max(opts?.hintGa?.maxEvals ?? 160, 3000),
        },
      };
      const hintTry = !strictDeckAmmoOnly ? await gaSearchReplaySolvedHints(stage, hintOpts) : null;
      if (hintTry && hintTry.replay.status === 'SOLVED') {
        history.push({
          iter: it,
          status: 'SOLVED',
          reason: hintTry.replay.reason,
          remaining: hintTry.replay.remaining,
          clicked: hintTry.replay.progress.clicked,
          deckIdx: (hintTry.replay.progress.nextHint - 1) | 0,
          didHintGa: true,
        });
        return {
          stage,
          replay: hintTry.replay,
          report: {
            iters: it,
            solved: true,
            supplySanitized,
            lastStatus: 'SOLVED',
            lastReason: hintTry.replay.reason,
            lastStuck: hintTry.replay.stuck,
            history,
          },
        };
      }
      // Failed: restore sequential baseline before deterministic mutations.
      normalizeHintSteps(deck);
    }

    const didDefer = deferMissingNeededColorFromPast(deck, stuck, need);

    // FULL_AND_NO_TARGETS: shrink stuck-slot cards down to the amount of ammo they already spent
    // before the deadlock, so they would have ejected at that moment and freed a click.
    const didTrim = severe && !didDefer
      ? trimSpentAmmoFromStuckSlots(deck, stuck, Math.max(1, Math.min(3, capSlots)))
      : false;

    // ✅ FULL_AND_NO_TARGETS 대응 순서:
    // 1) 먼저 "필요한 색" 카드를 stuck 슬롯 유래 위치로 스왑(=즉시 사격 가능) 시도
    // 2) donor를 못 찾는 경우에만, 더 공격적인 escape(전구간 탐색/캡/시프트)로 보조
    const didSlotSwap = !didDefer
      ? (severe
          ? repairSwapNeededIntoStuckSlotsMulti(deck, stuck, need, Math.max(1, Math.min(3, capSlots)))
          : repairSwapNeededIntoStuckSlots(deck, stuck, need))
      : false;

    // Fallback escape:
    // capAmmo=0 → escapeFullAndNoTargetsBySwapAndCap 내부에서 need 기반으로 자동 튜닝합니다.
    const didEscape = !didDefer && severe && !didSlotSwap
      ? escapeFullAndNoTargetsBySwapAndCap(deck, stuck, need, Math.max(1, Math.min(3, capSlots)), 0)
      : false;

    const didAmmoShift = !didDefer && severe && !didSlotSwap && !didEscape
      ? shiftDeadSlotAmmoToFuture(deck, stuck, need, Math.max(1, Math.min(3, capSlots)))
      : false;

// Reorder:
// - FULL_AND_NO_TARGETS는 "현재 슬롯 색"과 "지금 보드에서 쏠 수 있는 색"이 어긋나서 발생합니다.
// - slotSwap/escape로 "당장 한 번은" 탈출해도, 곧바로 다음 카드들이 또 어긋나면
//   몇 번이고 FULL_AND_NO_TARGETS가 재발합니다(Stage3 케이스).
//
// 그래서 severe(=FULL_AND_NO_TARGETS)에서는:
//   (A) 우선, 이미 클릭한 prefix(0..rawDeckIdx-1)는 최대한 건드리지 않고
//       upcoming suffix(rawDeckIdx.. )를 need 기반으로 가볍게 재정렬(예방).
//   (B) 그래도 개선이 없거나 시그니처가 반복되면(pivot/backjump), 기존의 더 공격적인 reorder로 확장.
let didReorder = false;

// (A) proactive upcoming reorder (prefix 보존)
if (!didDefer && severe && (didSlotSwap || didEscape) && rawDeckIdx < deck.length - 1) {
  const start = Math.max(0, rawDeckIdx);
  didReorder =
    reorderUpcomingDeckByNeed(
      deck,
      start,
      need,
      Math.min(Math.max(6, bringCards), deck.length - start),
      scanLimit + 24,
    ) || didReorder;
}

// (B) fallback / widening reorder (pivot/backjump)
const doReorder = severe
  ? ((!didSlotSwap && !didEscape && !didAmmoShift) || (stagnation > 0) || (noImprove >= 2))
  : ((!didSlotSwap && !didAmmoShift) || (stagnation > 0) || (noImprove >= 2));

if (!didReorder && doReorder) {
  didReorder = reorderUpcomingDeckByNeed(
    deck,
    pivotDeckIdx,
    need,
    Math.min(bringCards + (severe ? 4 : 0), deck.length - pivotDeckIdx),
    scanLimit + (severe ? 24 : 0),
  );
}
// ✅ 반복 스턱(시그니처 반복)인 경우, 로컬 윈도우를 가볍게 셔플해서
    //    탐색 공간을 넓힙니다(특히 생성박스/체인/히든 조합에서 유효).
    let didShuffle = false;
    const wantShuffle = severe
      ? (!didDefer && !didTrim && !didSlotSwap && !didEscape && (noImprove >= 2 || stagnation >= 1))
      : ((stagnation >= 3 && !didDefer) || (!didDefer && !didSlotSwap && !didReorder && (stagnation >= 1 || noImprove >= 2)) || (!didDefer && noImprove >= 10));
    if (wantShuffle) {
      const stageId = (stage?.id ?? stage?.stageId ?? 0) | 0;
      const winStart = Math.max(1, pivotDeckIdx);
      const winSize = severe ? 64 : (stagnation >= 4 ? 48 : 28);
      const winEnd = Math.min(deck.length, winStart + winSize);
      const seed = (((stageId >>> 0) ^ ((it * 0x9e3779b9) >>> 0) ^ ((pivotDeckIdx * 0x85ebca6b) >>> 0) ^ ((noImprove * 0x27d4eb2d) >>> 0)) >>> 0) | 0;
      didShuffle = shuffleDeckWindow(deck, winStart, winEnd, seed);
    }

    // Apply sequential hint step after mutations.
    normalizeHintSteps(deck);

    // Re-simulate.
    lastReplay = await simulateStageReplay(stage, {
      strictHintOrder: true,
      captureFrames: false,
      maxRounds,
      maxShots,
    });

    history.push({
      iter: it,
      status: lastReplay.status,
      reason: lastReplay.reason,
      deckIdx: stuck.deckIdx,
      didSlotSwap,
      didReorder,
      didDefer,
      didTrim,
      didShuffle,
      didAmmoShift,
      didEscape,
      backjump,
    });

    if (gaBetter(lastReplay, bestReplay)) {
      bestReplay = lastReplay;
      bestDeckSnapshot = deck.map((c) => ({ ...(c as any) }));
      noImprove = 0;
    } else {
      noImprove += 1;
    }

    if (lastReplay.status === 'SOLVED') {
      return {
        stage,
        replay: lastReplay,
        report: {
          iters: it,
          solved: true,
          supplySanitized,
          lastStatus: lastReplay.status,
          lastReason: lastReplay.reason,
          history,
        },
      };
    }
    if (lastReplay.status === 'UNKNOWN') break;

    // If we've gone too long without improvement, restart from the best snapshot and widen backjump.
    if (noImprove >= 16) {
      (cardsObj as any).authored = bestDeckSnapshot.map((c) => ({ ...(c as any) }));
      deck = (cardsObj as any).authored;
      normalizeHintSteps(deck);
      backjump = Math.min(80, backjump + 20);
      noImprove = 6;
      prevSig = '';
      stagnation = 0;
    }
  }

  // If deterministic repair couldn't solve, run a bounded stochastic search.
  if (lastReplay.status !== 'SOLVED') {
    // 먼저: multi-column hintStep(interleave) 탐색 (deck 고정)
    if (!strictDeckAmmoOnly && (opts.hintGa?.enabled ?? false)) {
      const hintTry = !strictDeckAmmoOnly ? await gaSearchReplaySolvedHints(stage, opts) : null;
      if (hintTry && hintTry.replay.status === 'SOLVED') {
        history.push({
          iter: history.length + 1,
          status: 'SOLVED',
          reason: hintTry.replay.reason,
          remaining: hintTry.replay.remaining,
          clicked: hintTry.replay.progress.clicked,
          deckIdx: (hintTry.replay.progress.nextHint - 1) | 0,
          didHintGa: true,
        });
        return {
          stage,
          replay: hintTry.replay,
          report: {
            iters: history.length,
            solved: true,
            supplySanitized,
            lastStatus: 'SOLVED',
            lastReason: hintTry.replay.reason,
            lastStuck: hintTry.replay.stuck,
            history,
          },
        };
      }
      // 실패하면 hintStep이 변경되어 있을 수 있으니 sequential로 복구
      normalizeHintSteps(deck);
    }

    const gaCfg = {
      enabled: !strictDeckAmmoOnly && (opts?.ga?.enabled ?? true),
      maxGens: opts?.ga?.maxGens ?? 800,
      popSize: opts?.ga?.popSize ?? 40,
      elite: opts?.ga?.elite ?? 6,
      maxEvals: opts?.ga?.maxEvals ?? 12000,
    };

    const gaBaseSource = deck.length <= 160 ? deck : baseDeckSnapshot;


    const baseDeck = gaBaseSource.map((c) => ({ ...c }));
    const gaRes = await gaSearchReplaySolvedDeck(stage, baseDeck, {
      maxRounds,
      maxShots,
      ga: gaCfg,
    });

    if (gaRes && gaBetter(gaRes.replay, lastReplay)) {
      lastReplay = gaRes.replay;
      normalizeHintSteps(deck);
      history.push({
        iter: history.length + 1,
        status: lastReplay.status,
        reason: lastReplay.reason,
        didGa: true,
      });

      // GA가 "더 멀리" 진행되는 덱을 찾아도, 마지막에
      // "필요한 색이 남아있는데 덱에 더 이상 없음"(missing-needed-color) 형태로
      // STUCK이 나는 케이스가 있습니다.
      // 이 경우는 결정적 수리(특히 deferMissingNeededColorFromPast)가 훨씬 잘 풀기 때문에
      // GA 결과 위에서 짧게 추가 수리를 한 번 더 돌립니다.
      if (lastReplay.status !== 'SOLVED' && lastReplay.status !== 'UNKNOWN') {
        prevSig = '';
        stagnation = 0;
        backjump = 0;

        const postGaIters = Math.max(40, Math.min(240, Math.floor(maxIters / 2)));

        let bestReplay2 = lastReplay;
        let bestDeckSnapshot2: AuthoredCard[] = deck.map((c) => ({ ...(c as any) }));
        let noImprove2 = 0;
        let inLoopHintGa2 = 0;

        for (let k = 1; k <= postGaIters; k++) {
          const it = history.length + 1;
          const stuck = lastReplay.stuck;

          if (!stuck) {
            history.push({
              iter: it,
              status: lastReplay.status,
              reason: lastReplay.reason,
            });
            break;
          }

          const sig = `${stuck.deckIdx}|${stuck.slotColors.join(',')}|${stuck.slotDeckPos.join(',')}|${stuck.needCounts.join(',')}`;
          if (sig === prevSig) {
            stagnation += 1;
          } else {
            prevSig = sig;
            stagnation = 0;
            if (noImprove2 <= 0) backjump = 0;
          }
          if (stagnation > 3 || noImprove2 >= 6) {
            backjump = Math.min(80, backjump + 20);
          }

          const need = new Int32Array(12);
          need.fill(0);
          for (let i = 0; i < 12; i++) {
            need[i] = stuck.needCounts[i] | 0;
          }

          const rawDeckIdx = Math.max(0, stuck.deckIdx | 0);
          let minSlotPos = rawDeckIdx;
          for (const p of stuck.slotDeckPos) {
            if (p >= 0) minSlotPos = Math.min(minSlotPos, p);
          }
          const pivotBase = Math.max(0, Math.min(rawDeckIdx, minSlotPos));
          const pivotDeckIdx = Math.max(0, pivotBase - backjump);

          const neededColors = pickTopNeedColors(need, 12);
          const capSlots = stuck.slotColors.length | 0;
          const bringCards =
            neededColors.length <= 1
              ? Math.min(12, Math.max(4, capSlots + 3))
              : Math.min(24, Math.max(8, capSlots * 4));
          const scanLimit = neededColors.length <= 1 ? 56 : 72;

          const severe = String((stuck as any)?.reason ?? lastReplay.reason ?? '') === 'FULL_AND_NO_TARGETS';

          if (
            severe &&
            (opts.hintGa?.enabled ?? false) &&
            clampInt(stage?.meta?.pickerCols, 1, 5, 2) >= 2 &&
            inLoopHintGa2 < 2 &&
            (k === 1 || noImprove2 >= 3)
          ) {
            inLoopHintGa2 += 1;
            const hintOpts: ReplayRepairOpts = {
              ...opts,
              hintGa: {
                enabled: true,
                popSize: Math.max(opts?.hintGa?.popSize ?? 22, 48),
                elite: Math.max(opts?.hintGa?.elite ?? 6, 10),
                maxGens: Math.max(opts?.hintGa?.maxGens ?? 10, 40),
                maxEvals: Math.max(opts?.hintGa?.maxEvals ?? 160, 3000),
              },
            };
            const hintTry = !strictDeckAmmoOnly ? await gaSearchReplaySolvedHints(stage, hintOpts) : null;
            if (hintTry && hintTry.replay.status === 'SOLVED') {
              history.push({
                iter: it,
                status: 'SOLVED',
                reason: hintTry.replay.reason,
                didHintGa: true,
              });
              lastReplay = hintTry.replay;
              break;
            }
            normalizeHintSteps(deck);
          }

          const didDefer = deferMissingNeededColorFromPast(deck, stuck, need);

          const didSlotSwap = !didDefer
            ? (severe
                ? repairSwapNeededIntoStuckSlotsMulti(deck, stuck, need, Math.max(1, Math.min(2, capSlots)))
                : repairSwapNeededIntoStuckSlots(deck, stuck, need))
            : false;

          const didEscape = !didDefer && severe && !didSlotSwap
            ? escapeFullAndNoTargetsBySwapAndCap(deck, stuck, need, Math.max(1, Math.min(2, capSlots)), 0)
            : false;

          const didAmmoShift = !didDefer && severe && !didSlotSwap && !didEscape
            ? shiftDeadSlotAmmoToFuture(deck, stuck, need, Math.max(1, Math.min(2, capSlots)))
            : false;

          const doReorder = severe
            ? ((!didSlotSwap && !didEscape && !didAmmoShift) || stagnation > 0 || noImprove2 >= 2)
            : ((!didSlotSwap && !didAmmoShift) || stagnation > 0 || noImprove2 >= 2);
          const didReorder = doReorder
            ? reorderUpcomingDeckByNeed(
                deck,
                pivotDeckIdx,
                need,
                Math.min(bringCards + (severe ? 4 : 0), deck.length - pivotDeckIdx),
                scanLimit + (severe ? 24 : 0),
              )
            : false;

          let didShuffle = false;
          if (
            (severe && !didDefer && !didSlotSwap && !didEscape && (noImprove2 >= 2 || stagnation >= 1)) ||
            (stagnation > 12 && !didDefer) ||
            (!didDefer && !didSlotSwap && !didReorder && (stagnation > 2 || noImprove2 >= 2)) ||
            (!didDefer && noImprove2 >= 10)
          ) {
            const stageId = stage.id | 0;
            const winStart = Math.max(1, pivotDeckIdx);
            const winSize = severe ? 64 : (stagnation > 24 ? 60 : 36);
            const winEnd = Math.min(deck.length, winStart + winSize);
            const seed =
              (((stageId >>> 0) ^
                ((pivotDeckIdx * 0x9e3779b9) >>> 0) ^
                ((it * 0x85ebca6b) >>> 0) ^
                ((noImprove2 * 0x27d4eb2d) >>> 0)) >>>
                0) |
              0;
            didShuffle = shuffleDeckWindow(deck, winStart, winEnd, seed);
          }

          normalizeHintSteps(deck);

          lastReplay = await simulateStageReplay(stage, {
            strictHintOrder: true,
            captureFrames: false,
            maxRounds,
            maxShots,
          });

          history.push({
            iter: it,
            status: lastReplay.status,
            reason: lastReplay.reason,
            deckIdx: stuck.deckIdx,
            didSlotSwap,
            didReorder,
            didDefer,
            didShuffle,
            didAmmoShift,
            didEscape,
            backjump,
          });

          if (gaBetter(lastReplay, bestReplay2)) {
            bestReplay2 = lastReplay;
            bestDeckSnapshot2 = deck.map((c) => ({ ...(c as any) }));
            noImprove2 = 0;
          } else {
            noImprove2 += 1;
          }

          if (lastReplay.status === 'SOLVED') {
            break;
          }
          if (lastReplay.status === 'UNKNOWN') {
            break;
          }

          if (noImprove2 >= 16) {
            (cardsObj as any).authored = bestDeckSnapshot2.map((c) => ({ ...(c as any) }));
            deck = (cardsObj as any).authored;
            normalizeHintSteps(deck);
            backjump = Math.min(80, backjump + 20);
            noImprove2 = 6;
            prevSig = '';
            stagnation = 0;
          }
        }
      }
    }
  }

  return {
    stage,
    replay: lastReplay,
    report: {
      iters: history.length,
      solved: lastReplay.status === 'SOLVED',
      supplySanitized,
      lastStatus: lastReplay.status,
      lastReason: lastReplay.reason,
      lastStuck: lastReplay.stuck,
      history,
    },
  };
}
