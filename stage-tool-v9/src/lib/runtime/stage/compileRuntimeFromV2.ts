import type {
    StageV2,
    Color8,
    StageRuntime,
    CardData,
    RuntimeSpecial,
    RuntimeLargeBlock,
    RuntimeSpawnerBox,
} from '../Types';
import { COLOR_TOKEN_ORDER, colorIdFromToken, SUPPLY_LARGE_BASE } from '../Types';

import { clamp, mulberry32, rngInt, roundDownToStep } from './util';
import { makePaletteHex, normalizeColorIdAny } from './colors';
import {
    decidePickerGrid,
    splitTotalAuto,
    splitTotalBoundedStep,
    arrangeCardsNoAdjacentInPlace,
    ensureMinCardCountSoft,
    promoteColorsToFrontInPlace,
    promoteColorIntoShootersInPlace,
    splitOversizedCardsPrefer2030InPlace,
    arrangeCardsRandomButClear,
} from './cards';

const BOARD = 10;
const DEFAULT_AMMO_STEP = 10;
const COLOR_MAX = 12;

// color / palette는 Types.ts에서 단일 관리합니다.
export function compileRuntimeFromV2(stage: StageV2, opt?: { enableStacks?: boolean }): StageRuntime {
    const enableStacks =
        !!opt?.enableStacks ||
        (stage.meta.layerCount ?? 1) > 1 ||
        (((stage as any).board?.objects ?? (stage as any).objects ?? []) as any[]).some(
            (o) => ((o as any).layer ?? 0) > 0,
        );

    const objects = ((stage as any).board?.objects ?? (stage as any).objects ?? []) as any[];

    const id = stage.id;
    const meta = stage.meta;

    // ✅ colorCount는 "스테이지가 쓰는 색 개수"(툴 메타)로만 취급합니다.
    // 런타임 colorId는 항상 전역(0~11) 기준으로 유지해야 컬러/스프라이트가 절대 흔들리지 않습니다.
    const metaColorCount = clamp(Math.floor(meta.colorCount), 1, COLOR_MAX);
    const colorCount = COLOR_MAX;

    // meta.blockCount는 신뢰하지 않고(툴/게임 불일치 및 메타 오염 가능), 아래에서 항상 재계산합니다.

    // ✅ 요청사항
    // - 캐논 슈터(슬롯)는 최소 3개부터 시작
    // - 탄약 분배는 5 또는 10 단위로만(기본 10, 불가능하면 5로 다운)
    // - 탄약 범위는 최소 20, 최대 50을 기본으로 강제(툴 값이 더 작아도 50까지 허용)
    const MIN_SHOOTERS = 3;
    const slotCount = clamp(Math.floor(meta.slotCount), MIN_SHOOTERS, 5);

    // ✅ waitLineCount: 대기 라인 수(기본 3). UnitLineRack에서 WaitingLine01~03 표시 수를 결정합니다.
    const waitLineCount = clamp(Math.floor((meta as any).waitLineCount ?? 3), 1, 3);

    // ammoStep: 5/10 단위(UX 선호)만 허용합니다.
    // - 정확 합계(histTotal)와 충돌하면 step은 깨질 수 있어야 하므로(요구사항),
    //   여기서는 "선호값"만 저장하고, 최종 step은 뒤에서 totalAmmoTarget 기반으로 재결정합니다.
    const rawStep = Math.max(1, Math.floor((stage.cards?.rules?.ammoStep ?? DEFAULT_AMMO_STEP) as number));
    const ammoStepPreferred = rawStep >= 10 ? 10 : 5;
    let ammoStep = ammoStepPreferred;

    // ✅ ammoMin/ammoMax 정책(요구사항)
    // - ammoMin: 총알 하한선(선호값, soft)
    // - ammoMax: 총알 상한선(선호값, soft)
    // - 단, 1장당 하드 상한은 50으로 고정합니다.
    // - 정책: 데이터가 뒤집혀 들어오면( ammoMin > ammoMax ) 자동 swap + 경고 로그로 보정합니다.
    const AMMO_HARD_MAX = 50;
    const AMMO_HARD_MIN = 1;

    let ammoMinPref = Math.max(1, Math.floor((meta as any).ammoMin ?? 10));
    let ammoMaxPref = Math.max(1, Math.floor((meta as any).ammoMax ?? AMMO_HARD_MAX));
    ammoMaxPref = Math.min(ammoMaxPref, AMMO_HARD_MAX);

    if (ammoMinPref > ammoMaxPref) {
        try {
            console.warn(
                '[StageCompiler] Stage ' +
                    id +
                    ': ammoMin(' +
                    ammoMinPref +
                    ') > ammoMax(' +
                    ammoMaxPref +
                    ') -> swap (auto-fix)',
            );
        } catch {}
        const t = ammoMinPref;
        ammoMinPref = ammoMaxPref;
        ammoMaxPref = t;
    }

    const layerCount = clamp(Math.floor(meta.layerCount ?? 1), 1, 5);

    // 런타임이 1겹인데 툴에서 레이어를 쓰면 바로 깨지므로 막아두는 게 안전합니다.
    if (!enableStacks) {
        if (layerCount > 1) {
            throw new Error(
                `Stage ${id}: layerCount=${layerCount}. 현재 런타임은 1겹만 지원합니다(겹 런타임 패치 필요).`,
            );
        }
        if (objects.some((o) => (o as any).layer && (o as any).layer > 0)) {
            throw new Error(`Stage ${id}: object.layer>0 발견. 현재 런타임은 1겹만 지원합니다(겹 런타임 패치 필요).`);
        }
    }

    const seed = (meta.seed ?? 1000 + id * 777) | 0;
    const rng = mulberry32(seed);

    const paletteHex = makePaletteHex(colorCount);

    // --- 1) 보드 생성: boardTop + (옵션) stacks ---
    const boardTop: number[][] = Array.from({ length: BOARD }, () => new Array(BOARD).fill(-1));
    const hiddenMask: boolean[][] = Array.from({ length: BOARD }, () => new Array(BOARD).fill(false));
    const special: (RuntimeSpecial | null)[][] = Array.from({ length: BOARD }, () => new Array(BOARD).fill(null));
    const largeMask: boolean[][] = Array.from({ length: BOARD }, () => new Array(BOARD).fill(false));
    const largeBlocks: RuntimeLargeBlock[] = [];

    // stacksTemp[y][x][layer] = colorId or -1
    const stacksTemp: number[][][] | null = enableStacks
        ? Array.from({ length: BOARD }, () => Array.from({ length: BOARD }, () => new Array(layerCount).fill(-1)))
        : null;

    const putCell = (x: number, y: number, colorId: number, layer: number) => {
        if (x < 0 || x >= BOARD || y < 0 || y >= BOARD) return;
        const cid = ((colorId % colorCount) + colorCount) % colorCount;

        if (enableStacks && stacksTemp) {
            const L = clamp(Math.floor(layer), 0, layerCount - 1);
            stacksTemp[y][x][L] = cid;
            // top 갱신
            let top = -1;
            for (let l = 0; l < layerCount; l++) if (stacksTemp[y][x][l] >= 0) top = stacksTemp[y][x][l];
            boardTop[y][x] = top;
        } else {
            boardTop[y][x] = cid;
        }
    };

    const inBounds = (x: number, y: number) => x >= 0 && x < BOARD && y >= 0 && y < BOARD;

    // // 스포너/체인은 “추가로 필요한 총 탄약/승리 카운트”에 영향을 줍니다.
    // - ✅ 신규 생성박스는 runtime.spawnerBoxes로 내려가서 보드에서 동적으로 생성됩니다.
    const spawnerBoxes: RuntimeSpawnerBox[] = [];

    // ✅ CHAIN_BARRIER는 export 형태가 2가지가 있어서, 일단 모아뒀다가 후처리로 special/셀을 구성합니다.
    // 1) 정상 export: 같은 chainId를 여러 셀이 공유하며 chainOrder가 들어옴
    // 2) 스턱난 export: 셀마다 chainId가 달라지거나(chainId가 무의미), chainLen만 들어옴
    //    -> (x 오름차순)으로 스캔하며 chainLen(추가 길이)만큼 오른쪽 셀을 같은 체인 묶음으로 묶어줍니다.
    const chainBarriers: {
        x: number;
        y: number;
        layer: number;
        color: any;
        chainIdRaw: string;
        chainOrder?: number;
        chainLen?: number;
    }[] = [];

    // ✅ PILLAR(기둥)도 보드에서 "고정 오브젝트"로 별도 생성합니다.
    const pillars: { x: number; y: number; h: number }[] = [];
    let spawnerTotal = 0;
    const histSpawn = new Array(colorCount).fill(0);
    const histLargeNeed = new Array(colorCount).fill(0); // LARGE는 footprint(4)와 무관하게 hp만큼 히트 필요

    // ✅ 2단계 락 패치: KEY/LOCK id 검증(컴파일 타임)
    // - 역할: LOCK이 존재하면 반드시 동일 id의 KEY가 존재해야 스테이지가 클리어 가능
    // - 빈 id는 실수 가능성이 높으므로 즉시 오류로 처리
    const keyIds = new Set<string>();
    const lockIds = new Set<string>();

    for (const obj of objects) {
        const layer = clamp(Math.floor((obj as any).layer ?? 0), 0, layerCount - 1);

        switch (obj.type) {
            case 'BLOCK_NORMAL':
            case 'BLOCK_SMALL': {
                putCell(obj.x, obj.y, normalizeColorIdAny(obj.color), layer);
                break;
            }
            case 'BLOCK_LARGE': {
                const cid = normalizeColorIdAny(obj.color);
                const hp = Math.max(1, Math.floor((obj as any).hp ?? 1));
                // // LARGE는 2x2 footprint로 배치되지만, 남은 블럭/필요 탄약 카운트는 hp로 봅니다.
                // // 보드 셀에는 실제 블럭을 깔지 않고(=겹/초기 블럭 카운트에 포함 X) 마스크만 남깁니다.
                largeBlocks.push({ x: obj.x | 0, y: obj.y | 0, w: 2, h: 2, colorId: cid, hp, hpMax: hp });
                histLargeNeed[cid] += hp;
                for (let dy = 0; dy < 2; dy++) {
                    for (let dx = 0; dx < 2; dx++) {
                        const xx = (obj.x | 0) + dx;
                        const yy = (obj.y | 0) + dy;
                        if (inBounds(xx, yy)) largeMask[yy][xx] = true;
                    }
                }
                break;
            }
            case 'BLOCK_LARGE_HIDDEN': {
                const cid =
                    (obj as any).color != null ? normalizeColorIdAny((obj as any).color) : rngInt(rng, 0, colorCount);
                const hp = Math.max(1, Math.floor((obj as any).hp ?? 1));
                // // LARGE_HIDDEN: 2x2 footprint + HP 기반, 시작은 숨김
                largeBlocks.push({ x: obj.x | 0, y: obj.y | 0, w: 2, h: 2, colorId: cid, hp, hpMax: hp, hidden: true });
                histLargeNeed[cid] += hp;
                for (let dy = 0; dy < 2; dy++) {
                    for (let dx = 0; dx < 2; dx++) {
                        const xx = (obj.x | 0) + dx;
                        const yy = (obj.y | 0) + dy;
                        if (inBounds(xx, yy)) largeMask[yy][xx] = true;
                    }
                }
                break;
            }
            case 'BLOCK_HIDDEN': {
                const cid =
                    (obj as any).color != null ? normalizeColorIdAny((obj as any).color) : rngInt(rng, 0, colorCount);
                putCell(obj.x, obj.y, cid, layer);
                if (inBounds(obj.x, obj.y)) hiddenMask[obj.y][obj.x] = true;
                break;
            }
            case 'CHAIN_BARRIER': {
                // ✅ 후처리에서 grouping/ordering을 수행
                const x0 = obj.x | 0;
                const y0 = obj.y | 0;
                if (!inBounds(x0, y0)) break;

                const chainIdRaw = String((obj as any).chainId ?? (obj as any).chainGroupId ?? '').trim();
                const chainOrder = Number.isFinite((obj as any).chainOrder)
                    ? (((obj as any).chainOrder as any) | 0)
                    : undefined;
                const chainLen = Number.isFinite((obj as any).chainLen) ? (((obj as any).chainLen as any) | 0) : undefined;

                chainBarriers.push({ x: x0, y: y0, layer, color: (obj as any).color, chainIdRaw, chainOrder, chainLen });
                break;
            }
            case 'KEY': {
                putCell(obj.x, obj.y, rngInt(rng, 0, colorCount), layer);
                const kid = String((obj as any).keyId ?? '').trim();
                if (!kid) throw new Error(`Stage ${id}: KEY id is empty at (${obj.x},${obj.y})`);
                if (inBounds(obj.x, obj.y)) special[obj.y][obj.x] = { t: 'KEY', id: kid };
                keyIds.add(kid);
                break;
            }
            case 'LOCK': {
                putCell(obj.x, obj.y, rngInt(rng, 0, colorCount), layer);
                const lid = String((obj as any).lockId ?? '').trim();
                if (!lid) throw new Error(`Stage ${id}: LOCK id is empty at (${obj.x},${obj.y})`);
                if (inBounds(obj.x, obj.y)) special[obj.y][obj.x] = { t: 'LOCK', id: lid };
                lockIds.add(lid);
                break;
            }
            case 'PILLAR': {
                // ✅ 기둥(고정 장애물)
                // - (x,y)는 기둥의 바닥(row), h만큼 위로 차지
                const x0 = obj.x | 0;
                const y0 = obj.y | 0;
                const h0 = Math.max(1, Math.floor((obj as any).h ?? (obj as any).height ?? 1));

                // 유효 범위 내로만 클램프
                if (x0 < 0 || x0 >= BOARD) break;
                if (y0 < 0 || y0 >= BOARD) break;

                const hClamped = Math.min(h0, BOARD - y0);
                pillars.push({ x: x0, y: y0, h: hClamped });
                break;
            }
            case 'SPAWNER_BOX': {
                // ✅ 신규 생성박스(2x2 박스 + 아래 spawn row)
                // - (x,y)는 "박스 자체"(2x2)의 하단-좌측입니다.
                // - 실제 생성(spawn)은 박스 바로 아래 1줄(spawn row)에서 수행됩니다.
                //   spawn row = (x,y-1) / (x+1,y-1)
                // - 박스는 낙하하지 않는 "고정" 오브젝트입니다.
                // - spawn row 2칸 중 비어있는 칸만큼 블럭을 생성합니다(좌→우).
                // - hp는 "생성할 블럭 수"입니다. (1개 생성할 때마다 1 감소)

                const x0 = obj.x | 0;
                const y0 = obj.y | 0;
                // 박스(2x2)는 보드 안에 있어야 하고,
                // spawn row가 존재하려면 y0-1 >= 0 이어야 합니다.
                if (!(x0 >= 0 && x0 + 1 < BOARD && y0 >= 1 && y0 + 1 < BOARD)) break;

                const spawnBlocks = Math.max(0, Math.floor((obj as any).hp ?? (obj as any).spawnCount ?? 0));
                if (spawnBlocks <= 0) break;

                // ✅ v48+: poolColors는 "좌/우 고정 색"으로 해석합니다.
                // - poolColors[0] = 왼쪽 셀( x0 )
                // - poolColors[1] = 오른쪽 셀( x0+1 )
                const poolColors = Array.isArray((obj as any).spawn?.poolColors)
                    ? ((obj as any).spawn.poolColors as any[] as Color8[])
                    : [];

                const poolIdsRaw = poolColors.length
                    ? poolColors.map((c) => normalizeColorIdAny(c)).filter((v) => v >= 0 && v < colorCount)
                    : [];
                const poolIds = poolIdsRaw.length ? poolIdsRaw : [0, 0];
                const leftColor = (poolIds[0] ?? 0) | 0;
                const rightColor = (poolIds[1] ?? poolIds[0] ?? 0) | 0;

                // queue는 "남은 생성 횟수"만 표현하면 되므로, 값 자체는 의미가 없습니다.
                // (Board.processSpawnerBoxes에서 좌/우 고정 색을 사용)
                const queue: number[] = [];
                for (let i = 0; i < spawnBlocks; i++) {
                    queue.push(1);
                    // 카드 생성(탄약 분배)용 색상 히스토그램은 "좌/우 교차"로 보수적으로 카운트합니다.
                    // - 실제 플레이에서는 한쪽이 더 많이 생성될 수도 있으나,
                    //   좌/우 모두 생성 가능하도록 설계하는 것이 권장됩니다.
                    const cid = (i % 2 === 0 ? leftColor : rightColor) | 0;
                    if (cid >= 0 && cid < colorCount) histSpawn[cid] += 1;
                }

                spawnerBoxes.push({ x: x0, y: y0, queue, colors: [leftColor, rightColor] });
                spawnerTotal += queue.length;
                break;
            }
        }
    }

    // ✅ CHAIN_BARRIER 후처리
    // - 정상 export(같은 chainId 반복): id/order를 그대로 사용
    // - 스턱난 export(chainId가 모두 유니크/무의미): chainLen(추가 길이)로 (x 오름차순) 그룹을 재구성
    if (chainBarriers.length > 0) {
        // (layer,y) 단위로 묶습니다(가로 체인 가정).
        const byRow = new Map<string, typeof chainBarriers>();
        for (const o of chainBarriers) {
            const k = `${o.layer}|${o.y}`;
            let arr = byRow.get(k);
            if (!arr) byRow.set(k, (arr = []));
            arr.push(o);
        }

        for (const arr of byRow.values()) {
            arr.sort((a, b) => (a.x | 0) - (b.x | 0));

            // 같은 chainId가 2개 이상 존재하면 "정상 export"로 간주
            const idCount = new Map<string, number>();
            for (const o of arr) {
                const id0 = String(o.chainIdRaw ?? '').trim();
                if (!id0) continue;
                idCount.set(id0, (idCount.get(id0) ?? 0) + 1);
            }
            const hasRepeatId = Array.from(idCount.values()).some((v) => (v | 0) >= 2);

            if (hasRepeatId) {
                // (A) 정상 export: chainId 기준으로 묶고, chainOrder가 없으면 x순으로 보정
                const byId = new Map<string, typeof arr>();
                for (const o of arr) {
                    const id0 = String(o.chainIdRaw ?? '').trim() || `C_${o.layer}_${o.x | 0}_${o.y | 0}`;
                    let g = byId.get(id0);
                    if (!g) byId.set(id0, (g = []));
                    g.push(o);
                }

                for (const [chainId, list] of byId) {
                    list.sort((a, b) => (a.x | 0) - (b.x | 0));
                    for (let i = 0; i < list.length; i++) {
                        const o = list[i];
                        const order = (o.chainOrder != null ? (o.chainOrder as any) : i) | 0;
                        const cid = normalizeColorIdAny(o.color);
                        putCell(o.x, o.y, cid, o.layer);
                        special[o.y][o.x] = { t: 'CHAIN_SEG', id: chainId, order };
                    }
                }
            } else {
                // (B) 스턱난 export:
                // - 케이스1) chainLen이 의미 있는 경우(>=2): 기존처럼 길이 기반 그룹핑을 우선합니다.
                // - 케이스2) chainLen이 전부 1(또는 없음)이고 chainId가 셀마다 달라지는 경우(Stage3 등):
                //          "연속된 x(run)"를 하나의 체인으로 묶고, order를 부여합니다.
                const anyLenGt1 = arr.some((o) => (((o.chainLen ?? 0) as any) | 0) > 1);

                if (!anyLenGt1) {
                    // (B-2) run 기반(연속된 x) 그룹핑
                    const parseNum = (s: string): number | null => {
                        const m = /(\d+)(?!.*\d)/.exec(String(s ?? ''));
                        if (!m) return null;
                        const n = parseInt(m[1], 10);
                        return Number.isFinite(n) ? n : null;
                    };

                    let run: typeof arr = [];

                    const flushRun = () => {
                        if (!run || run.length <= 0) return;

                        const x0 = (run[0].x | 0) | 0;
                        const x1 = (run[run.length - 1].x | 0) | 0;
                        const y0 = (run[0].y | 0) | 0;
                        const layer0 = (run[0].layer | 0) | 0;

                        // id는 "같은 체인 묶음"을 구분하기만 하면 되므로, row/run 범위로 결정성 있게 생성합니다.
                        const chainId = `C_${layer0}_${y0}_${x0}_${x1}`;

                        // head 방향 추정(선택):
                        // - chainIdRaw에 숫자가 있고, x 증가에 따라 숫자가 감소하면 head=오른쪽(=tail이 왼쪽)으로 판단합니다.
                        // - 그 외에는 head=왼쪽(=tail이 오른쪽)으로 처리합니다.
                        let dir: 1 | -1 = 1;

                        if (run.length >= 2) {
                            const nums: number[] = [];
                            let ok = true;
                            for (let i = 0; i < run.length; i++) {
                                const n = parseNum(run[i].chainIdRaw);
                                if (n == null) {
                                    ok = false;
                                    break;
                                }
                                nums.push(n);
                            }

                            if (ok) {
                                let nonDec = true;
                                let nonInc = true;
                                for (let i = 1; i < nums.length; i++) {
                                    if (nums[i] < nums[i - 1]) nonDec = false;
                                    if (nums[i] > nums[i - 1]) nonInc = false;
                                }
                                if (nonInc && !nonDec) dir = -1;
                                else dir = 1;
                            }
                        }

                        for (let i = 0; i < run.length; i++) {
                            const o = run[i];
                            const order = (dir === 1 ? i : run.length - 1 - i) | 0;
                            const cid = normalizeColorIdAny(o.color);
                            putCell(o.x, o.y, cid, o.layer);
                            special[o.y][o.x] = { t: 'CHAIN_SEG', id: chainId, order };
                        }
                    };

                    for (let i = 0; i < arr.length; i++) {
                        const o = arr[i];
                        if (run.length <= 0) {
                            run = [o];
                            continue;
                        }
                        const prev = run[run.length - 1];
                        if ((o.x | 0) === ((prev.x | 0) + 1)) {
                            run.push(o);
                        } else {
                            flushRun();
                            run = [o];
                        }
                    }
                    flushRun();
                } else {
                    // (B-1) 구형/오염 데이터: chainLen(그룹 길이) 기반으로 좌->우 스캔하며 그룹을 만든다.
                    const byX = new Map<number, (typeof arr)[number]>();
                    for (const o of arr) byX.set(o.x | 0, o);

                    const visited = new Set<number>();
                    for (const head of arr) {
                        const hx = head.x | 0;
                        if (visited.has(hx)) continue;

                        const chainId = String(head.chainIdRaw ?? '').trim() || `C_${head.layer}_${hx}_${head.y | 0}`;
                        // 호환 처리:
                        // - 최신 데이터: chainLen은 "그룹 길이(1~10)" 의미(= head 포함)
                        // - 구형/오염 데이터: 값이 이상해도 최소 1칸은 보장
                        let groupSize = head.chainLen != null ? ((head.chainLen as any) | 0) : 1;
                        if (!Number.isFinite(groupSize as any)) groupSize = 1;
                        if (groupSize < 1) groupSize = 1;
                        if (groupSize > BOARD) groupSize = BOARD;

                        for (let k = 0; k < groupSize; k++) {
                            const xx = (hx + k) | 0;
                            const cell = byX.get(xx);

                            // 스턱난 export: head만 있고 나머지 셀이 누락된 케이스 -> 빈 칸이면 "가상 셀"을 만들어줌
                            if (!cell) {
                                if (!inBounds(xx, head.y)) break;
                                if (visited.has(xx)) continue;
                                if (largeMask[head.y][xx]) break;
                                if (special[head.y][xx] != null) break;
                                if (boardTop[head.y][xx] >= 0) break;

                                visited.add(xx);
                                const cid = normalizeColorIdAny(head.color);
                                putCell(xx, head.y, cid, head.layer);
                                special[head.y][xx] = { t: 'CHAIN_SEG', id: chainId, order: k | 0 };
                                continue;
                            }

                            if (visited.has(xx)) continue;
                            visited.add(xx);

                            const cid = normalizeColorIdAny(cell.color);
                            putCell(xx, cell.y, cid, cell.layer);
                            special[cell.y][xx] = { t: 'CHAIN_SEG', id: chainId, order: k | 0 };
                        }
                    }
                }
}
        }
    }

    // ✅ LOCK은 반드시 동일 id의 KEY가 있어야 해제 가능합니다.
    for (const lid of lockIds) {
        if (!keyIds.has(lid)) {
            throw new Error(`Stage ${id}: LOCK id "${lid}" has no matching KEY`);
        }
    }

    // initial(보드에 깔린 "일반 셀" 블럭) 계산 + 색 히스토그램
    // LARGE는 셀에 직접 깔지 않으므로 initial에는 포함되지 않고, histLargeNeed로 별도 카운트합니다.
    let initial = 0;
    const histInitial = new Array(colorCount).fill(0);

    if (enableStacks && stacksTemp) {
        for (let y = 0; y < BOARD; y++) {
            for (let x = 0; x < BOARD; x++) {
                const sp = special[y]?.[x] ?? null;
                if (sp?.t === 'KEY' || sp?.t === 'LOCK') continue;
                for (let l = 0; l < layerCount; l++) {
                    const v = stacksTemp[y][x][l];
                    if (v >= 0) {
                        initial++;
                        histInitial[v]++;
                    }
                }
            }
        }
    } else {
        for (let y = 0; y < BOARD; y++)
            for (let x = 0; x < BOARD; x++) {
                const sp = special[y]?.[x] ?? null;
                if (sp?.t === 'KEY' || sp?.t === 'LOCK') continue;
                const v = boardTop[y][x];
                if (v >= 0) {
                    initial++;
                    histInitial[v]++;
                }
            }
    }

    // LARGE의 "필요 히트"(=hp) 총합
    const largeNeedTotal = histLargeNeed.reduce((a, b) => a + b, 0);

    // initialHits = (일반 셀 블럭 수) + (LARGE hp)
    const initialHits = initial + largeNeedTotal + spawnerTotal; // spawnerTotal 포함(목표/현재 카운트 일치)

    // --- 2) supply(공급) 파싱 ---
    // ✅ 신규 JSON: supply.pages[] 에 10x10 패턴이 들어올 수 있습니다.
    // - 역할: "보드에서 제거된 만큼" 해당 컬럼의 공급 스택에서 내려옵니다.
    // - 구현: pages를 컬럼별 스택(columnSupply)으로 1회 변환(런타임은 pop()만 수행)
    const supplyPagesRaw = Array.isArray((stage.supply as any)?.pages) ? ((stage.supply as any).pages as any[]) : [];

    // (레거시) perCol 방식: 컬럼별 공급 개수(색은 컴파일러가 seed로 생성)
    const perColRaw = Array.isArray(stage.supply?.perCol) ? stage.supply.perCol : [];
    const perCol = Array.from({ length: BOARD }, (_, i) => Math.max(0, Math.floor(perColRaw[i] ?? 0)));

    // supplySumHits: "추가로 필요한 타수" 기준 합계
    // - SMALL/HIDDEN: 1개 = 1타
    // - LARGE(2x2): hp 만큼(footprint 4와 무관)
    let supplySumHits = 0;

    // --- 3) columnSupply 생성(색 히스토그램 포함) ---
    const columnSupply: number[][] = Array.from({ length: BOARD }, () => []);
    // ✅ supply에서 LARGE(2x2)를 런타임에서 BIG 1개로 생성하기 위해
    //    (idx*4+cell) 토큰을 columnSupply에 넣고, 정의는 별도 배열로 보관합니다.
    const supplyLargeDefs: { colorId: number; hp: number; hpMax: number; hidden?: boolean }[] = [];
    const histSupply = new Array(colorCount).fill(0);

    if (supplyPagesRaw.length > 0) {
        // pages -> columnSupply
        for (let p = 0; p < supplyPagesRaw.length; p++) {
            const pageObjs = ((supplyPagesRaw[p] as any)?.objects ?? []) as any[];
            // 컬럼별로 (y,cid) 모아서 y 오름차순(=아래→위)으로 정렬한 뒤 append
            const colTuples: { y: number; c: number }[][] = Array.from({ length: BOARD }, () => []);

            for (let oi = 0; oi < pageObjs.length; oi++) {
                const obj = pageObjs[oi] as any;
                const t = String(obj?.type ?? '');
                const x = (obj?.x ?? -1) | 0;
                const y = (obj?.y ?? -1) | 0;
                if (x < 0 || x >= BOARD || y < 0 || y >= BOARD) continue;

                if (t === 'BLOCK_NORMAL' || t === 'BLOCK_SMALL') {
                    const cid = normalizeColorIdAny(obj.color);
                    colTuples[x].push({ y, c: cid });
                    // ✅ SMALL 공급 1개 = 1타
                    histSupply[cid] += 1;
                    supplySumHits += 1;
                } else if (t === 'BLOCK_HIDDEN') {
                    // // 역할: supply의 히든도 JSON color를 우선 사용(없으면 시드 랜덤)
                    const cid =
                        obj.color != null
                            ? normalizeColorIdAny(obj.color)
                            : rngInt(mulberry32((seed + 9000 + p * 97 + x * 13 + y * 101) | 0), 0, colorCount);
                    // ✅ 히든 공급은 음수 인코딩(-(cid+1))로 내려보내 런타임에서 숨김 상태를 유지합니다.
                    colTuples[x].push({ y, c: -((cid | 0) + 1) });
                    // ✅ HIDDEN 공급도 1개 = 1타
                    histSupply[cid] += 1;
                    supplySumHits += 1;
                } else if (t === 'BLOCK_LARGE' || t === 'BLOCK_LARGE_HIDDEN') {
                    // ✅ 역할: supply의 LARGE(2x2)를 "진짜 BIG 1개"로 생성하기 위해
                    //    2x2 footprint(4셀)에 연결 토큰을 넣고, 별도 defs에 hp/hidden/color를 보관합니다.
                    const cid0 =
                        obj.color != null
                            ? normalizeColorIdAny(obj.color)
                            : rngInt(mulberry32((seed + 9300 + p * 97 + x * 13 + y * 101) | 0), 0, colorCount);

                    const hp = Math.max(1, Math.floor((obj as any).hp ?? 1));
                    const hidden = t === 'BLOCK_LARGE_HIDDEN';
                    const idx = supplyLargeDefs.push({ colorId: cid0 | 0, hp, hpMax: hp, hidden }) - 1;

                    // 공급 타수는 hp만큼(footprint 4와 무관)
                    histSupply[cid0 | 0] += hp;
                    supplySumHits += hp;

                    // (x,y) 앵커 기준 2x2 -> 4셀 각각에 토큰 부여
                    for (let dy = 0; dy < 2; dy++) {
                        for (let dx = 0; dx < 2; dx++) {
                            const xx = x + dx;
                            const yy = y + dy;
                            if (xx < 0 || xx >= BOARD || yy < 0 || yy >= BOARD) continue;
                            const cell = dy * 2 + dx; // 0..3
                            const enc = (SUPPLY_LARGE_BASE + idx * 4 + cell) | 0;
                            colTuples[xx].push({ y: yy, c: enc });
                        }
                    }
                }
            }

            for (let col = 0; col < BOARD; col++) {
                const arr = colTuples[col];
                if (arr.length <= 0) continue;

                arr.sort((a, b) => a.y - b.y);

                for (let k = 0; k < arr.length; k++) {
                    const enc = arr[k].c | 0;
                    columnSupply[col].push(enc);
                }
            }
        }

        // pop()이 "아래쪽(y 작은)" 블럭부터 나오도록 reverse
        for (let col = 0; col < BOARD; col++) columnSupply[col].reverse();
    } else {
        // --- 3-1) 레거시 perCol -> columnSupply(가중 랜덤) ---
        // 현재 보드 등장색 위주
        let presentColors: number[] = [];
        for (let c = 0; c < colorCount; c++) if (histInitial[c] > 0 || histLargeNeed[c] > 0) presentColors.push(c);
        if (presentColors.length === 0) presentColors = Array.from({ length: colorCount }, (_, i) => i);
        const presentWeights = presentColors.map((cid) => Math.max(1, histInitial[cid] + histLargeNeed[cid]));

        const rngSupply = mulberry32(seed + 31);

        for (let col = 0; col < BOARD; col++) {
            const n = perCol[col] ?? 0;
            const dropOrder: number[] = [];
            for (let i = 0; i < n; i++) {
                let sum = 0;
                for (const w of presentWeights) sum += Math.max(0, w);

                let cid = presentColors[rngInt(rngSupply, 0, presentColors.length)];

                if (sum > 0) {
                    let r = rngSupply() * sum;
                    for (let k = 0; k < presentColors.length; k++) {
                        r -= Math.max(0, presentWeights[k]);
                        if (r <= 0) {
                            cid = presentColors[k];
                            break;
                        }
                    }
                }

                dropOrder.push(cid);
                histSupply[cid] += 1;
            }
            supplySumHits += n;
            columnSupply[col] = dropOrder.reverse();
        }
    }

    // --- 2-1) blockCount/totalBlocks ---
    // ✅ 요구사항
    // - meta.blockCount를 늘리면(예: 500) 부족분은 보드(0,0부터) → 공급페이지(0,0부터) 순서로 복사해 채웁니다.
    // - supply/pages가 비어있어도 '보드 복사'로 먼저 채울 수 있어야 합니다.
    const computedBlockCount = initialHits + supplySumHits + spawnerTotal;
    const blockCountMeta = Math.max(0, Math.floor((stage.meta as any)?.blockCount ?? 0));
    let blockCount = blockCountMeta > computedBlockCount ? blockCountMeta : computedBlockCount;

    // ✅ meta.blockCount가 더 크면 supply를 자동 보정합니다.
    // - 채우는 순서: 초기 보드(0,0→)의 색 순회 → 공급페이지(0,0→)의 색 순회
    // - 컬럼 배치는 round-robin(좌→우)로 쌓습니다.
    const supplyNeeded = Math.max(0, (blockCount - initialHits) - supplySumHits);
    if (supplyNeeded > 0) {
        // 1) 보드에서 복사용 색 리스트 생성
        const fillColors: number[] = [];
        for (let y = 0; y < BOARD; y++) {
            for (let x = 0; x < BOARD; x++) {
                const ent = boardTop[y]?.[x];
                if (!ent) continue;
                // KEY/LOCK 등은 카운트에서 제외하므로 supply 색 소스로도 제외합니다.
                const sp = (ent as any).special;
                const st = (sp as any)?.t;
                if (st === 'KEY' || st === 'LOCK') continue;
                const cid = (ent as any).colorId;
                if (typeof cid === 'number' && cid >= 0 && cid < colorCount) fillColors.push(cid | 0);
            }
        }
        // 2) 공급페이지에서도 색을 추가(있으면)
        if (stage.supply?.pages?.length) {
            for (let p = 0; p < stage.supply.pages.length; p++) {
                const objs = (stage.supply.pages[p]?.objects ?? []) as any[];
                for (let i = 0; i < objs.length; i++) {
                    const o = objs[i] as any;
                    const t = o?.type;
                    if (!t) continue;
                    if (t === 'KEY' || t === 'PILLAR') continue;
                    const cid = typeof o.color === 'string' ? colorIdFromToken(o.color, 12) : (o.colorId ?? -1);
                    if (typeof cid === 'number' && cid >= 0 && cid < colorCount) fillColors.push(cid | 0);
                }
            }
        }
        // 3) 그래도 비면 팔레트 전체로 fallback
        if (fillColors.length <= 0) {
            for (let c = 0; c < colorCount; c++) fillColors.push(c);
        }

        let ci = 0;
        for (let k = 0; k < supplyNeeded; k++) {
            const cid = fillColors[ci] | 0;
            ci++;
            if (ci >= fillColors.length) ci = 0;
            const col = k % BOARD;
            if (!columnSupply[col]) columnSupply[col] = [];
            // columnSupply는 "아래->위" 스택이므로 push로 쌓고, 실제 드랍에서는 pop 사용
            columnSupply[col].push(cid);
            histSupply[cid] += 1;
            supplySumHits += 1;
        }

        // supply가 늘어났으므로 실제 blockCount도 다시 computed 기준으로 맞춥니다.
        // (meta가 더 컸고 그걸 채웠다면 supplySumHits가 증가했으니 computed도 따라감)
        const recomputed = initialHits + supplySumHits + spawnerTotal;
        if (recomputed > blockCount) blockCount = recomputed;
    }

    // supply 합계(디버그용)
    const supplyExpected = blockCount - initialHits;
    // totalBlocks는 별도 규칙이 없으면 blockCount와 동일
    let totalBlocks = blockCount;

    // 최종 보정: 실제 필요 히트보다 totalBlocks가 작지 않게
    const requiredHits = initialHits + supplySumHits + spawnerTotal;
    if (totalBlocks < requiredHits) totalBlocks = requiredHits;

    // --- 4) 카드 생성:
    const histTotal = new Array(colorCount).fill(0);
    for (let c = 0; c < colorCount; c++) {
        // // 초기 + 공급 + (스포너 생성물) + (체인 추가 히트)
        histTotal[c] = histInitial[c] + histSupply[c] + histSpawn[c] + histLargeNeed[c];
    }

    // 카드 총 탄약 목표

    // ammoMinPreferred는 "선호 최소값"이므로, 실제 분배(정확합계)에서 강제하지 않습니다.
    // 대신, UX상 너무 작은 조각(remainder)을 만들지 않도록 splitExactPrefer에서만 참고합니다.

    const totalAmmoRule = stage.cards?.rules?.totalAmmoEquals;
    // ✅ 총탄 목표는 "블럭 총 개수"(툴 meta.blockCount)를 우선 사용합니다.
    // (totalBlocks는 CHAIN 추가히트 등으로 보정된 "승리/남은블럭" 기준이라, 카드 총탄과 분리)
    const baseAmmo =
        totalAmmoRule === 'BOARD_BLOCKS' || totalAmmoRule == null
            ? blockCount
            : typeof totalAmmoRule === 'number'
              ? totalAmmoRule
              : blockCount;

    // ✅ 총탄 분배 규칙(클리어 보장):
    // - meta.blockCount(툴 메타)는 참고하지 않고, 실제 필요 히트(histTotal) 합계를 기준으로 합니다.
    // - 색상별 총탄 합계는 histTotal과 "정확히" 일치(잔탄/여유탄 금지)해야 데드락을 방지할 수 있습니다.
    const targetAmmoByColor = new Array(colorCount).fill(0);
    let totalAmmoTarget = 0;
    for (let c = 0; c < colorCount; c++) {
        const need = histTotal[c] | 0;
        if (need <= 0) continue;
        targetAmmoByColor[c] = need;
        totalAmmoTarget += need;
    }

    // ✅ ammoStep 최종 결정:
    // - step은 UX 선호(5/10)일 뿐이며, "정확합계"를 깨면 안 됩니다.
    // - totalAmmoTarget이 10으로 안 나눠지고 5로는 나눠지면 5로 내려가 UX를 맞추고,
    //   그 외에는 preferred를 유지합니다.
    if (totalAmmoTarget > 0) {
        if (totalAmmoTarget % 10 !== 0 && totalAmmoTarget % 5 === 0) ammoStep = 5;
        else ammoStep = ammoStepPreferred;
    } else {
        ammoStep = ammoStepPreferred;
    }

    // ✅ ammoMax는 유닛 1장당 상한(하드). step 정렬은 UX 목적(정확합계와 무관).
    // ammoMax는 JSON 상한(하드). step 정렬을 위해 상한을 올리면 '상한선' 의미가 깨지므로 보정하지 않습니다.
    // (step은 분배 시에만 '가능하면' 맞추고, 최종 합계/경계가 우선)
    // ammoMax = ammoMax;

    // // 역할: 한 색상의 총탄(total)을 ammoMax 이하 카드로 쪼갭니다(정확 합계).
    // - 30/20 우선 → 그 다음 step(5/10) → 마지막 remainder 순으로 잘라 UX를 유지합니다.
    // ✅ shotCount(총구 1/2) 기반 카드 생성 규칙(요구사항)
    // - 1총구(shotCount=1) : ammo 20 우선
    // - 2총구(shotCount=2) : ammo 30 우선
    // - ammoMin/ammoMax는 선호값(soft)
    // - 5/10 단위는 "가능하면" 지킵니다(정확합계가 우선)
    const clamp01 = (v: number) => (Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0);

    // GameFlow의 기본값(Inspector 기본 0.3)과 동일하게 맞춰, shotCount가 JSON에 없을 때의 랜덤과 충돌하지 않게 합니다.
    // stage.meta.shot2Rate가 있으면 그 값을 우선 사용합니다.
    const shot2Rate = clamp01((meta as any).shot2Rate ?? 0.3);

    // 색상별 total을 "선호(min/max) + 하드상한(50)" 내에서 정확합계로 분할하고, 각 카드에 shotCount를 부여합니다.
    // - ammoMin/ammoMax는 soft (가능하면 지키되, 정확합계/클리어 보장이 우선)
    // - 1장 하드 상한은 50(AMMO_HARD_MAX)
    const buildCardsForColor = (colorId: number, total: number, rngLocal: () => number): CardData[] => {
        const T = total | 0;
        if (T <= 0) return [];

        const minPref = ammoMinPref | 0;
        const maxPref = ammoMaxPref | 0;
        const hardMax = AMMO_HARD_MAX;
        const hardMin = AMMO_HARD_MIN;

        // ✅ total이 선호 하한보다 작으면: 1장으로 그대로 허용(soft)
        if (T < minPref) {
            const shotCount: 1 | 2 = rngLocal() < shot2Rate ? 2 : 1;
            return [{ colorId, ammo: Math.min(hardMax, Math.max(hardMin, T)), shotCount }];
        }

        // ✅ 카드 개수 산정: 선호 상한 우선, 불가능하면 하드 상한(50)으로 보정
        const effMax = Math.max(1, Math.min(hardMax, Math.max(maxPref, 1)));
        const minCards = Math.ceil(T / effMax);
        const maxCards = Math.max(minCards, Math.ceil(T / Math.max(1, minPref)));

        // 기대 선호값(1총구=20, 2총구=30)
        const expPref = 20 * (1 - shot2Rate) + 30 * shot2Rate;

        let count = Math.round(T / Math.max(1, expPref));
        count = clamp(count, Math.max(1, minCards), Math.max(1, maxCards));

        // step(5/10) 우선: 총합이 10으로 나눠지면 10, 아니면 5, 아니면 1
        const step = T % 10 === 0 ? 10 : T % 5 === 0 ? 5 : 1;

        // 1) shotCount 결정(결정성 유지)
        const shot: (1 | 2)[] = new Array(count);
        for (let i = 0; i < count; i++) shot[i] = rngLocal() < shot2Rate ? 2 : 1;

        // 2) minPref로 베이스 깔고, 남는 탄을 선호 타겟(20/30)에 먼저 맞춘 뒤, 남은 건 분산
        const ammo = new Int32Array(count);
        for (let i = 0; i < count; i++) ammo[i] = minPref | 0;

        let remain = T - count * minPref;
        if (remain < 0) remain = 0;

        // (A) 선호 타겟으로 1차 채우기
        for (let i = 0; i < count && remain > 0; i++) {
            const pref = shot[i] === 2 ? 30 : 20;
            const target = clamp(pref, Math.max(hardMin, minPref), hardMax);
            let need = target - ammo[i];
            if (need <= 0) continue;
            if (step > 1) need = roundDownToStep(need, step);
            const take = Math.min(remain, Math.max(0, need));
            if (take > 0) {
                ammo[i] += take;
                remain -= take;
            }
        }

        // (B) 남은 탄은 headroom 큰 카드부터 step 단위로 채우기
        let guard = 200000;
        while (remain > 0 && guard-- > 0) {
            let pick = -1;
            let bestRoom = 0;
            for (let i = 0; i < count; i++) {
                const room = (hardMax - ammo[i]) | 0;
                if (room <= 0) continue;
                if (room > bestRoom) {
                    bestRoom = room;
                    pick = i;
                }
            }
            if (pick < 0) break;

            let inc = step > 1 ? step : 1;
            if (inc > remain) inc = remain;
            if (step > 1 && inc === remain && remain % step !== 0) inc = 1;
            if (ammo[pick] + inc > hardMax) inc = hardMax - ammo[pick];
            if (inc <= 0) break;

            ammo[pick] += inc;
            remain -= inc;
        }

        // (C) 정확합계 보정(안전)
        let sum = 0;
        for (let i = 0; i < count; i++) sum += ammo[i] | 0;
        const diff = T - sum;
        if (diff !== 0) {
            let d = diff;
            let g2 = 500000;
            while (d !== 0 && g2-- > 0) {
                let idx = -1;
                if (d > 0) {
                    for (let i = 0; i < count; i++) {
                        if (ammo[i] < hardMax) {
                            idx = i;
                            break;
                        }
                    }
                    if (idx < 0) break;
                    ammo[idx] += 1;
                    d -= 1;
                } else {
                    for (let i = 0; i < count; i++) {
                        if (ammo[i] > hardMin) {
                            idx = i;
                            break;
                        }
                    }
                    if (idx < 0) break;
                    ammo[idx] -= 1;
                    d += 1;
                }
            }

            let sum2 = 0;
            for (let i = 0; i < count; i++) sum2 += ammo[i] | 0;
            if (sum2 !== T) {
                throw new Error(
                    `Stage ${id}: ammo sum adjust failed color=${COLOR_TOKEN_ORDER[colorId] ?? colorId} expected=${T} got=${sum2}`,
                );
            }
        }

        const out: CardData[] = new Array(count);
        for (let i = 0; i < count; i++) out[i] = { colorId, ammo: ammo[i] | 0, shotCount: shot[i] };
        return out;
    };

    // --- 4-1) 카드 소스 결정 ---
    // - GENERATE: 아래 로직으로 histTotal 기반 "클리어 보장" 분배 생성
    // - AUTHORED/FIXED/MANUAL(+list): stage JSON에 카드 리스트가 이미 들어있으면 그걸 사용(순서 포함)
    const cards: CardData[] = [];

    // ✅ IMPORTANT(최종 정책):
    // - AUTHORED/FIXED/MANUAL 모드에서는 JSON에 들어온 카드 순서를 절대 변경하지 않습니다.
    //   (StageTool에서 만든 "배치/클리어 순서"를 그대로 사용)
    const cardsMode = ((stage.cards?.mode as any) ?? 'GENERATE') as any;
    const authored = (stage.cards as any)?.authored as any[] | undefined;
    const list = (stage.cards as any)?.list as any[] | undefined;
    const src =
        (Array.isArray(authored) && authored.length > 0 ? authored : undefined) ??
        (Array.isArray(list) && list.length > 0 ? list : undefined);

    const isAuthoredMode = cardsMode === 'AUTHORED' || cardsMode === 'FIXED' || cardsMode === 'MANUAL';
    const preserveAuthoredOrder = isAuthoredMode && !!src;

    {
        if (isAuthoredMode && src) {
            for (let i = 0; i < src.length; i++) {
                const it = src[i] ?? {};
                const rawColor = (it.color ?? it.colorId) as any;
                let colorId = -1;
                if (typeof rawColor === 'number') colorId = rawColor | 0;
                else if (typeof rawColor === 'string') colorId = colorIdFromToken(rawColor, 12);

                // 범위 밖이면 스킵(데이터 오류 방어)
                if (colorId < 0 || colorId >= colorCount) continue;

                const ammo = clamp((it.ammo ?? 0) | 0, AMMO_HARD_MIN, AMMO_HARD_MAX);
                if (ammo <= 0) continue;

                // shotCount가 누락된 authored 데이터가 들어올 수 있어, ammo 기반으로 보정합니다.
                // - 기본 규칙: ammo>=30이면 2총구, 아니면 1총구
                const sc = (it.shotCount ?? undefined) as 1 | 2 | undefined;
                const inferred: 1 | 2 = ammo >= 30 ? 2 : 1;
                const shotCount: 1 | 2 = sc === 1 || sc === 2 ? sc : inferred;

                // ✅ 힌트/표시 전용 필드는 authored에서 그대로 보존합니다.
                const kind = (it.kind ?? undefined) as any;
                const hintStep = (it.hintStep ?? undefined) as any;
                const hintRank = (it.hintRank ?? undefined) as any;

                const cd: any = { colorId, ammo, shotCount };
                if (kind != null) cd.kind = kind;
                if (hintStep != null) cd.hintStep = hintStep | 0;
                if (hintRank != null) cd.hintRank = hintRank | 0;

                cards.push(cd as CardData);
            }

            // AUTHORED/FIXED는 "클리어 보장"을 전제로 하므로 합계 검증을 강제합니다.
            if (cardsMode === 'AUTHORED' || cardsMode === 'FIXED') {
                const sumByColor = new Int32Array(colorCount);
                for (let i = 0; i < cards.length; i++) sumByColor[cards[i].colorId | 0] += cards[i].ammo | 0;
                for (let c = 0; c < colorCount; c++) {
                    const expected = targetAmmoByColor[c] | 0;
                    const got = sumByColor[c] | 0;
                    if (expected !== got) {
                        const delta = expected - got;
                        // ✅ 자동 보정: 해당 색 카드의 마지막 ammo를 delta만큼 조정(음수면 감소)
                        // - 역할: 툴 export가 조금 깨진 데이터라도 게임이 로드/재현 가능하도록 함
                        let fixed = false;
                        for (let i = cards.length - 1; i >= 0; i--) {
                            if ((cards[i].colorId | 0) !== c) continue;
                            const next = (cards[i].ammo | 0) + delta;
                            if (next <= 0) break;
                            cards[i].ammo = next;
                            fixed = true;
                            break;
                        }
                        if (!fixed) {
                            throw new Error(
                                `Stage ${id}: authored ammo mismatch color=${COLOR_TOKEN_ORDER[c] ?? c} expected=${expected} got=${got}`,
                            );
                        }
                    }
                }
            }
        } else {
            // --- 4-2) GENERATE: 색상별 targetAmmo를 카드로 쪼갬(정확합계 + 하드 min/max)
            for (let c = 0; c < colorCount; c++) {
                const total = targetAmmoByColor[c] | 0;
                if (total <= 0) continue;

                // 색마다 RNG를 살짝 분기해 "색별 카드 패턴"이 고정되도록(결정성)
                const rngLocal = mulberry32((seed + 400000 + c * 97) | 0);
                const built = buildCardsForColor(c, total, rngLocal);
                for (let i = 0; i < built.length; i++) cards.push(built[i]);
            }
        }
    }
    // ✅ pickerMaxCards로 "카드 수를 줄이는" 로직은 제거합니다.
    //    (대기라인(cap) 이후 카드는 오버플로(공급 유닛)로 계속 나와야 합니다.)

    // ✅ 슬롯(슈팅라인) 최소 수를 못 채우면 분할로 보정(GENERATE에서만)
    // - AUTHORED/FIXED는 JSON에 의도적으로 만든 순서/분할이 있으므로 변형하지 않습니다.
    if ((stage.cards?.mode as any) == null || stage.cards?.mode === 'GENERATE') {
        ensureMinCardCountSoft(cards, slotCount, ammoStep, AMMO_HARD_MAX);
    }

    // ✅ 1단계 보강: 정확합계 검증(assert)
    // - 역할: 색상별 카드 ammo 총합이 targetAmmoByColor(=histTotal 기반)와 정확히 일치하는지 검증
    // - 목적: 잔탄/부족탄으로 인한 데드락을 컴파일 단계에서 즉시 차단
    {
        const sumByColor = new Int32Array(colorCount);
        for (let i = 0; i < cards.length; i++) {
            const cd = cards[i];
            const c = cd.colorId | 0;
            if (c >= 0 && c < colorCount) sumByColor[c] += cd.ammo | 0;
        }

        let totalGot = 0;
        for (let c = 0; c < colorCount; c++) {
            const expected = targetAmmoByColor[c] | 0;
            const got = sumByColor[c] | 0;
            totalGot += got;
            if (expected !== got) {
                throw new Error(
                    `Stage ${id}: ammo sum mismatch color=${COLOR_TOKEN_ORDER[c] ?? c} expected=${expected} got=${got}`,
                );
            }
        }
        if ((totalAmmoTarget | 0) !== (totalGot | 0)) {
            throw new Error(`Stage ${id}: total ammo mismatch expected=${totalAmmoTarget} got=${totalGot}`);
        }
    }

    // ✅ pickerCols는 절대 무시하지 않습니다(요구사항).
    // - 화면에 보이는 대기칸은 waitLineCount(=3) * pickerCols
    // - 그 외 카드는 overflow로 순차 등장(런타임에서 소비)
    // ✅ 2단계 Lock: meta.pickerCols를 절대 무시하지 않고, 런타임 제약(Place01~05) 내에서만 클램프
    const forcedPickerCols = clamp(Math.max(1, (meta.pickerCols ?? 5) | 0), 1, 5);
    const grid = decidePickerGrid(cards.length, forcedPickerCols);
    if (grid.cols !== forcedPickerCols) {
        // decidePickerGrid가 강제 cols를 바꾸면 안 됨(안전장치)
        (grid as any).cols = forcedPickerCols;
        (grid as any).rows = Math.ceil(cards.length / forcedPickerCols);
    }

    // ✅ 카드(유닛) 순서 설계(요구사항)
    // - 초기 10x10 보드에 존재하는 색(=histInitial>0) → 앞쪽
    // - supply에서만 등장하는 색(=histInitial==0 && histSupply>0) → 뒤쪽
    // - 같은 색 연속 최소화(아래 arrangeCardsNoAdjacentInPlace로 처리)
    if (!preserveAuthoredOrder) {
        {
            const pri = new Int8Array(colorCount);
            for (let c = 0; c < colorCount; c++) {
                const ini = histInitial[c] | 0;
                const sup = histSupply[c] | 0;
                // 0: 초기 포함, 1: 혼합, 2: supply-only
                pri[c] = ini > 0 ? 0 : sup > 0 ? 2 : 1;
            }

            // 안정 정렬 + 할당 최소화(배열 1회)
            cards.sort((a, b) => pri[a.colorId | 0] - pri[b.colorId | 0] || (b.ammo | 0) - (a.ammo | 0));
        }
    }

    // ✅ 같은 색 연속 최소화(시드 기반)
    if (!preserveAuthoredOrder) arrangeCardsNoAdjacentInPlace(cards, colorCount, seed);

    // ✅ 시작 즉시 타격 가능한 색(바닥 row=0) 카드들을 앞쪽으로 당겨 초반 데드락을 줄입니다.
    // - 역할: "어떤 유닛을 먼저 쓰면 되는지" 힌트 산출의 기준이 되는 색 집합을 여기서 확정
    const firstShooterColors: number[] = [];
    {
        const seen = new Int8Array(colorCount);
        for (let x = 0; x < BOARD; x++) {
            const cid = boardTop[0][x] | 0;
            if (cid >= 0 && cid < colorCount && seen[cid] === 0) {
                seen[cid] = 1;
                firstShooterColors.push(cid);
            }
        }

        // ✅ IMPORTANT: 바닥(row=0)에 LARGE(2x2)만 있는 스테이지에서는
        // boardTop[0][x]에 색이 없을 수 있습니다(largeBlocks는 별도 배열).
        // 이 경우 초반 카드 순서가 바닥 색을 반영하지 못해 데드락이 날 수 있으므로
        // row=0에 걸친 LARGE 색도 "시작 즉시 타격 가능한 색"에 포함합니다.
        for (const lb of largeBlocks) {
            if (((lb as any).y | 0) !== 0) continue;
            const cid = ((lb as any).colorId ?? -1) | 0;
            if (cid >= 0 && cid < colorCount && seen[cid] === 0) {
                seen[cid] = 1;
                firstShooterColors.push(cid);
            }
        }
        // 앞쪽 1장씩 우선 노출
        if (!preserveAuthoredOrder) promoteColorsToFrontInPlace(cards, firstShooterColors, 1);
    }

    // ✅ 최소 조건: W1(대기라인 1열)에는 "현재 바닥(row=0)에 존재하는 색" 중 하나가 항상 존재
    // - boardTop은 컴파일 시점의 초기 보드이므로, 바닥 색을 즉시 산출 가능
    // - W1 인덱스: 0, pickerCols, pickerCols*2 (waitLineCount=3 고정 조건)
    if (!preserveAuthoredOrder) {
        {
            const bottom = new Int8Array(colorCount);
            for (let x = 0; x < BOARD; x++) {
                const cid = boardTop[0][x] | 0;
                if (cid >= 0) bottom[cid] = 1;
            }

            // ✅ LARGE(2x2)도 바닥 색 집합에 포함
            for (const lb of largeBlocks) {
                if (((lb as any).y | 0) !== 0) continue;
                const cid = ((lb as any).colorId ?? -1) | 0;
                if (cid >= 0 && cid < colorCount) bottom[cid] = 1;
            }

            const idx0 = 0;
            const idx1 = grid.cols;
            const idx2 = grid.cols * 2;

            const hasBottomColor =
                (cards[idx0] && bottom[cards[idx0].colorId | 0] === 1) ||
                (cards[idx1] && bottom[cards[idx1].colorId | 0] === 1) ||
                (cards[idx2] && bottom[cards[idx2].colorId | 0] === 1);

            if (!hasBottomColor) {
                // 앞쪽에서 바닥 색 카드 하나를 찾아 W1 첫 칸으로 스왑(부작용 최소화)
                let pick = -1;
                for (let i = 0; i < cards.length; i++) {
                    const cid = cards[i].colorId | 0;
                    if (bottom[cid] === 1) {
                        pick = i;
                        break;
                    }
                }
                if (pick > 0) {
                    const tmp = cards[0];
                    cards[0] = cards[pick];
                    cards[pick] = tmp;
                }
            }
        }
    }

    // stacks 최종 압축(레이어별 -1 제거 → stack[])
    // ✅ 역할: 런타임/시뮬레이션 모두 동일한 stacks 표현을 사용하기 위해, 시뮬 전에 확정합니다.
    // - 메모리: stage 로드시 1회 생성(BOARD^2 * 평균 레이어 수). 이후 시뮬은 이 스냅샷을 복사해 사용합니다.
    const boardStacks: number[][][] | undefined =
        enableStacks && stacksTemp
            ? Array.from({ length: BOARD }, (_, y) =>
                  Array.from({ length: BOARD }, (_, x) => {
                      const s: number[] = [];
                      for (let l = 0; l < layerCount; l++) {
                          const v = stacksTemp[y][x][l];
                          if (v >= 0) s.push(v);
                      }
                      return s;
                  }),
              )
            : undefined;


    // ✅ Apply initial LOCK shooters from meta.lockShooterCount (1 KEY unlocks 1 LOCK shooter).
    // - 중요: cap(=waitLineCount * pickerCols) 구간이 전부 LOCK이면 진행이 막힙니다(Stage3 케이스).
    //   그래서 cap 구간은 가능한 한 LOCK을 뒤로 미룹니다.
    const lockShooterCount = Math.max(0, Math.floor((stage.meta as any)?.lockShooterCount ?? 0));
    if (lockShooterCount > 0 && cards.length > 0) {
        const cap = Math.max(0, Math.min(cards.length, (waitLineCount | 0) * (grid.cols | 0)));

        let marked = 0;

        // (1) cap 뒤쪽부터 먼저 LOCK 지정
        for (let i = cap; i < cards.length && marked < lockShooterCount; i++) {
            const d: any = cards[i] as any;
            if (!d || d.kind) continue;
            d.kind = 'LOCK';
            marked++;
        }

        // (2) 부족하면 cap 안에서도 지정(가능하면 첫 칸은 남겨 시작 가능 보장)
        for (let i = 0; i < cap && marked < lockShooterCount; i++) {
            if (cap > 0 && i === 0) continue;
            const d: any = cards[i] as any;
            if (!d || d.kind) continue;
            d.kind = 'LOCK';
            marked++;
        }

        // (3) 그래도 부족하면(비정상 데이터: lockShooterCount >= cards.length) 앞칸까지 포함
        if (marked < lockShooterCount && cap > 0) {
            const d0: any = cards[0] as any;
            if (d0 && !d0.kind) d0.kind = 'LOCK';
        }
    }

    // ✅ 5단계: 시뮬레이션 게이트(보드 룰 반영)
    let simClearActions: string[] | undefined;
    let simClearCardOrder: number[] | undefined;

    // - 역할: 카드 순서가 "대기라인(cap) 안"에서 막히는 구간을 줄이기 위해, 실제 보드 규칙(LOCK/KEY/CHAIN/LARGE/HIDDEN/SPAWNER/STACK)
    //         을 단순화해 반영한 시뮬레이션으로 cards 순서를 자동 조정합니다.
    // - 주의: '유저 입력(중간 교체)'까지 재현하는 오토플레이는 아니며, "1카드=1히트" 모델로 N턴 동안 보드 상태를 전개하며
    //         cap 내에 항상 쏠 색이 존재하도록 정렬을 보정합니다(컴파일 1회, 저비용).
    if (!preserveAuthoredOrder) {
        {
            const waitCap = waitLineCount * grid.cols;
            const SIM_TURNS = 120; // Stage2(HP 큰 스테이지)도 초반 막힘 완화가 목적이므로 120턴으로 확장

            type EntKind = 'SMALL' | 'BIG';
            type Ent = {
                id: number;
                alive: boolean;
                kind: EntKind;
                row: number;
                col: number;
                w: number;
                h: number;
                colorId: number;
                hp: number;
                hpMax: number;
                hidden: boolean;
                special: RuntimeSpecial | null;
                // STACK 셀인 경우: layers (bottom->top), top이 현재 colorId
                stack?: number[];
            };

            const indexOf = (r: number, c: number) => r * BOARD + c;
            const inBounds = (c: number, r: number) => c >= 0 && c < BOARD && r >= 0 && r < BOARD;

            // occ: 각 셀에 점유 엔티티 id(-1=빈칸)
            const occ = new Int32Array(BOARD * BOARD);
            occ.fill(-1);

            // special/hidden/stack은 시뮬 전용 복사본을 사용(원본 변형 방지)
            const specialSim: (RuntimeSpecial | null)[][] = Array.from({ length: BOARD }, (_, r) =>
                Array.from({ length: BOARD }, (_, c) => (special?.[r]?.[c] as any) ?? null),
            );
            const hiddenSim: boolean[][] = Array.from({ length: BOARD }, (_, r) =>
                Array.from({ length: BOARD }, (_, c) => (hiddenMask?.[r]?.[c] as any) === true),
            );

            // STACK 복사(각 셀 배열 복제)
            const stacksSim: number[][][] | null = boardStacks
                ? Array.from({ length: BOARD }, (_, r) =>
                      Array.from({ length: BOARD }, (_, c) => {
                          const s = boardStacks?.[r]?.[c];
                          return Array.isArray(s) ? (s as number[]).slice() : [];
                      }),
                  )
                : null;

            // columnSupply 복사(pop 기반)
            const supplyCopy: number[][] = Array.from({ length: BOARD }, (_, c) => {
                const src = columnSupply?.[c] as any;
                return Array.isArray(src) ? (src as number[]).slice() : [];
            });

            // 엔티티 생성
            const ents: Ent[] = [];
            let nextId = 1;

            // 1) BIG(LARGE) 엔티티
            if (Array.isArray(largeBlocks)) {
                for (let i = 0; i < largeBlocks.length; i++) {
                    const lb = largeBlocks[i] as any;
                    const e: Ent = {
                        id: nextId++,
                        alive: true,
                        kind: 'BIG',
                        row: lb.y | 0,
                        col: lb.x | 0,
                        w: 2,
                        h: 2,
                        colorId: lb.colorId | 0,
                        hp: Math.max(1, lb.hp | 0),
                        hpMax: Math.max(1, (lb.hpMax ?? lb.hp) | 0),
                        hidden: (lb.hidden as any) === true,
                        special: null,
                    };
                    ents.push(e);
                    for (let dy = 0; dy < 2; dy++) {
                        for (let dx = 0; dx < 2; dx++) {
                            const r = e.row + dy;
                            const c = e.col + dx;
                            if (inBounds(c, r)) occ[indexOf(r, c)] = e.id;
                        }
                    }
                }
            }

            // 2) SMALL 엔티티(일반/스택/체인/키/락/스포너)
            for (let r = 0; r < BOARD; r++) {
                for (let c = 0; c < BOARD; c++) {
                    if (occ[indexOf(r, c)] >= 0) continue; // BIG 점유

                    const sp = specialSim[r][c];
                    const isHidden = hiddenSim[r][c] === true;

                    let baseColor = -1;
                    let stackArr: number[] | undefined = undefined;

                    if (stacksSim) {
                        const st = stacksSim[r][c];
                        if (Array.isArray(st) && st.length > 0) {
                            stackArr = st;
                            baseColor = st[st.length - 1] | 0;
                        }
                    } else {
                        baseColor = boardTop[r][c] | 0;
                    }

                    if (baseColor < 0 && !sp) continue;

                    const hp = sp?.t === 'CHAIN' ? Math.max(1, sp.hp | 0) : 1;
                    const e: Ent = {
                        id: nextId++,
                        alive: true,
                        kind: 'SMALL',
                        row: r,
                        col: c,
                        w: 1,
                        h: 1,
                        colorId: baseColor >= 0 ? baseColor : 0,
                        hp,
                        hpMax: hp,
                        hidden: isHidden,
                        special: sp,
                        stack: stackArr,
                    };
                    ents.push(e);
                    occ[indexOf(r, c)] = e.id;
                }
            }

            // id -> ent index (삭제 없이 isAlive로 관리)
            const entIndexById = new Map<number, number>();
            for (let i = 0; i < ents.length; i++) entIndexById.set(ents[i].id, i);

            // LOCK 해제 상태(시뮬 전용)
            const unlocked = new Set<string>();

            const entAt = (r: number, c: number): Ent | null => {
                if (!inBounds(c, r)) return null;
                const idv = occ[indexOf(r, c)];
                if (idv < 0) return null;
                const idx = entIndexById.get(idv);
                if (idx == null) return null;
                const e = ents[idx];
                if (!e.alive) return null;
                return e;
            };

            const isShootableEnt = (e: Ent, colorId: number): boolean => {
                if ((e.colorId | 0) !== (colorId | 0)) return false;
                // HIDDEN은 바닥(row=0)에 도달하기 전까지 발사 대상에서 제외(간단 모델)
                if (e.hidden && e.row > 0) return false;
                // LARGE_HIDDEN도 동일 규칙
                if (e.kind === 'BIG' && e.hidden && e.row > 0) return false;
                const sp = e.special;
                if (sp?.t === 'LOCK' && !unlocked.has(sp.id)) return false;
                return true;
            };

            // 바닥(row=0)에서 colorId로 타격 가능한 컬럼(좌측 우선)
            const findShootableColumn = (colorId: number): number => {
                for (let c = 0; c < BOARD; c++) {
                    const e = entAt(0, c);
                    if (!e) continue;
                    if (isShootableEnt(e, colorId)) return c;
                }
                return -1;
            };

            const rebuildShootableMask = (mask: Int8Array) => {
                mask.fill(0);
                for (let c = 0; c < BOARD; c++) {
                    const e = entAt(0, c);
                    if (!e) continue;
                    // LOCK은 해제 전까지 제외
                    const sp = e.special;
                    if (sp?.t === 'LOCK' && !unlocked.has(sp.id)) continue;
                    if (e.hidden && e.row > 0) continue;
                    if (e.kind === 'BIG' && e.hidden && e.row > 0) continue;
                    const cid = e.colorId | 0;
                    if (cid >= 0 && cid < colorCount) mask[cid] = 1;
                }
            };

            const clearOccForEnt = (e: Ent) => {
                for (let dy = 0; dy < e.h; dy++) {
                    for (let dx = 0; dx < e.w; dx++) {
                        const r = e.row + dy;
                        const c = e.col + dx;
                        if (inBounds(c, r)) {
                            const idx = indexOf(r, c);
                            if (occ[idx] === e.id) occ[idx] = -1;
                            specialSim[r][c] = null;
                            hiddenSim[r][c] = false;
                            if (stacksSim) stacksSim[r][c].length = 0;
                        }
                    }
                }
            };

            const commitOccForEnt = (e: Ent) => {
                for (let dy = 0; dy < e.h; dy++) {
                    for (let dx = 0; dx < e.w; dx++) {
                        const r = e.row + dy;
                        const c = e.col + dx;
                        if (inBounds(c, r)) occ[indexOf(r, c)] = e.id;
                    }
                }
            };

            // 엔티티 1칸 낙하 가능 여부(footprint 전체 아래가 비어야 함)
            const canFallOne = (e: Ent): boolean => {
                if (e.row <= 0) return false;
                for (let dx = 0; dx < e.w; dx++) {
                    const c = e.col + dx;
                    const belowR = e.row - 1;
                    // 아래가 자기 자신 footprint인 경우는 없음(1칸씩만 내리므로)
                    for (let dy = 0; dy < e.h; dy++) {
                        const r = belowR + dy;
                        if (!inBounds(c, r)) return false;
                        const idBelow = occ[indexOf(r, c)];
                        if (idBelow >= 0 && idBelow !== e.id) return false;
                    }
                }
                return true;
            };

            // 중력 정착(최대 10*엔티티 반복)
            const settleGravity = () => {
                let moved = true;
                let guard = 200;
                while (moved && guard-- > 0) {
                    moved = false;
                    // 낮은 것부터 처리하면 BIG/SMALL 모두 안정적
                    for (let i = 0; i < ents.length; i++) {
                        if (!ents[i].alive) continue;
                        const e = ents[i];
                        if (!canFallOne(e)) continue;
                        clearOccForEnt(e);
                        e.row -= 1;
                        commitOccForEnt(e);
                        moved = true;
                    }
                }
            };

            // 공급 채우기: 각 컬럼의 최상단 빈칸을 supply pop으로 채움
            const fillSupply = () => {
                for (let c = 0; c < BOARD; c++) {
                    // 위에서부터 빈칸을 찾아 채움
                    for (let r = BOARD - 1; r >= 0; r--) {
                        if (occ[indexOf(r, c)] >= 0) continue;
                        if (supplyCopy[c].length <= 0) break;

                        const nextColor = supplyCopy[c].pop() as number;
                        const e: Ent = {
                            id: nextId++,
                            alive: true,
                            kind: 'SMALL',
                            row: r,
                            col: c,
                            w: 1,
                            h: 1,
                            colorId: nextColor | 0,
                            hp: 1,
                            hpMax: 1,
                            hidden: false,
                            special: null,
                        };
                        ents.push(e);
                        entIndexById.set(e.id, ents.length - 1);
                        occ[indexOf(r, c)] = e.id;
                    }
                }
            };

            // 히트 처리(1발): 대상 엔티티 hp/stack/special 처리 후 제거, 중력+공급
            const hitAtColumn = (colHit: number): boolean => {
                const e0 = entAt(0, colHit);
                if (!e0) return false;

                // BIG는 두 컬럼 영향을 주지만, 여기서는 단순히 엔티티 hp 감소/제거만 수행
                if (e0.stack && e0.stack.length > 0) {
                    // stack pop
                    e0.stack.pop();
                    if (e0.stack.length > 0) {
                        e0.colorId = e0.stack[e0.stack.length - 1] | 0;
                        return true;
                    }
                    // stack이 끝나면 셀 제거
                }

                e0.hp -= 1;
                if (e0.hp > 0) return true;

                // 파괴 처리
                const sp = e0.special;
                if (sp?.t === 'KEY') {
                    unlocked.add(sp.id);
                } else if (sp?.t === 'SPAWNER') {
                    // 스포너 큐를 해당 컬럼 supply에 주입
                    const q = Array.isArray((sp as any).queue) ? ((sp as any).queue as number[]) : [];
                    if (q.length) {
                        // pop 기반이므로, queue 순서 유지 목적이면 역순 push
                        for (let i = q.length - 1; i >= 0; i--) supplyCopy[colHit].push(q[i] | 0);
                    }
                }

                // 엔티티 제거
                const idx = entIndexById.get(e0.id);
                if (idx != null) ents[idx].alive = false;
                clearOccForEnt(e0);

                // 중력/공급
                settleGravity();
                fillSupply();
                // 낙하 후 hidden이 바닥에 도달하면 reveal
                for (let i = 0; i < ents.length; i++) {
                    if (!ents[i].alive) continue;
                    const e = ents[i];
                    if (e.hidden && e.row === 0) e.hidden = false;
                }
                return true;
            };

            // shootable 마스크
            const shootable = new Int8Array(colorCount);

            // ✅ 슬롯/대기라인 기반 시뮬레이션(교체 포함)
            // - 역할: 실제 플레이처럼 "슈팅라인(slotCount) + 대기라인(cap)"을 고려해,
            //         유닛을 교체/장착하면서 여러 번 발사하는 패턴으로 막힘이 생기지 않게 cards 순서를 보정합니다.
            // - 정책: 오토플레이(정밀 조준/각도/연사 등)는 아니며, "1발=바닥 1히트" 단위로 보드 상태를 전개합니다.
            // - 성능: stage 로드 시 1회 실행. 반복 횟수/로그는 상한을 둡니다.
            const simHintActions: string[] = [];
            const simHintCardOrder: number[] = [];

            const MAX_FIX_ITERS = 20;
            const MAX_LOG_ACTIONS = 40;
            const MAX_SHOTS = Math.min(Math.max(200, totalBlocks * 2), 8000);

            const rebuildShootable = () => rebuildShootableMask(shootable);

            // state 스냅샷/복원(컴파일 1회 내에서 iter 재시작용)
            const makeFreshState = () => {
                const occSnap = occ.slice(0);
                const entsSnap = ents.map((e) => ({
                    ...e,
                    stack: e.stack ? e.stack.slice(0) : undefined,
                    special: e.special ? ({ ...(e.special as any) } as any) : null,
                })) as Ent[];
                const supplySnap = supplyCopy.map((a) => a.slice(0));
                // ✅ 역할: LOCK 해제 상태(키 획득)를 재시뮬레이션(iter)마다 원복하기 위한 스냅샷
                // - 타입: KEY/LOCK id는 string 입니다.
                const unlockedSnap = new Set<string>(unlocked);

                const restore = () => {
                    occ.set(occSnap);
                    ents.length = 0;
                    for (let i = 0; i < entsSnap.length; i++) ents.push(entsSnap[i]);
                    supplyCopy.length = 0;
                    for (let i = 0; i < supplySnap.length; i++) supplyCopy.push(supplySnap[i]);
                    unlocked.clear();
                    unlockedSnap.forEach((v) => unlocked.add(v));
                    entIndexById.clear();
                    for (let i = 0; i < ents.length; i++) entIndexById.set(ents[i].id, i);
                };

                return { restore };
            };

            const pickDesiredShootableColor = (): number => {
                for (let c = 0; c < colorCount; c++) if (shootable[c]) return c;
                return -1;
            };

            const hasShootableCardInVisible = (shooters: Int32Array, wait: Int32Array): boolean => {
                for (let i = 0; i < shooters.length; i++) {
                    const idx = shooters[i] | 0;
                    if (idx < 0) continue;
                    const cid = cards[idx].colorId | 0;
                    if (cid >= 0 && cid < colorCount && shootable[cid]) return true;
                }
                for (let i = 0; i < wait.length; i++) {
                    const idx = wait[i] | 0;
                    if (idx < 0) continue;
                    const cid = cards[idx].colorId | 0;
                    if (cid >= 0 && cid < colorCount && shootable[cid]) return true;
                }
                return false;
            };

            // deckPos 이후에서 desiredColor를 찾아, wait 안의 1장을 교체(=cards 순서 보정)
            const injectDesiredColorIntoWait = (desiredColor: number, deckPos: number, wait: Int32Array): boolean => {
                if (desiredColor < 0) return false;

                let src = -1;
                for (let i = deckPos; i < cards.length; i++) {
                    if ((cards[i].colorId | 0) === desiredColor) {
                        src = i;
                        break;
                    }
                }
                if (src < 0) return false;

                let dst = -1;
                for (let i = 0; i < wait.length; i++) {
                    const wi = wait[i] | 0;
                    if (wi < 0) continue;
                    const cid = cards[wi].colorId | 0;
                    if (!(cid >= 0 && cid < colorCount && shootable[cid])) {
                        dst = wi;
                        break;
                    }
                }
                if (dst < 0) dst = wait.length > 0 ? wait[wait.length - 1] | 0 : -1;
                if (dst < 0) return false;

                const tmp = cards[dst];
                cards[dst] = cards[src];
                cards[src] = tmp;
                return true;
            };

            // ---- FIX LOOP ----
            for (let fixIter = 0; fixIter < MAX_FIX_ITERS; fixIter++) {
                const snap = makeFreshState();
                snap.restore();

                const remAmmo = new Int32Array(cards.length);
                for (let i = 0; i < cards.length; i++) remAmmo[i] = cards[i].ammo | 0;

                const shooters = new Int32Array(slotCount);
                for (let i = 0; i < slotCount; i++) shooters[i] = -1;

                const waitArr: number[] = [];
                let deckPos = 0;

                for (let i = 0; i < slotCount && deckPos < cards.length; i++) shooters[i] = deckPos++;
                while (waitArr.length < waitCap && deckPos < cards.length) waitArr.push(deckPos++);
                const wait = new Int32Array(waitArr);

                const actions: string[] = [];
                const usedCards: number[] = [];

                const log = (msg: string) => {
                    if (actions.length < MAX_LOG_ACTIONS) actions.push(msg);
                };

                const normalizeWait = () => {
                    // ✅ 역할: W1이 비면 W2→W1, W3→W2... 형태로 앞으로 당깁니다.
                    // - 규칙: "장착은 W1에서만 가능"이므로, W1을 항상 최신 카드로 유지하는 컨베이어 동작이 필요합니다.
                    // - 성능: in-place shift (O(wait.length)), 추가 할당 없음
                    for (let i = 0; i < wait.length - 1; i++) {
                        if ((wait[i] | 0) >= 0) continue;
                        let j = i + 1;
                        while (j < wait.length && (wait[j] | 0) < 0) j++;
                        if (j >= wait.length) break;
                        wait[i] = wait[j];
                        wait[j] = -1;
                    }
                };

                const replenishWait = () => {
                    // ✅ 역할: 비어있는 뒤쪽 슬롯부터 deck에서 채웁니다.
                    // - 먼저 normalize로 앞으로 당긴 뒤, 가장 뒤의 빈 칸을 deckPos로 채움
                    normalizeWait();
                    for (let i = 0; i < wait.length && deckPos < cards.length; i++) {
                        if ((wait[i] | 0) >= 0) continue;
                        wait[i] = deckPos++;
                    }
                };

                const equipIntoEmptyShooter = (): boolean => {
                    // ✅ 규칙: "장착은 W1에서만 가능"
                    // - 어떤 슈팅슬롯이 비어있을 때, W1(wait[0])이 존재하면 장착합니다.
                    // - W1이 비어있으면 장착 불가(다른 대기칸에서 직접 장착/교체 금지)
                    let empty = -1;
                    for (let i = 0; i < shooters.length; i++) {
                        if ((shooters[i] | 0) < 0) {
                            empty = i;
                            break;
                        }
                    }
                    if (empty < 0) return false;

                    replenishWait(); // W1이 비어있다면 W2가 앞으로 오도록 보정

                    const w1 = wait.length > 0 ? wait[0] | 0 : -1;
                    if (w1 < 0) return false;

                    shooters[empty] = w1;
                    wait[0] = -1;

                    // 장착 후 컨베이어 진행
                    replenishWait();

                    log(`EQUIP S${empty} <- W1 (card#${w1})`);
                    return true;
                };

                const pickShooterToFire = (): number => {
                    for (let i = 0; i < shooters.length; i++) {
                        const idx = shooters[i] | 0;
                        if (idx < 0) continue;
                        if (remAmmo[idx] <= 0) continue;
                        const cid = cards[idx].colorId | 0;
                        if (cid >= 0 && cid < colorCount && shootable[cid]) return i;
                    }
                    return -1;
                };

                const isCleared = (): boolean => {
                    for (let i = 0; i < ents.length; i++) if (ents[i].alive) return false;
                    for (let c = 0; c < supplyCopy.length; c++) if (supplyCopy[c].length > 0) return false;
                    return true;
                };

                let deadlock = false;
                let deadlockDesiredColor = -1;

                for (let shot = 0; shot < MAX_SHOTS; shot++) {
                    if (isCleared()) break;

                    rebuildShootable();

                    // shooter 빈칸 즉시 채우기(유저 행동 모델)
                    while (equipIntoEmptyShooter()) {
                        // keep equipping until no empty shooter or W1 empty
                    }

                    let sIdx = pickShooterToFire();
                    if (sIdx < 0) {
                        // ✅ 교체(SWAP) 금지: 슈팅슬롯이 비기 전에는 대기 유닛을 끼워 넣을 수 없다는 룰을 시뮬에서도 동일하게 적용
                        deadlock = true;
                        deadlockDesiredColor = pickDesiredShootableColor();
                        log(`DEADLOCK no shootable shooter desired=${deadlockDesiredColor}`);
                        break;
                    }

                    const cardIdx = shooters[sIdx] | 0;
                    if (cardIdx < 0 || remAmmo[cardIdx] <= 0) {
                        shooters[sIdx] = -1;
                        replenishWait();
                        continue;
                    }

                    const useColor = cards[cardIdx].colorId | 0;
                    let hitCol = findShootableColumn(useColor);
                    if (hitCol < 0) {
                        rebuildShootable();
                        hitCol = findShootableColumn(useColor);
                        if (hitCol < 0) {
                            deadlock = true;
                            break;
                        }
                    }

                    hitAtColumn(hitCol);
                    remAmmo[cardIdx] -= 1;

                    if (usedCards.length < 10) {
                        let seen = false;
                        for (let i = 0; i < usedCards.length; i++)
                            if (usedCards[i] === cardIdx) {
                                seen = true;
                                break;
                            }
                        if (!seen) usedCards.push(cardIdx);
                    }

                    log(`FIRE S${sIdx} color=${useColor} card#${cardIdx} rem=${remAmmo[cardIdx]}`);

                    if (remAmmo[cardIdx] <= 0) {
                        shooters[sIdx] = -1;
                        replenishWait();
                    }
                }

                if (!deadlock) {
                    simHintActions.length = 0;
                    for (let i = 0; i < actions.length; i++) simHintActions.push(actions[i]);

                    simHintCardOrder.length = 0;
                    for (let i = 0; i < usedCards.length; i++) simHintCardOrder.push(usedCards[i]);
                    break;
                }
                // ✅ deadlock 보정: SWAP 없이도 진행되려면, '현재 보드에서 쏠 수 있는 색'이 초기 슈터(slotCount) 안에 존재해야 합니다.
                // - 역할: deadlock 시점에 shootable로 판정된 색을 카드 덱 앞(slotCount)으로 끌어옵니다(컴파일 시 카드 순서만 조정)
                // - 주의: 런타임 JSON/보드 데이터는 변경하지 않습니다.
                if (deadlockDesiredColor >= 0) {
                    promoteColorIntoShootersInPlace(cards, deadlockDesiredColor, slotCount);
                }
            }

            // 힌트 카드(최대 4장)를 앞쪽으로 약하게 당김(부작용 최소)
            if (simHintCardOrder.length > 0) {
                for (let k = 0; k < simHintCardOrder.length && k < 4; k++) {
                    const idx = simHintCardOrder[k] | 0;
                    if (idx < 0 || idx >= cards.length) continue;
                    if (idx === k) continue;
                    const tmp = cards[k];
                    cards[k] = cards[idx];
                    cards[idx] = tmp;

                    for (let j = 0; j < simHintCardOrder.length; j++) {
                        const v = simHintCardOrder[j] | 0;
                        if (v === k) simHintCardOrder[j] = idx;
                        else if (v === idx) simHintCardOrder[j] = k;
                    }
                }
            }

            // simHintActions/simHintCardOrder는 아래 clearHint로 전달됩니다.
        }
    }

    // ✅ 클리어 힌트(표시용) 부여
    // - 요구: ★/• 대신 "순차 번호"(1,2,3,...)를 카드에 부여
    // - 규칙: stage.equipOrder가 있으면 그 순서를 우선 사용(덱에서 순서대로 매칭).
    //         없으면 시뮬 기반(simClearCardOrder) 상위 순서를 사용.
    const equipOrder = (stage as any)?.equipOrder as string[] | undefined;
    const clearHintCardOrder: number[] = [];

    if (Array.isArray(equipOrder) && equipOrder.length > 0) {
        const used = new Set<number>();
        for (let k = 0; k < equipOrder.length; k++) {
            const want = String(equipOrder[k] ?? '').trim();
            if (!want) continue;
            let found = -1;
            for (let i = 0; i < cards.length; i++) {
                if (used.has(i)) continue;
                const cd = cards[i];
                // equipOrder는 "R2" 같은 표기이므로, 카드 쪽도 shotCount 누락 시 ammo로 추론해서 매칭합니다.
                const sc = (cd.shotCount ?? (cd.ammo >= 30 ? 2 : 1)) === 2 ? 2 : 1;
                const token = `${COLOR_TOKEN_ORDER[cd.colorId] ?? cd.colorId}${sc}`;
                if (token === want) {
                    found = i;
                    break;
                }
            }
            if (found >= 0) {
                used.add(found);
                clearHintCardOrder.push(found);
            }
        }
    } else if (simClearCardOrder && simClearCardOrder.length > 0) {
        for (let i = 0; i < simClearCardOrder.length && i < 10; i++) clearHintCardOrder.push(simClearCardOrder[i] | 0);
    } else {
        for (let i = 0; i < cards.length && i < 10; i++) clearHintCardOrder.push(i);
    }

    // ✅ "클리어 가능한 장착 순서"를 모든 유닛(전체 덱)에 부여합니다.
    // - stage-tool Export가 authored 순서를 이미 "클리어 가능한 순서"로 만들어 내보내므로,
    //   게임은 최종 cards 배열 순서대로 1..N 순번을 부여해 라벨에 표시합니다.
    // - 이렇게 하면 시작 슬롯뿐 아니라, 이후 공급되는 모든 유닛에도 순번이 표시됩니다.
    if (preserveAuthoredOrder) {
        // ✅ AUTHORED/FIXED/MANUAL에서는 StageTool이 부여한 힌트(순번/우선도)를 그대로 사용합니다.
        // - 단, hintStep이 아예 없는 경우에만 fallback으로 1..N을 부여합니다.
        let hasHint = false;
        for (let i = 0; i < cards.length; i++) {
            const d: any = cards[i];
            const v = (d?.hintStep ?? 0) | 0;
            if (v > 0) {
                hasHint = true;
                break;
            }
        }
        if (!hasHint) {
            for (let i = 0; i < cards.length; i++) {
                const d: any = cards[i];
                d.hintStep = i + 1;
            }
        }
    } else {
        // ✅ GENERATE 등 컴파일러가 카드 순서를 설계하는 경우: 현재 cards 배열 순서대로 1..N 순번 부여
        for (let i = 0; i < cards.length; i++) {
            const d: any = cards[i];
            delete d.hintRank;
            d.hintStep = i + 1;
        }
    }

    // (디버그) 필요 시 카드/탄 분배 로그를 켜세요.
    // try { console.log(`[StageCompiler] stage=${id} cards=${cards.length} totalAmmo=${totalAmmoTarget} step=${ammoStep} cols=${grid.cols}`); } catch {}

    // boardStacks는 시뮬 전에 이미 확정(const)했습니다.

    return {
        id,
        slotCount,
        waitLineCount,
        paletteHex,
        board: boardTop,
        hiddenMask,
        special,
        largeBlocks: largeBlocks.length ? largeBlocks : undefined,
        largeMask,
        boardStacks,
        columnSupply,
        spawnerBoxes: spawnerBoxes.length ? spawnerBoxes : undefined,
        pillars: pillars.length ? pillars : undefined,
        supplyLargeDefs: supplyLargeDefs.length ? (supplyLargeDefs as any) : undefined,
        // // totalBlocks = blockCount(+스포너 생성물 케이스) + 체인 추가 히트
        totalBlocks,
        clearHint: { firstShooterColors, cardOrder: clearHintCardOrder, actions: simClearActions },
        cards,
        pickerCols: grid.cols,
        pickerRows: grid.rows,
    };
}
