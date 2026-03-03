import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useStageTool } from './store';
import { COLOR12, COLOR_LABEL, type BoardObject, type BoardObjectType, type Color12 } from './lib/schema';
import { buildOcc, buildStackCount, calcInitialBlocks, uidAt } from './lib/board';
import { cellsOf, objLayer } from './lib/board';
import { validateStage } from './lib/validate';
import { loadSavedPackText, savePackText, clearSaved } from './lib/storage';
import { simulateStageReplay, type SimReplayResult, type ReplayDetail } from './lib/sim_replay';
import { repairStageUntilReplaySolved } from './lib/replay_repair';
import { PATTERNS_10x10, type PatternKey, getPatternRows } from './lib/patterns10x10';
import { generateRandomStage, type RandomStageGenCfg } from './lib/randomStageGenerator';

const COLOR_HEX: Record<Color12, string> = {
  R: '#ff3b30', // 빨강
  O: '#ff9f0a', // 주황
  Y: '#ffd60a', // 노랑
  G: '#34c759', // 초록
  B: '#0a84ff', // 파랑
  P: '#bf5af2', // 보라
  M: '#ff2d55', // 분홍
  C: '#64d2ff', // 하늘
  S: '#5e5ce6', // 파스텔파랑
  L: '#9ef5a8', // 연녹
  K: '#1c1c1e', // 검정
  // 하양은 보드 배경(#f9fafb)과 겹쳐 안 보일 수 있어, 약간 회색 톤을 사용합니다.
  W: '#e5e7eb', // 하양
};

// 특수 오브젝트(기둥/히든/체인/열쇠/박스)는 팔레트 11종 색상과 구분되도록 고유 색상을 사용합니다.
// 역할: 한 눈에 구분되게 해서 편집 실수를 줄입니다.
const SPECIAL_HEX: Partial<Record<BoardObjectType, string>> = {
  PILLAR: '#8e44ad',
  BLOCK_HIDDEN: '#7f8c8d',
  BLOCK_LARGE_HIDDEN: '#7f8c8d',
  KEY: '#f1c40f',
  // ✅ CHAIN_BARRIER / SPAWNER_BOX 는 색상(2색)을 표현해야 하므로 단색 지정하지 않습니다.
};

function getCellBgHex(obj: BoardObject | null, cellX?: number, cellY?: number): string {
  if (!obj) return '#f9fafb';

  // ✅ 생성박스: 좌/우 고정색을 2열로 표현
  if (obj.type === 'SPAWNER_BOX' && typeof cellX === 'number') {
    const pool = Array.isArray((obj as any).spawn?.poolColors) ? ((obj as any).spawn.poolColors as any[]) : [];
    const left = ((pool[0] ?? 'R') as any) as Color12;
    const right = (((pool[1] ?? pool[0] ?? 'R') as any) as Color12) ?? left;
    const use = cellX <= (obj.x | 0) ? left : right;
    return COLOR_HEX[use] ?? '#111827';
  }

  const special = SPECIAL_HEX[obj.type];
  if (special) return special;

  if (
    obj.type === 'BLOCK_NORMAL' ||
    obj.type === 'BLOCK_LARGE' ||
    obj.type === 'BLOCK_HIDDEN' ||
    obj.type === 'BLOCK_LARGE_HIDDEN' ||
    obj.type === 'CHAIN_BARRIER'
  ) {
    // 색상을 가지는 블록류(히든 포함)는 동일한 팔레트로 칠합니다.
    // 역할: color가 런타임에서는 string일 수 있어도, 팔레트 키(Color12)로 안전하게 캐스팅해서 인덱싱합니다.
    const c = (obj as any).color as Color12;
    return COLOR_HEX[c] ?? '#111827';
  }

  // 기타(LOCK 등)
  return '#111827';
}

// UI에서 선택 가능한 색상 목록(총 12종). readonly 튜플(COLOR12)을 그대로 사용합니다.
const COLOR_UI: readonly Color12[] = COLOR12;

function isLightHex(hex: string) {
  const h = hex.replace('#', '');
  if (h.length !== 6) return false;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  // perceived luminance
  const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return l > 180;
}

const BRUSHES: Array<{ type: BoardObjectType; label: string }> = [
  { type: 'BLOCK_NORMAL', label: '일반 블록(1x1)' },
  { type: 'BLOCK_LARGE', label: '라지 블록(2x2)' },
  { type: 'BLOCK_LARGE_HIDDEN', label: '라지 히든 블록(2x2)' },
  { type: 'BLOCK_HIDDEN', label: '히든 블록(1x1)' },
  { type: 'CHAIN_BARRIER', label: '체인 블럭(1xN, 2~10)' },
  { type: 'PILLAR', label: '기둥' },
  { type: 'KEY', label: '열쇠' },
  { type: 'SPAWNER_BOX', label: '생성 박스' },
];

const SUPPLY_ALLOWED_BRUSHES = new Set<BoardObjectType>(['BLOCK_NORMAL', 'BLOCK_LARGE', 'BLOCK_LARGE_HIDDEN', 'BLOCK_HIDDEN']);

function isBrushAllowedForTarget(targetKind: 'INITIAL' | 'SUPPLY', b: BoardObjectType): boolean {
  if (targetKind !== 'SUPPLY') return true;
  return SUPPLY_ALLOWED_BRUSHES.has(b);
}

function downloadText(filename: string, text: string) {
  const blob = new Blob([text], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export default function App() {
  const pack = useStageTool((s) => s.pack);
  const currentStageId = useStageTool((s) => s.currentStageId);
  const currentLayer = useStageTool((s) => s.currentLayer);
  const lastSavedAt = useStageTool((s) => s.lastSavedAt);

  const editTarget = useStageTool((s) => s.editTarget);
  const setEditTarget = useStageTool((s) => s.setEditTarget);

  const visibleBrushes = useMemo(() => BRUSHES.filter((b) => isBrushAllowedForTarget(editTarget.kind, b.type)), [editTarget.kind]);

  const loadFromText = useStageTool((s) => s.loadFromText);
  const resetToDefault = useStageTool((s) => s.resetToDefault);

  const selectStage = useStageTool((s) => s.selectStage);
  const addStageAfter = useStageTool((s) => s.addStageAfter);
  const duplicateStage = useStageTool((s) => s.duplicateStage);
  const deleteStage = useStageTool((s) => s.deleteStage);
  const replaceCurrentStage = useStageTool((s) => s.replaceCurrentStage);

  const toolMode = useStageTool((s) => s.toolMode);
  const setToolMode = useStageTool((s) => s.setToolMode);
  const brush = useStageTool((s) => s.brush);
  const setBrush = useStageTool((s) => s.setBrush);
  const color = useStageTool((s) => s.color);
  const setColor = useStageTool((s) => s.setColor);

  const brushConfig = useStageTool((s) => s.brushConfig);
  const setBrushConfig = useStageTool((s) => s.setBrushConfig);

  const setCurrentLayer = useStageTool((s) => s.setCurrentLayer);
  const fillLayerWithColor = useStageTool((s) => s.fillLayerWithColor);
  const clearCurrentLayer = useStageTool((s) => s.clearCurrentLayer);
  const clearCurrentPage = useStageTool((s) => s.clearCurrentPage);
  const randomDecorateCurrentLayer = useStageTool((s) => s.randomDecorateCurrentLayer);

  // ✅ 공급 페이지 편집(초기/공급 보드 전환)
  // - v39에서 UI를 단순화하며 숨겼지만, 실제 스테이지 제작에는 공급 보드가 필수라 다시 노출합니다.
  const addSupplyPage = useStageTool((s) => s.addSupplyPage);
  const removeSupplyPage = useStageTool((s) => s.removeSupplyPage);

  const setMeta = useStageTool((s) => s.setMeta);
  const numDraft = useStageTool((s) => s.numDraft);
  // (공급/해석 "분석" 패널은 제거한 채로, 공급 보드 편집 UI만 제공)

  const clickCell = useStageTool((s) => s.clickCell);
  const applyCells = useStageTool((s) => s.applyCells);
  const pasteObjects = useStageTool((s) => s.pasteObjects);
  const undo = useStageTool((s) => s.undo);
  const redo = useStageTool((s) => s.redo);
  const undoDepth = useStageTool((s) => s.undoDepth);
  const redoDepth = useStageTool((s) => s.redoDepth);
  const selectedUid = useStageTool((s) => s.selectedUid);
  const setSelectedUid = useStageTool((s) => s.setSelectedUid);
  const pillarLineStart = useStageTool((s) => s.pillarLineStart);
  const chainLineStart = useStageTool((s) => s.chainLineStart);
  const cancelChainLine = useStageTool((s) => s.cancelChainLine);
  const updateSelectedObject = useStageTool((s) => s.updateSelectedObject);
  const bulkUpdateObjects = useStageTool((s) => s.bulkUpdateObjects);
  const getPackJson = useStageTool((s) => s.getPackJson);
  const markSaved = useStageTool((s) => s.markSaved);

  const stage = useMemo(() => pack.stages.find((st) => st.id === currentStageId) ?? pack.stages[0], [pack, currentStageId]);

  // ✅ 스테이지/편집보드 변경 시 선택 상태는 초기화
  // - 다른 보드/페이지로 넘어가면 uid가 달라질 수 있어, 기존 선택이 남아있으면 오작동하기 쉬움
  useEffect(() => {
    setSelRect(null);
    setSelGhost(null);
    setMultiSelUids(new Set());
    setSelectedUid(null);
  }, [currentStageId, editTarget.kind, editTarget.index]);

  // ---- 보드 크기(고정) ----
  // 역할: 화면/패널 크기에 따라 보드가 줄었다 커졌다 하지 않도록 고정 크기를 사용합니다.
  // - UX: 매번 크기가 바뀌면 드래그/정밀 편집이 어려워집니다.
  const boardAreaRef = useRef<HTMLDivElement | null>(null);
  // 셀 크기(px)
  // 역할: 보드가 너무 작아 보이지 않게 기본 크기를 키워둡니다.
  // 보드 셀 크기(px). 화면 자동 리사이즈로 변하는 방식은 UX가 불안정해서 고정값으로 유지
  const [cellPx] = useState(76);

  // ✅ 테마 토글(라이트/다크) 기능은 제거했습니다.
  // - 사용자 요청: 라이트/블랙 버튼 제거
  // - 항상 라이트 테마로 고정

  // ---- 저장 레이어(슬롯 10개) ----
  type SavedLayerSlot = {
    layer: number;
    objects: BoardObject[]; // 절대 좌표(10x10), uid 포함
    savedAt: number;
  } | null;
  const SAVED_LAYER_SLOTS = 10;
  const [savedLayers, setSavedLayers] = useState<SavedLayerSlot[]>(() => {
    try {
      const raw = localStorage.getItem('stageTool.savedLayers.v1');
      if (!raw) return Array.from({ length: SAVED_LAYER_SLOTS }, () => null);
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return Array.from({ length: SAVED_LAYER_SLOTS }, () => null);
      const out: SavedLayerSlot[] = Array.from({ length: SAVED_LAYER_SLOTS }, () => null);
      for (let i = 0; i < Math.min(SAVED_LAYER_SLOTS, parsed.length); i++) {
        const it = parsed[i];
        if (!it || !Array.isArray(it.objects)) continue;
        out[i] = { layer: Number(it.layer ?? 0), objects: it.objects, savedAt: Number(it.savedAt ?? Date.now()) };
      }
      return out;
    } catch {
      return Array.from({ length: SAVED_LAYER_SLOTS }, () => null);
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem('stageTool.savedLayers.v1', JSON.stringify(savedLayers));
    } catch {}
  }, [savedLayers]);

  const [layerSlotOpen, setLayerSlotOpen] = useState<number | null>(null);
  // === 편의 기능 상태 (하이라이트/미리보기 등) ===
  const [issueHighlightMode, setIssueHighlightMode] = useState(true);

  // ✅ 다중 선택(사각형 선택) 일괄 편집용
  const [bulkHp, setBulkHp] = useState<number>(80);
  const [bulkHpDraft, setBulkHpDraft] = useState<string>('80');
  // ✅ 오른쪽 패널 아코디언(선택/검증)
  // 역할: 선택/검증 영역을 접을 수 있게 하되, 높이는 고정해 지진 현상을 막습니다.
  const [accSelectedOpen, setAccSelectedOpen] = useState(true);
  const [accIssuesOpen, setAccIssuesOpen] = useState(true);
  const [focusIssueAt, setFocusIssueAt] = useState<{ x: number; y: number; t: number } | null>(null);
  const [paintFlash, setPaintFlash] = useState<{ set: Set<string>; t: number } | null>(null);
  const [rectPreview, setRectPreview] = useState<{ x0: number; y0: number; x1: number; y1: number; mode: 'PAINT' | 'ERASE' } | null>(null);
  const [hoverCell, setHoverCell] = useState<{ x: number; y: number } | null>(null);

  // ✅ Ctrl(또는 Cmd)+클릭 다중 선택(비사각형 선택)
  const [multiSelUids, setMultiSelUids] = useState<Set<string>>(() => new Set());

  // ✅ 선택영역(복사/붙여넣기)
  // 역할: SELECT 모드에서 드래그로 영역을 잡고 Ctrl+C/Ctrl+V를 제공합니다.
  const [selRect, setSelRect] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const selRef = useRef<{ active: boolean; start: { x: number; y: number } | null; end: { x: number; y: number } | null; moved: boolean }>({
    active: false,
    start: null,
    end: null,
    moved: false,
  });
  // ✅ 선택영역 드래그-복사(스탬프)
  // 역할: 선택영역 안에서 드래그하면, 원본은 그대로 두고 복제본을 새 위치에 붙여넣습니다.
  const selDragRef = useRef<{ active: boolean; grab: { x: number; y: number } | null; offset: { dx: number; dy: number } }>(
    { active: false, grab: null, offset: { dx: 0, dy: 0 } }
  );
  const [selGhost, setSelGhost] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [clipboard, setClipboard] = useState<{ relObjects: BoardObject[]; w: number; h: number } | null>(null);
  // ✅ 붙여넣기 기준점(SELECT 모드에서 셀 클릭으로 지정)
  // 역할: Ctrl+V 시 마우스 호버 대신, 사용자가 지정한 기준점부터 붙여넣을 수 있게 합니다.
  const [pasteAnchor, setPasteAnchor] = useState<{ x: number; y: number } | null>(null);
  // ✅ 드래그로 찍힌 셀 표시(그리기/지우기)
  // 역할: 드래그 중 어디가 적용됐는지 시각적으로 확인할 수 있게 합니다.
  const [dragMark, setDragMark] = useState<Set<string> | null>(null);

  // ✅ SELECT 이외 모드에서는 붙여넣기 기준점 숨김
  useEffect(() => {
    if (toolMode !== 'SELECT') setPasteAnchor(null);
  }, [toolMode]);

  // ✅ 툴 모드 전환 시: 이전 드래그/클릭 상태 초기화
  // 역할: 모드가 바뀌었는데 이전 선택/드래그가 남아있으면 UX가 꼬이므로 항상 초기화합니다.
  useEffect(() => {
    // 선택/복사 상태
    setSelRect(null);
    setSelGhost(null);
    selRef.current = { active: false, start: null, end: null, moved: false };
    selDragRef.current = { active: false, grab: null, offset: { dx: 0, dy: 0 } };

    // 드래그/미리보기 상태
    setRectPreview(null);
    setDragMark(null);
    setPaintFlash(null);
    setFocusIssueAt(null);

    // 기둥 라인 시작점은 store의 setToolMode에서 함께 초기화됩니다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toolMode]);

  // ---- Auto load (localStorage) ----
  useEffect(() => {
    const saved = loadSavedPackText();
    if (saved) {
      try {
        loadFromText(saved);
      } catch {
        // ignore
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- Auto save (localStorage, debounced) ----
  const saveTimer = useRef<number | null>(null);
  useEffect(() => {
    const text = getPackJson();
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      savePackText(text);
      markSaved(Date.now());
    }, 250);
    return () => {
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
    };
  }, [pack, getPackJson, markSaved]);

  // ---- Undo/Redo 단축키 ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const ctrl = e.ctrlKey || (e as any).metaKey;
      if (!ctrl) return;
      const key = e.key.toLowerCase();
      if (key === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if (key === 'y') {
        e.preventDefault();
        redo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo]);

  // ---- 단축키: 숫자(브러시), ESC(선택모드) ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // 입력 중엔 방해하지 않기
      const el = document.activeElement as HTMLElement | null;
      const tag = (el?.tagName ?? '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;

      if (e.key === 'Escape') {
        e.preventDefault();
        setToolMode('SELECT');
        setSelectedUid(null);
        return;
      }

      // Q: 그리기/지우기/선택 툴 순환
      if (e.key.toLowerCase() === 'q') {
        e.preventDefault();
        const next = toolMode === 'PAINT' ? 'ERASE' : toolMode === 'ERASE' ? 'SELECT' : 'PAINT';
        setToolMode(next);
        setSelectedUid(null);
        return;
      }

      // 1~9: 브러시 빠른 전환(보드 브러시만)
      const n = Number(e.key);
      if (Number.isFinite(n) && n >= 1 && n <= BRUSHES.length) {
        e.preventDefault();
        setToolMode('PAINT');
        const next = visibleBrushes[n - 1];
        if (next) setBrush(next.type as any);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toolMode, setToolMode, setBrush, setSelectedUid]);

  // derived: initial/supply/total
  const initialBlocks = useMemo(() => calcInitialBlocks(stage.board.objects, 10, 10), [stage.board.objects]);
  const totalBlocks = Math.max(0, Math.floor(stage.meta.blockCount || 0)); // 사용자가 설정한 목표
  const supplyTotal = Math.max(0, totalBlocks - initialBlocks);

  // ✅ 디버그 로그: "처음부터 아무 것도 안 나오는" 류 문제를 빠르게 잡기 위한 요약
  useEffect(() => {
    try {
      console.log('[StageTool] stage summary', {
        id: stage.id,
        editTarget,
        initialBlocks,
        totalBlocks,
        supplyTotal,
        supplyPages: stage.supply?.pages?.length ?? 0,
        cardsMode: (stage as any)?.cards?.mode,
      });
    } catch {}
  }, [stage.id, editTarget, initialBlocks, totalBlocks, supplyTotal]);

  // supply 페이지(= 다음 10x10 패턴). 각 페이지는 “실제 배치된 블록 수(라지 HP 포함)”로 카운트합니다.
  const supplyPages = stage.supply?.pages ?? [];
  const supplyAdded = supplyPages.length > 0;
  const hasAnySupplyPage = supplyPages.length > 0;
  const supplyPageBlocks = useMemo(() => {
    // ✅ 역할: 공급 페이지의 "블록 수"를 계산합니다.
    // - 공급 페이지(objects)가 비어있을 수 있습니다.
    //   이 경우 공급이 "없는" 것이 아니라, 기획 의도대로 "직전 패턴(초기/이전 공급)을 상속"합니다.
    const raw = supplyPages.map((p) => calcInitialBlocks((p.objects ?? []) as any, 10, 10));
    let last = Math.max(0, Math.floor(initialBlocks));
    return raw.map((v) => {
      const b = Math.max(0, Math.floor(v ?? 0));
      if (b > 0) {
        last = b;
        return b;
      }
      return last; // inherit
    });
  }, [supplyPages, initialBlocks]);
  
const activeSupplyPages = useMemo(() => {
  // ✅ 역할: supplyTotal을 만족시키기 위해 필요한 “공급 타임라인 페이지 수”를 계산합니다.
  // 규칙:
  // - supplyPages가 0장: 초기 패턴만 반복
  // - supplyPages가 1장 이상: [초기, 공급1, 공급2, ...] 순서로 순차 반복(라운드 로빈)
  if (supplyTotal <= 0) return 0;

  const CAP = 50;
  const seqBlocks = supplyPages.length > 0 ? [initialBlocks, ...supplyPageBlocks] : [initialBlocks];
  const seqLen = Math.max(1, seqBlocks.length);

  if (!seqBlocks.some((v) => (v || 0) > 0)) return 0;

  let sum = 0;
  let pages = 0;

  for (let i = 0; i < CAP && sum < supplyTotal; i++) {
    const b = Math.max(0, Math.floor(seqBlocks[i % seqLen] ?? 0));
    if (b <= 0) continue;
    sum += b;
    pages++;
  }

  return pages;
}, [supplyTotal, supplyPageBlocks, initialBlocks, supplyPages.length]);

const activeSupplySum = useMemo(() => {
  if (activeSupplyPages <= 0) return 0;

  const CAP = 50;
  const seqBlocks = supplyPages.length > 0 ? [initialBlocks, ...supplyPageBlocks] : [initialBlocks];
  const seqLen = Math.max(1, seqBlocks.length);

  let sum = 0;
  let pages = 0;

  for (let i = 0; i < CAP && pages < activeSupplyPages; i++) {
    const b = Math.max(0, Math.floor(seqBlocks[i % seqLen] ?? 0));
    if (b <= 0) continue;
    sum += b;
    pages++;
  }

  return sum;
}, [supplyPageBlocks, activeSupplyPages, initialBlocks, supplyPages.length]);

  const supplyMismatch = supplyTotal > 0 && activeSupplySum !== supplyTotal;

  // ✅ 현황판(현재/목표)
  // 역할:
  // - "현재"는 '초기 보드(board.objects)에 실제로 찍힌 블럭'만 의미합니다.
  // - 공급(supply)은 '런타임에서 순차 반복 해석'될 수 있지만, 사용자 입장에서는
  //   공급을 찍지 않았는데 "목표 달성"으로 보이는 UX가 혼란을 줄 수 있어 현재 합산에 포함하지 않습니다.
  const designedTotal = initialBlocks;
  const remainToGoal = Math.max(0, totalBlocks - designedTotal);

  const layerCount = Math.max(1, Math.min(5, Math.floor(stage.meta.layerCount ?? 1)));
  
  const targetObjects: BoardObject[] = useMemo(() => {
    // ✅ 편집 대상: INITIAL(초기 보드) / SUPPLY(공급 페이지)
    // - supply.pages가 0장이어도 editTarget이 SUPPLY면 "빈 페이지"로 편집을 시작할 수 있습니다.
    if (editTarget.kind === 'INITIAL') return stage.board.objects as any;

    const pages = stage.supply?.pages ?? [];
    if (pages.length <= 0) return [] as any;

    const i = Math.max(0, Math.min(pages.length - 1, Math.floor((editTarget as any).index ?? 0)));
    return (pages[i]?.objects ?? []) as any;
  }, [stage.board.objects, stage.supply?.pages, editTarget]);

  // ---- 레이어 저장 ----
  // 역할: 현재 보고 있는 페이지의 "현재 레이어"만 슬롯(1~10)에 저장합니다.
  const saveCurrentLayerToSlot = (slotIndex: number) => {
    const i = Math.max(0, Math.min(SAVED_LAYER_SLOTS - 1, slotIndex));
    const layerObjs = targetObjects
      .filter((o) => objLayer(o) === currentLayer)
      .map((o) => {
        try {
          return (globalThis as any).structuredClone ? (globalThis as any).structuredClone(o) : JSON.parse(JSON.stringify(o));
        } catch {
          return { ...(o as any) };
        }
      }) as BoardObject[];
    setSavedLayers((prev) => {
      const next = prev.slice();
      next[i] = { layer: currentLayer, objects: layerObjs, savedAt: Date.now() };
      return next;
    });
  };

  const saveCurrentLayerAuto = () => {
    // 1) 빈 슬롯 우선
    const empty = savedLayers.findIndex((s) => !s);
    saveCurrentLayerToSlot(empty >= 0 ? empty : 0);
  };

  const setClipboardFromSavedLayer = (slotIndex: number) => {
    const slot = savedLayers[slotIndex] ?? null;
    if (!slot) return;
    const objs = slot.objects ?? [];
    if (objs.length === 0) {
      setClipboard({ relObjects: [], w: 0, h: 0 });
      return;
    }
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const o of objs) {
      const cells = cellsOf(o);
      for (const c of cells) {
        minX = Math.min(minX, c.x);
        minY = Math.min(minY, c.y);
        maxX = Math.max(maxX, c.x);
        maxY = Math.max(maxY, c.y);
      }
    }
    const relObjects: BoardObject[] = objs.map((o) => {
      let no: any;
      try {
        no = (globalThis as any).structuredClone ? (globalThis as any).structuredClone(o) : JSON.parse(JSON.stringify(o));
      } catch {
        no = { ...(o as any) };
      }
      no.x = Math.floor(no.x ?? 0) - minX;
      no.y = Math.floor(no.y ?? 0) - minY;
      return no as BoardObject;
    });
    setClipboard({ relObjects, w: maxX - minX + 1, h: maxY - minY + 1 });
  };

// ---- 선택영역 복사/붙여넣기: Ctrl+C / Ctrl+V ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const ctrl = e.ctrlKey || (e as any).metaKey;
      if (!ctrl) return;

      // ✅ 선택 도구에서만 복사/붙여넣기 허용
      // 역할: 실수로 페인트 중에 Ctrl+C/V가 먹히는 것을 방지합니다.
      if (toolMode !== 'SELECT') return;
      // 입력 중엔 방해하지 않기
      const el = document.activeElement as HTMLElement | null;
      const tag = (el?.tagName ?? '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;

      const key = e.key.toLowerCase();
      if (key === 'c') {
        if (!selRect) return;
        e.preventDefault();

        const x0 = selRect.x0;
        const y0 = selRect.y0;
        const x1 = selRect.x1;
        const y1 = selRect.y1;

        const within = (x: number, y: number) => x >= x0 && x <= x1 && y >= y0 && y <= y1;

        const safeClone = (o: any) => {
          try {
            return (globalThis as any).structuredClone ? (globalThis as any).structuredClone(o) : JSON.parse(JSON.stringify(o));
          } catch {
            return { ...o };
          }
        };

        // ✅ 현재 레이어 오브젝트 중 "완전히" 선택영역에 포함되는 것만 복사
        const relObjects: BoardObject[] = [];
        for (const o of targetObjects) {
          if (objLayer(o) !== currentLayer) continue;
          const cells = cellsOf(o);
          if (cells.some((c) => !within(c.x, c.y))) continue;
          const no: any = safeClone(o as any);
          no.x = Math.floor(no.x ?? 0) - x0;
          no.y = Math.floor(no.y ?? 0) - y0;
          // uid는 붙여넣기에서 새로 발급
          relObjects.push(no as BoardObject);
        }

        setClipboard({ relObjects, w: x1 - x0 + 1, h: y1 - y0 + 1 });
        return;
      }
      if (key === 'v') {
        if (!clipboard || clipboard.relObjects.length === 0) return;
        e.preventDefault();

        // ✅ 붙여넣기 기준점 우선순위
        // 1) 사용자가 클릭으로 지정한 pasteAnchor
        // 2) 현재 마우스 호버 셀
        // 3) 선택영역 좌하단
        const anchor = pasteAnchor ?? hoverCell ?? (selRect ? { x: selRect.x0, y: selRect.y0 } : { x: 0, y: 0 });
        pasteObjects(anchor, clipboard.relObjects);
        setPasteAnchor(anchor);
        // 붙여넣기 직후 어디 찍혔는지 플래시
        const cells: Array<{ x: number; y: number }> = [];
        for (const o of clipboard.relObjects) {
          const ax = Math.floor((o as any).x ?? 0) + anchor.x;
          const ay = Math.floor((o as any).y ?? 0) + anchor.y;
          // 임시 오브젝트로 cellsOf 계산
          const tmp: any = { ...(o as any), x: ax, y: ay };
          for (const c of cellsOf(tmp as any)) cells.push(c);
        }
        flashCells(cells);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toolMode, selRect, clipboard, targetObjects, currentLayer, hoverCell, pasteAnchor, pasteObjects]);

  // ✅ v40: 공급 보드 편집을 다시 허용합니다.

  const { occ } = useMemo(() => buildOcc(targetObjects, 10, 10), [targetObjects]);
  const stackCount = useMemo(() => buildStackCount(targetObjects, 10, 10), [targetObjects]);
  const objByUid = useMemo(() => {
    const m = new Map<string, BoardObject>();
    for (const o of targetObjects) m.set(o.uid, o);
    return m;
  }, [targetObjects]);

  // ✅ 체인 블럭(=CHAIN_BARRIER) 묶음/머리/꼬리 표시
  // - 런타임 규칙: chainId(또는 chainGroupId)가 같을 때만 같은 체인입니다.
  // - chainId가 없으면 런타임(StageCompiler)과 동일하게 "셀 단위"로 독립 체인으로 취급합니다.
  // - 머리/꼬리: chainOrder가 있으면 order 기준, 없으면 uid timestamp 기준
  const chainGroups = useMemo(() => {
    const groupOf = new Map<string, string>(); // key "x,y" -> chainId
    const headCells = new Set<string>();
    const tailCells = new Set<string>();
    const groupSize = new Map<string, number>();

    const uidTime = (uid: string): number => {
      // uid() 구현: `${prefix}_${random}_${Date.now().toString(36)}`
      const parts = String(uid ?? '').split('_');
      const last = parts[parts.length - 1] ?? '';
      const t = parseInt(last, 36);
      return Number.isFinite(t) ? t : 0;
    };

    const groups = new Map<string, Array<{ x: number; y: number; uid: string; t: number; order: number | null }>>();

    for (let y = 0; y < 10; y++) {
      for (let x = 0; x < 10; x++) {
        const uid = uidAt(occ, currentLayer, x, y);
        if (!uid) continue;
        const obj = objByUid.get(uid) ?? null;
        if (!obj || obj.type !== 'CHAIN_BARRIER') continue;

        const anyObj: any = obj as any;
        let cid = String(anyObj.chainId ?? anyObj.chainGroupId ?? '').trim();
        // 런타임(StageCompiler)과 동일한 기본값: chainId가 없으면 셀 단위로 독립
        if (!cid) cid = `C_${currentLayer}_${x}_${y}`;

        groupOf.set(`${x},${y}`, cid);
        const rawOrder = anyObj.chainOrder;
        const order = Number.isFinite(rawOrder) ? Math.floor(rawOrder) : null;

        if (!groups.has(cid)) groups.set(cid, []);
        groups.get(cid)!.push({ x, y, uid, t: uidTime(uid), order });
      }
    }

    for (const [cid, cells] of groups.entries()) {
      groupSize.set(cid, cells.length);
      if (cells.length <= 0) continue;

      cells.sort((a, b) => {
        const ao = a.order ?? 1e9;
        const bo = b.order ?? 1e9;
        return ao - bo || a.t - b.t || a.uid.localeCompare(b.uid);
      });

      headCells.add(`${cells[0].x},${cells[0].y}`);
      tailCells.add(`${cells[cells.length - 1].x},${cells[cells.length - 1].y}`);
    }

    return { groupOf, headCells, tailCells, groupSize };
  }, [occ, objByUid, currentLayer]);

  const selectedObj: BoardObject | null = useMemo(() => {
    if (!selectedUid) return null;
    const init = stage.board.objects.find((o) => o.uid === selectedUid);
    if (init) return init as any;
    const pages = stage.supply?.pages ?? [];
    for (const p of pages) {
      const hit = p.objects.find((o) => o.uid === selectedUid);
      if (hit) return hit as any;
    }
    return null;
  }, [stage, selectedUid]);

  const selectedCells = useMemo(() => {
    const set = new Set<string>();

    // 1) 단일 선택(selectedUid)
    if (selectedUid) {
      const obj = targetObjects.find((o) => o.uid === selectedUid);
      if (obj && objLayer(obj) === currentLayer) {
        for (const c of cellsOf(obj)) set.add(`${c.x},${c.y}`);
      }
    }

    // 2) Ctrl/Cmd 다중 선택(multiSelUids)
    if (multiSelUids && multiSelUids.size > 0) {
      for (const uid of multiSelUids) {
        const obj = objByUid.get(uid);
        if (!obj) continue;
        if (objLayer(obj) !== currentLayer) continue;
        for (const c of cellsOf(obj)) set.add(`${c.x},${c.y}`);
      }
    }

    return set;
  }, [selectedUid, targetObjects, currentLayer, multiSelUids, objByUid]);

  // ✅ 사각형 선택(selRect) 안의 오브젝트 UID(현재 레이어)
  const selRectUids = useMemo(() => {
    if (!selRect) return [] as string[];
    const s = new Set<string>();
    for (let yy = selRect.y0; yy <= selRect.y1; yy++) {
      for (let xx = selRect.x0; xx <= selRect.x1; xx++) {
        const uid = uidAt(occ, currentLayer, xx, yy);
        if (uid) s.add(uid);
      }
    }
    return Array.from(s);
  }, [selRect, occ, currentLayer]);

  const selRectObjs = useMemo(() => {
    const out: BoardObject[] = [];
    for (const uid of selRectUids) {
      const o = objByUid.get(uid);
      if (o) out.push(o);
    }
    return out;
  }, [selRectUids, objByUid]);

  const selRectColorUids = useMemo(() => {
    const out: string[] = [];
    for (const o of selRectObjs) {
      if (
        o.type === 'BLOCK_NORMAL' ||
        o.type === 'BLOCK_HIDDEN' ||
        o.type === 'CHAIN_BARRIER' ||
        o.type === 'BLOCK_LARGE' ||
        o.type === 'BLOCK_LARGE_HIDDEN'
      ) {
        out.push(o.uid);
      }
    }
    return out;
  }, [selRectObjs]);

  const selRectHpUids = useMemo(() => {
    const out: string[] = [];
    for (const o of selRectObjs) {
      // 라지(2x2) + 생성박스(2x1)
      if (o.type === 'BLOCK_LARGE' || o.type === 'BLOCK_LARGE_HIDDEN' || o.type === 'SPAWNER_BOX') out.push(o.uid);
    }
    return out;
  }, [selRectObjs]);

  // ✅ Ctrl/Cmd 다중 선택(비사각형) 대상 UID/오브젝트
  const multiSelUidsArr = useMemo(() => Array.from(multiSelUids ?? []), [multiSelUids]);
  const multiSelObjs = useMemo(() => {
    const out: BoardObject[] = [];
    for (const uid of multiSelUidsArr) {
      const o = objByUid.get(uid);
      if (o) out.push(o);
    }
    return out;
  }, [multiSelUidsArr, objByUid]);
  const multiSelColorUids = useMemo(() => {
    const out: string[] = [];
    for (const o of multiSelObjs) {
      if (
        o.type === 'BLOCK_NORMAL' ||
        o.type === 'BLOCK_HIDDEN' ||
        o.type === 'CHAIN_BARRIER' ||
        o.type === 'BLOCK_LARGE' ||
        o.type === 'BLOCK_LARGE_HIDDEN'
      ) {
        out.push(o.uid);
      }
    }
    return out;
  }, [multiSelObjs]);
  const multiSelHpUids = useMemo(() => {
    const out: string[] = [];
    for (const o of multiSelObjs) {
      // 라지(2x2) + 생성박스(2x1)
      if (o.type === 'BLOCK_LARGE' || o.type === 'BLOCK_LARGE_HIDDEN' || o.type === 'SPAWNER_BOX') out.push(o.uid);
    }
    return out;
  }, [multiSelObjs]);

  // ✅ 현재 "일괄 편집" 대상 UID 집합(우선순위: selRect > multiSel)
  const bulkSelUids = selRect ? selRectUids : multiSelUidsArr;
  const bulkSelColorUids = selRect ? selRectColorUids : multiSelColorUids;
  const bulkSelHpUids = selRect ? selRectHpUids : multiSelHpUids;

  const issues = useMemo(() => validateStage(stage, numDraft), [stage, numDraft]);

  const issueCellSet = useMemo(() => {
    if (!issueHighlightMode) return new Set<string>();
    const s = new Set<string>();
    for (const it of issues) if (it.at) s.add(`${it.at.x},${it.at.y}`);
    return s;
  }, [issues, issueHighlightMode]);

  const isIssueCell = (x: number, y: number) => issueCellSet.has(`${x},${y}`);

  const isFocusCell = (x: number, y: number) =>
    !!focusIssueAt && focusIssueAt.x === x && focusIssueAt.y === y && Date.now() - focusIssueAt.t < 1200;

  const isRectPreviewCell = (x: number, y: number) => {
    if (!rectPreview) return false;
    return x >= rectPreview.x0 && x <= rectPreview.x1 && y >= rectPreview.y0 && y <= rectPreview.y1;
  };

  const isSelRectCell = (x: number, y: number) => {
    if (!selRect) return false;
    return x >= selRect.x0 && x <= selRect.x1 && y >= selRect.y0 && y <= selRect.y1;
  };

  const isSelGhostCell = (x: number, y: number) => {
    if (!selGhost) return false;
    return x >= selGhost.x0 && x <= selGhost.x1 && y >= selGhost.y0 && y <= selGhost.y1;
  };

  const pillarPreviewCells = useMemo(() => {
    if (!(toolMode === 'PAINT' && brush === 'PILLAR')) return new Set<string>();
    if (!pillarLineStart) return new Set<string>();
    if (!hoverCell) return new Set<string>();

    const cells: Array<{ x: number; y: number }> = [];
    const pushLine = (ax: number, ay: number, bx: number, by: number) => {
      if (ax === bx) {
        const step = ay <= by ? 1 : -1;
        for (let cy = ay; cy !== by + step; cy += step) cells.push({ x: ax, y: cy });
      } else if (ay === by) {
        const step = ax <= bx ? 1 : -1;
        for (let cx = ax; cx !== bx + step; cx += step) cells.push({ x: cx, y: ay });
      } else {
        pushLine(ax, ay, bx, ay);
        pushLine(bx, ay, bx, by);
      }
    };
    pushLine(pillarLineStart.x, pillarLineStart.y, hoverCell.x, hoverCell.y);

    const s = new Set<string>();
    for (const c of cells) s.add(`${c.x},${c.y}`);
    return s;
  }, [toolMode, brush, pillarLineStart, hoverCell]);

  const isPillarPreviewCell = (x: number, y: number) => pillarPreviewCells.has(`${x},${y}`);

  const chainPreviewCells = useMemo(() => {
    if (!(toolMode === 'PAINT' && brush === 'CHAIN_BARRIER')) return new Set<string>();
    if (!chainLineStart) return new Set<string>();
    if (!hoverCell) return new Set<string>();

    const sy = chainLineStart.y;
    const sx = chainLineStart.x;
    const ex = hoverCell.x;
    let x0 = Math.min(sx, ex);
    let x1 = Math.max(sx, ex);
    let len = x1 - x0 + 1;
    len = Math.max(2, Math.min(10, len));
    x0 = Math.max(0, Math.min(9 - len + 1, x0));
    x1 = x0 + len - 1;

    const s = new Set<string>();
    for (let cx = x0; cx <= x1; cx++) s.add(`${cx},${sy}`);
    return s;
  }, [toolMode, brush, chainLineStart, hoverCell]);

  const isChainPreviewCell = (x: number, y: number) => chainPreviewCells.has(`${x},${y}`);
  const isFlashCell = (x: number, y: number) => !!paintFlash && paintFlash.set.has(`${x},${y}`);
  const isDragMarkCell = (x: number, y: number) => !!dragMark && dragMark.has(`${x},${y}`);
  const isPasteAnchorCell = (x: number, y: number) => !!pasteAnchor && pasteAnchor.x === x && pasteAnchor.y === y;
  const errorCount = issues.filter((i) => i.level === 'error').length;

  const [importErr, setImportErr] = useState<string | null>(null);
  const [exportErr, setExportErr] = useState<string | null>(null);
  const [exportErrDetails, setExportErrDetails] = useState<any | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportProg, setExportProg] = useState<any | null>(null);

  // 랜덤 스테이지 생성(초기/공급을 한번에 만들고, 리플레이 SOLVED까지 자동 보정)
  const [randOpen, setRandOpen] = useState(false);
  const [randGenerating, setRandGenerating] = useState(false);
  const [randGenErr, setRandGenErr] = useState<string | null>(null);
  const [randGenProg, setRandGenProg] = useState<string | null>(null);
  // 도움말(단축키/기능 설명)
  const [helpOpen, setHelpOpen] = useState(false);

  // ✅ 특수 오브젝트 배치(HP/색상 입력 모달)
  const [placeModal, setPlaceModal] = useState<null | { brush: BoardObjectType; x: number; y: number }>(null);
  const [largeHpDraft, setLargeHpDraft] = useState<string>('80');
  const [spawnerHpDraft, setSpawnerHpDraft] = useState<string>('10');
  const [spawnerLeft, setSpawnerLeft] = useState<Color12>('R');
  const [spawnerRight, setSpawnerRight] = useState<Color12>('R');
  const placeHpRef = useRef<HTMLInputElement | null>(null);

  // ✅ 체인 블럭(1xN) 배치: 머리 방향 선택 모달
  const [chainModal, setChainModal] = useState<null | { endX: number; endY: number; y: number; x0: number; x1: number }>(null);
  const [chainHeadSideDraft, setChainHeadSideDraft] = useState<'LEFT' | 'RIGHT'>('LEFT');

  // ✅ 간이 플레이(리플레이) : W1 클릭 → 슈팅라인 장착 → 자동발사 흐름을 시간축으로 확인
  const [replayOpen, setReplayOpen] = useState(false);
  const [replayRunning, setReplayRunning] = useState(false);
  const [replayErr, setReplayErr] = useState<string | null>(null);
  const [replayRes, setReplayRes] = useState<SimReplayResult | null>(null);
  const [replayIdx, setReplayIdx] = useState(0);
  const [replayDetail, setReplayDetail] = useState<ReplayDetail>('compact');
  const [replayStrictHint, setReplayStrictHint] = useState(true);

  // 검증 문제 셀 하이라이트 모드

  // 마지막 적용(Shift 사각형/기둥 라인 등) 위치를 잠깐 플래시로 표시

  // 역할: 여러 셀을 적용한 직후, 어디가 찍혔는지 0.4초 정도 시각적으로 보여줍니다.
  const flashCells = (cells: Array<{ x: number; y: number }>) => {
    const s = new Set<string>();
    for (const c of cells) s.add(`${c.x},${c.y}`);
    const t = Date.now();
    setPaintFlash({ set: s, t });
    window.setTimeout(() => {
      setPaintFlash((cur) => (cur && cur.t === t ? null : cur));
    }, 420);
  };

  // Shift 사각형 / 기둥(PILLAR) 미리보기

  const [randCfg, setRandCfg] = useState<RandomStageGenCfg>(() => {
    const bc = Math.max(200, Math.floor((stage.meta as any)?.blockCount ?? 200));
    return {
      blockCount: bc,
      difficulty: 5,
      pattern: 'HEART',
      fillBackground: true,
      symmetry: 'RANDOM',
      includeChain: true,
      includeHidden: true,
      includeLarge: true,
      includeLargeHidden: false,
      includeSpawner: false,
      includeKeyLock: false,
    };
  });

  // ✅ 패턴 드롭다운이 너무 길어지므로 group으로 묶어서 표시
  const randPatternGroups = useMemo(() => {
    type P = (typeof PATTERNS_10x10)[number];
    const order = ['기본', '심볼', '방향', '패턴', '기타'];
    const m = new Map<string, P[]>();
    for (const p of PATTERNS_10x10 as readonly P[]) {
      const g = (p as any).group ? String((p as any).group) : '기타';
      if (!m.has(g)) m.set(g, []);
      m.get(g)!.push(p);
    }
    const out: Array<{ group: string; items: P[] }> = [];
    for (const g of order) {
      const items = m.get(g);
      if (items && items.length) out.push({ group: g, items });
    }
    for (const [g, items] of m.entries()) {
      if (order.includes(g)) continue;
      out.push({ group: g, items });
    }
    return out;
  }, []);

  const onImport = async (file: File) => {
    setImportErr(null);
    setExportErr(null);
    try {
      const text = await file.text();
      loadFromText(text);
    } catch (e: any) {
      setImportErr(e?.message ?? 'Import 실패');
    }
  };


  const onExport = async () => {
    // ✅ Export 버튼에서만 무거운 검증(STRICT SOLVED)을 수행합니다.
    // - validator_tools(현재 프로젝트 기준 최신 버전)의 repairStagePack을 사용
    // - 결과는 cards.mode=AUTHORED + authored[*].hintStep(1..N) 형태로 Export
    setExportErr(null);
    setExportErrDetails(null);
    setExportProg(null);

    setExporting(true);
    try {
      const json = getPackJson();
      const packObj: any = JSON.parse(json);
      const stages: any[] = Array.isArray(packObj?.stages) ? packObj.stages.slice() : [];
      stages.sort((a, b) => ((a?.id ?? 0) | 0) - ((b?.id ?? 0) | 0));

      // dynamic import: validator_tools는 CommonJS 출력이라 named export로 바로 못 받을 수 있음
      const cliMod: any = await import('./validator_tools/cli.js');
      const repairStagePack: any = cliMod?.repairStagePack ?? cliMod?.default?.repairStagePack;
      if (typeof repairStagePack !== 'function') {
        throw new Error('validator_tools: repairStagePack not found (cli.js export missing)');
      }

      const outStages: any[] = [];
      const reportResults: any[] = [];
      const stageCount = stages.length;

      // ✅ stage-by-stage로 돌려서 최소한의 진행률 표시
      for (let si = 0; si < stages.length; si++) {
        const st = stages[si];
        const id = (st?.id ?? si + 1) | 0;
        setExportProg({ stageId: id, stageIndex: si + 1, stageCount, attempt: 0, maxAttempts: 0, phase: 'attempt' });

        // single-stage pack으로 처리(리포트/에러가 stage 단위로 더 명확)
        const onePack: any = { schemaVersion: packObj?.schemaVersion ?? 2, stages: [st] };
        const { pack: fixedPack, report }: any = await repairStagePack(
          onePack,
          50000, // maxSteps
          100, // maxAutoFixPerStage
          140, // maxIters
          { enabled: true, depth: 10, window: 12, beam: 10, simSteps: 4000 },
          undefined,
        );

        const fixedStage = Array.isArray(fixedPack?.stages) ? fixedPack.stages[0] : Array.isArray(fixedPack) ? fixedPack[0] : null;
        const r0 = report?.results?.[0] ?? null;
        if (!fixedStage) {
          const err: any = new Error(`validator_tools: stage output missing (stageId=${id})`);
          err.details = { stageId: id };
          throw err;
        }

        // ✅ Export는 solver(validator_tools repairStagePack) 결과만 사용합니다.
        // replay 보정은 품질 분석용 도구로 분리하고, export gate에는 반영하지 않습니다.
        const row: any = { stageId: id };
        if (r0) Object.assign(row, r0);
        reportResults.push(row);
        outStages.push(fixedStage);

        setExportProg({ stageId: id, stageIndex: si + 1, stageCount, attempt: 0, maxAttempts: 0, phase: 'done' });
      }

      const outPack = { ...packObj, schemaVersion: 2, stages: outStages };

      // (옵션) 디버그용 리포트도 같이 저장해두면, 실패/품질 문제 분석이 쉬워집니다.
      const summary = {
        total: stageCount,
        solved: reportResults.filter((r) => String(r?.status) === 'SOLVED').length,
        stuck: reportResults.filter((r) => String(r?.status) === 'STUCK').length,
        unknown: reportResults.filter((r) => String(r?.status) === 'UNKNOWN').length,
        error: reportResults.filter((r) => String(r?.status) === 'ERROR').length,
      };
      downloadText('report_stagepack_v2_solver_only.json', JSON.stringify({ summary, results: reportResults }, null, 2));

      const outName = 'stagepack_v2_solver_only.json';
      downloadText(outName, JSON.stringify(outPack, null, 2));
    } catch (e: any) {
      setExportErr(e?.message ?? 'Export 실패');
      setExportErrDetails(e?.details ?? null);
    } finally {
      setExporting(false);
      setExportProg(null);
    }
  };

  const onResetLocal = () => {
    clearSaved();
    resetToDefault();
  };

  const applyRandomStage = async () => {
    if (randGenerating) return;
    setRandGenErr(null);
    setRandGenProg('랜덤 스테이지 생성 준비...');
    setRandGenerating(true);
    try {
      // ✅ 1) 랜덤 배치 → 2) StageCompiler 기반 repairStagePack → 3) 리플레이(SOLVED까지) 보정
      const cliMod: any = await import('./validator_tools/cli.js');
      const repairStagePack: any = cliMod?.repairStagePack ?? cliMod?.default?.repairStagePack;
      if (!repairStagePack) throw new Error('validator_tools/cli.js에서 repairStagePack을 찾을 수 없습니다.');

      const maxAttempts = 12;
      let lastReason: any = null;

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const seed = (Date.now() ^ (attempt * 0x9e3779b9)) >>> 0;
        setRandGenProg(`생성 시도 ${attempt}/${maxAttempts} (seed=${seed})...`);

        const draft = generateRandomStage(stage as any, randCfg, seed);
        const onePack = { schemaVersion: 2, stages: [draft] } as any;

        setRandGenProg(`repairStagePack... (attempt ${attempt}/${maxAttempts})`);
        const { pack: repairedPack } = await repairStagePack(onePack, 200000, 240, 240, true, undefined);
        const repairedStage = repairedPack?.stages?.[0];
        if (!repairedStage) throw new Error('repairStagePack 결과에 stage가 없습니다.');

        setRandGenProg(`리플레이 검증/보정... (attempt ${attempt}/${maxAttempts})`);
        const { stage: replayFixedStage, replay } = await repairStageUntilReplaySolved(repairedStage, {
          maxIters: 800,
          verbose: false,
        });

        if (replay?.status === 'SOLVED') {
          replaceCurrentStage(replayFixedStage as any);
          setRandOpen(false);
          setRandGenProg(null);
          return;
        }

        lastReason = {
          status: replay?.status ?? 'UNKNOWN',
          reason: replay?.reason ?? null,
          clicked: replay?.clicked ?? 0,
          rounds: replay?.rounds ?? 0,
          shotsFired: replay?.shotsFired ?? 0,
          nextHint: replay?.nextHint ?? null,
        };
        setRandGenProg(`STUCK/UNKNOWN: ${lastReason.reason ?? lastReason.status} → 재시도...`);
      }

      const err: any = new Error('랜덤 생성 후 리플레이 SOLVED까지 보정하지 못했습니다. (재시도 횟수 초과)');
      err.details = lastReason;
      throw err;
    } catch (e: any) {
      setRandGenErr(e?.message ?? '랜덤 생성 실패');
      if (e?.details) console.warn('random-stage details:', e.details);
    } finally {
      setRandGenerating(false);
      setRandGenProg(null);
    }
  };

  // ---- 드래그 페인팅(마우스/펜) ----
  const gridRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ active: boolean; lastKey: string; forceErase: boolean }>({ active: false, lastKey: '', forceErase: false });
  const rectRef = useRef<{
    active: boolean;
    start: { x: number; y: number } | null;
    end: { x: number; y: number } | null;
    forceErase: boolean;
    mode: 'PAINT' | 'ERASE';
  }>({ active: false, start: null, end: null, forceErase: false, mode: 'PAINT' });

  // ---- 컬러 휠 선택 ----
  // 역할: 색상 버튼 위 또는 그리드 위에서 마우스 휠로 컬러를 순환 선택합니다.
  const paletteRef = useRef<HTMLDivElement | null>(null);
  const hoverRef = useRef<{ grid: boolean; palette: boolean }>({ grid: false, palette: false });

  const cycleColorByWheel = (deltaY: number) => {
    // wheel down(+) => 다음, wheel up(-) => 이전
    const dir = deltaY > 0 ? 1 : -1;
    const list = COLOR_UI;
    const cur = Math.max(0, list.indexOf(color));
    const next = (cur + dir + list.length) % list.length;
    setColor(list[next]);
  };

  useEffect(() => {
    const onWheel = (e: WheelEvent) => {
      // 숫자 입력 중(또는 폼 요소 위)에는 컬러 휠 변경을 막습니다.
      const t = e.target as any;
      if (t && (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement)) return;
      if (!hoverRef.current.grid && !hoverRef.current.palette) return;
      // 스크롤 대신 색상 변경
      e.preventDefault();
      cycleColorByWheel(e.deltaY);
    };

    // passive:false 가 필요 (preventDefault)
    window.addEventListener('wheel', onWheel, { passive: false });
    return () => window.removeEventListener('wheel', onWheel as any);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [color]);

// ---- 숫자 입력 UX(휠/방향키) ----
// 역할: number input 위에서 휠/↑↓로 값 조절(Shift=10배). React controlled input에도 적용되도록 input 이벤트를 트리거합니다.
useEffect(() => {
  const clamp = (v: number, min: number | null, max: number | null) => {
    let out = v;
    if (min != null && Number.isFinite(min)) out = Math.max(min, out);
    if (max != null && Number.isFinite(max)) out = Math.min(max, out);
    return out;
  };

  const readNum = (el: HTMLInputElement) => {
    const v = Number(el.value);
    if (Number.isFinite(v)) return v;
    const minAttr = el.getAttribute('min');
    const min = minAttr != null && minAttr !== '' ? Number(minAttr) : 0;
    return Number.isFinite(min) ? min : 0;
  };

  const stepOf = (el: HTMLInputElement, shift: boolean) => {
    const stepAttr = el.getAttribute('step');
    const base = stepAttr != null && stepAttr !== '' ? Number(stepAttr) : 1;
    const s = Number.isFinite(base) && base > 0 ? base : 1;
    return shift ? s * 10 : s;
  };

  const applyDelta = (el: HTMLInputElement, delta: number, shift: boolean) => {
    if (el.disabled || el.readOnly) return;
    const minAttr = el.getAttribute('min');
    const maxAttr = el.getAttribute('max');
    const min = minAttr != null && minAttr !== '' ? Number(minAttr) : null;
    const max = maxAttr != null && maxAttr !== '' ? Number(maxAttr) : null;

    const cur = readNum(el);
    const step = stepOf(el, shift);
    const next = clamp(cur + delta * step, Number.isFinite(min as any) ? (min as any) : null, Number.isFinite(max as any) ? (max as any) : null);

    // React onChange를 유도하기 위해 value 직접 세팅 후 input 이벤트 dispatch
    el.value = String(next);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };

  const onWheel = (e: WheelEvent) => {
    const t = e.target as any;
    if (!(t instanceof HTMLInputElement)) return;
    if (t.type !== 'number') return;
    e.preventDefault();
    const dir = e.deltaY > 0 ? -1 : 1; // wheel down = 감소(일반적인 스피너 느낌)
    applyDelta(t, dir, e.shiftKey);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    const t = e.target as any;
    if (!(t instanceof HTMLInputElement)) return;
    if (t.type !== 'number') return;
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    const dir = e.key === 'ArrowUp' ? 1 : -1;
    applyDelta(t, dir, e.shiftKey);
  };

  window.addEventListener('wheel', onWheel, { passive: false, capture: true });
  window.addEventListener('keydown', onKeyDown, { capture: true });
  return () => {
    window.removeEventListener('wheel', onWheel as any, { capture: true } as any);
    window.removeEventListener('keydown', onKeyDown as any, { capture: true } as any);
  };
}, []);

  const pickCellFromPointer = (clientX: number, clientY: number): { x: number; y: number } | null => {
    const el = gridRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();

    // styles.css(.grid): padding 8px, gap 2px
    const PAD = 8;
    const GAP = 2;
    const x0 = clientX - r.left - PAD;
    const y0 = clientY - r.top - PAD;
    if (x0 < 0 || y0 < 0) return null;

    const step = cellPx + GAP;
    const col = Math.floor(x0 / step);
    const rowTop = Math.floor(y0 / step); // 0이 맨 위
    if (col < 0 || col >= 10 || rowTop < 0 || rowTop >= 10) return null;
    const x = col;
    const y = 9 - rowTop;
    return { x, y };
  };

  const applyAt = (x: number, y: number, forceErase: boolean) => {
    clickCell(x, y, { forceErase });
    // ✅ 드래그/클릭 표시용 마킹
    // 역할: 그리기/지우기에서 적용된 셀을 드래그 중에 즉시 보여줍니다.
    if (toolMode !== 'SELECT') {
      setDragMark((prev) => {
        const s = prev ? new Set(prev) : new Set<string>();
        s.add(`${x},${y}`);
        return s;
      });
    }
  };

  // ✅ 스포이드(Alt+클릭)
  // 역할: 찍혀있는 오브젝트를 선택해 브러시/색상을 빠르게 가져옵니다.
  const tryEyedrop = (x: number, y: number) => {
    const uid = uidAt(occ, currentLayer, x, y);
    if (!uid) return false;
    const obj = objByUid.get(uid);
    if (!obj) return false;
    if (!isBrushAllowedForTarget(editTarget.kind, obj.type as any)) return false;
    setBrush(obj.type as any);
    // 색상이 있는 타입만 컬러도 함께 선택
    const anyObj: any = obj as any;
    if (anyObj.color && anyObj.color !== 'W') setColor(anyObj.color);
    setToolMode('PAINT');
    return true;
  };

  // ✅ 특수 오브젝트 배치 모달 오픈(HP/색상 입력)
  const openPlaceModal = (b: BoardObjectType, x: number, y: number) => {
    if (b === 'BLOCK_LARGE') {
      setLargeHpDraft(String((brushConfig as any)?.largeHp ?? 80));
    } else if (b === 'BLOCK_LARGE_HIDDEN') {
      setLargeHpDraft(String((brushConfig as any)?.largeHiddenHp ?? 80));
    } else if (b === 'SPAWNER_BOX') {
      setSpawnerHpDraft(String((brushConfig as any)?.spawnerHp ?? 10));
      setSpawnerLeft(((brushConfig as any)?.spawnerLeft ?? color) as any);
      setSpawnerRight(((brushConfig as any)?.spawnerRight ?? color) as any);
    }
    setPlaceModal({ brush: b, x, y });
    // 다음 프레임에 포커스(HP 입력이 있는 모달)
    window.setTimeout(() => placeHpRef.current?.focus(), 0);
  };

  const parseDraftInt = (s: string): number | null => {
    const t = String(s ?? '').trim();
    if (t === '' || t === '-') return null;
    const n = Number(t);
    if (!Number.isFinite(n)) return null;
    return Math.trunc(n);
  };

  const onGridPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
  e.preventDefault();
  // ✅ 포인터 캡처(드래그 중 포인터가 셀 밖으로 나가도 move/up 안정적으로 받기)
  try { (e.currentTarget as any).setPointerCapture?.(e.pointerId); } catch {}

  // ✅ 우클릭(버튼=2)은 '지우기'로 동작(드래그 포함)
  const isRight = e.button === 2;

  const cell = pickCellFromPointer(e.clientX, e.clientY);
  if (!cell) return;

  if (toolMode === 'PAINT' && !isRight && !isBrushAllowedForTarget(editTarget.kind, brush)) {
    return;
  }

  // ✅ 스포이드(Alt+클릭)
  if (e.altKey) {
    tryEyedrop(cell.x, cell.y);
    return;
  }

  // ✅ 특수 오브젝트(라지/생성박스) 배치: 즉시 배치하지 않고 모달로 파라미터를 입력합니다.
  // - 우클릭(지우기)에는 모달이 뜨지 않음
  // - Shift 사각형 채우기도 이 브러시들에서는 비활성화(헷갈림/겹침 방지)
  if (
    !isRight &&
    toolMode === 'PAINT' &&
    (brush === 'BLOCK_LARGE' || brush === 'BLOCK_LARGE_HIDDEN' || brush === 'SPAWNER_BOX')
  ) {
    openPlaceModal(brush, cell.x, cell.y);
    return;
  }

  // ✅ Shift+드래그 사각형(채우기/지우기)
  if (e.shiftKey && toolMode !== 'SELECT' && !(toolMode === 'PAINT' && (brush === 'PILLAR' || brush === 'CHAIN_BARRIER'))) {
    rectRef.current.active = true;
    rectRef.current.start = { x: cell.x, y: cell.y };
    rectRef.current.end = { x: cell.x, y: cell.y };
    rectRef.current.forceErase = isRight;
    rectRef.current.mode = (toolMode === 'ERASE' || isRight) ? 'ERASE' : 'PAINT';
    setRectPreview({ x0: cell.x, y0: cell.y, x1: cell.x, y1: cell.y, mode: rectRef.current.mode });
    // Shift 모드에서는 단발 클릭은 up에서 일괄 처리
    return;
  }

    // ✅ SELECT: 드래그로 선택영역 생성 + 드래그 복사(스탬프) + 붙여넣기 기준점 지정
    if (toolMode === 'SELECT' && !isRight) {
      setPasteAnchor(cell);

      // ✅ Ctrl/Cmd+클릭: 비사각형 다중 선택(중복 선택)
      // - 요구사항: "컨트롤 셀선택 하면 중복선택"
      const ctrl = e.ctrlKey || (e as any).metaKey;
      if (ctrl) {
        // 사각형 선택/고스트는 해제하고, multiSelUids만 유지
        setSelRect(null);
        setSelGhost(null);
        setSelectedUid(null);
        const hit = uidAt(occ, currentLayer, cell.x, cell.y);
        if (hit) {
          const obj = objByUid.get(hit);
          if (obj && objLayer(obj) === currentLayer) {
            flashCells(Array.from(cellsOf(obj)));
          } else {
            flashCells([{ x: cell.x, y: cell.y }]);
          }
          setMultiSelUids((prev) => {
            const next = new Set(prev);
            if (next.has(hit)) next.delete(hit);
            else next.add(hit);
            return next;
          });
        }
        return;
      }

      const withinSel = (r: { x0: number; y0: number; x1: number; y1: number } | null, x: number, y: number) =>
        !!r && x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1;

      // 1) 이미 선택영역이 있고, 그 내부를 눌렀으면: 드래그-복사 시작
      if (withinSel(selRect, cell.x, cell.y) && selRect) {
        // 선택영역 기준으로 grab offset 유지
        selDragRef.current.active = true;
        selDragRef.current.grab = { x: cell.x, y: cell.y };
        selDragRef.current.offset = { dx: cell.x - selRect.x0, dy: cell.y - selRect.y0 };
        setSelGhost({ ...selRect });
        return;
      }

      // 2) 새 선택영역 만들기
      selRef.current.active = true;
      selRef.current.start = { x: cell.x, y: cell.y };
      selRef.current.end = { x: cell.x, y: cell.y };
      selRef.current.moved = false;
      setSelRect({ x0: cell.x, y0: cell.y, x1: cell.x, y1: cell.y });
      setSelGhost(null);
      setSelectedUid(null);
      setMultiSelUids(new Set());
      return;
    }

    dragRef.current.active = true;
    dragRef.current.lastKey = '';
    dragRef.current.forceErase = isRight;
    // ✅ 기둥(PILLAR) 2번째 클릭 시: 실제로 찍힐 라인을 계산해 잠깐 표시
    if (!isRight && toolMode === 'PAINT' && brush === 'PILLAR' && pillarLineStart) {
      const cells: Array<{ x: number; y: number }> = [];
      const pushLine = (ax: number, ay: number, bx: number, by: number) => {
        if (ax === bx) {
          const step = ay <= by ? 1 : -1;
          for (let cy = ay; cy !== by + step; cy += step) cells.push({ x: ax, y: cy });
        } else if (ay === by) {
          const step = ax <= bx ? 1 : -1;
          for (let cx = ax; cx !== bx + step; cx += step) cells.push({ x: cx, y: ay });
        } else {
          pushLine(ax, ay, bx, ay);
          pushLine(bx, ay, bx, by);
        }
      };
      pushLine(pillarLineStart.x, pillarLineStart.y, cell.x, cell.y);
      // 실제 클릭은 store에서 처리
      applyAt(cell.x, cell.y, dragRef.current.forceErase);
      flashCells(cells);
    } else if (!isRight && toolMode === 'PAINT' && brush === 'CHAIN_BARRIER' && chainLineStart) {
      // ✅ 체인(CHAIN_BARRIER) 2번째 클릭 시: 실제로 찍힐 가로 라인을 계산해 잠깐 표시
      // - 길이: 2~10칸
      // - y는 시작점 기준(체인은 세로로 늘어나지 않음)
      const sy = chainLineStart.y;
      const sx = chainLineStart.x;
      const ex = cell.x;
      let x0 = Math.min(sx, ex);
      let x1 = Math.max(sx, ex);
      let len = x1 - x0 + 1;
      len = Math.max(2, Math.min(10, len));
      x0 = Math.max(0, Math.min(9 - len + 1, x0));
      x1 = x0 + len - 1;
      const cells: Array<{ x: number; y: number }> = [];
      for (let cx = x0; cx <= x1; cx++) cells.push({ x: cx, y: sy });

      // ✅ 체인 머리 방향 선택 모달(왼쪽/오른쪽)
      // - 실제 배치는 모달에서 '적용'을 누를 때 store.clickCell로 처리합니다.
      setChainHeadSideDraft((((brushConfig as any)?.chainHeadSide ?? 'LEFT') as any) === 'RIGHT' ? 'RIGHT' : 'LEFT');
      setChainModal({ endX: cell.x, endY: cell.y, y: sy, x0, x1 });
      flashCells(cells);
    } else {
      // ✅ 클릭한 오브젝트/셀 하이라이트
      // 역할: 보드에서 "내가 클릭한 게 어떤 블럭인지" 즉시 확인할 수 있게 합니다.
      const hit = uidAt(occ, currentLayer, cell.x, cell.y);
      if (hit) {
        const obj = objByUid.get(hit);
        if (obj && objLayer(obj) === currentLayer) {
          flashCells(Array.from(cellsOf(obj)));
        } else {
          flashCells([{ x: cell.x, y: cell.y }]);
        }
      } else {
        flashCells([{ x: cell.x, y: cell.y }]);
      }
      applyAt(cell.x, cell.y, dragRef.current.forceErase);
    }

    // 기둥(PILLAR) / 체인(CHAIN)은 2클릭(시작/끝) 모델이므로 드래그로 연속 처리하지 않습니다.
    if (toolMode === 'PAINT' && (brush === 'PILLAR' || brush === 'CHAIN_BARRIER')) {
      dragRef.current.active = false;
      dragRef.current.lastKey = '';
      dragRef.current.forceErase = false;
    }
  };

  const onGridPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const cell = pickCellFromPointer(e.clientX, e.clientY);
    if (cell) setHoverCell(cell);

    // ✅ SELECT: 선택영역 드래그 업데이트
    // 역할: SELECT 모드에서 드래그로 선택 사각형을 실시간으로 갱신합니다.
    if (selRef.current.active && cell && selRef.current.start) {
      selRef.current.end = { x: cell.x, y: cell.y };
      const a = selRef.current.start;
      const b = selRef.current.end;
      const x0 = Math.min(a.x, b.x);
      const x1 = Math.max(a.x, b.x);
      const y0 = Math.min(a.y, b.y);
      const y1 = Math.max(a.y, b.y);
      // moved 플래그(단순 클릭 vs 드래그 구분)
      if (!selRef.current.moved) {
        selRef.current.moved = (x0 !== x1) || (y0 !== y1);
      }
      setSelRect({ x0, y0, x1, y1 });
      return;
    }

    // ✅ SELECT 드래그-복사: 고스트(미리보기) 이동
    if (selDragRef.current.active && selRect && cell) {
      const ox = selDragRef.current.offset.dx;
      const oy = selDragRef.current.offset.dy;
      const nx0 = cell.x - ox;
      const ny0 = cell.y - oy;
      const w = selRect.x1 - selRect.x0;
      const h = selRect.y1 - selRect.y0;
      setSelGhost({ x0: nx0, y0: ny0, x1: nx0 + w, y1: ny0 + h });
      return;
    }

    if (rectRef.current.active) {
      if (!cell) return;
      rectRef.current.end = cell;

      const a = rectRef.current.start!;
      const b = rectRef.current.end!;
      const x0 = Math.min(a.x, b.x);
      const x1 = Math.max(a.x, b.x);
      const y0 = Math.min(a.y, b.y);
      const y1 = Math.max(a.y, b.y);
      setRectPreview({ x0, y0, x1, y1, mode: rectRef.current.mode });
      return;
    }

    if (!dragRef.current.active) return;
    if (toolMode === 'PAINT' && (brush === 'PILLAR' || brush === 'CHAIN_BARRIER')) return;
    if (!cell) return;

    const key = `${cell.x},${cell.y}`;
    if (key === dragRef.current.lastKey) return;
    dragRef.current.lastKey = key;
    applyAt(cell.x, cell.y, dragRef.current.forceErase);
  };

  const endDrag = () => {
  // ✅ SELECT: 선택영역 드래그 종료
  // 역할: 선택영역 생성 드래그를 종료하고 상태를 정리합니다.
  if (selRef.current.active) {
    const wasMoved = !!selRef.current.moved;
    const start = selRef.current.start ? { ...selRef.current.start } : null;
    selRef.current.active = false;
    selRef.current.start = null;
    selRef.current.end = null;
    selRef.current.moved = false;

    // ✅ 단순 클릭(드래그 아님) = 단일 선택
    // - 요구사항: "셀 클릭" 단일 선택 + Ctrl은 중복 선택
    if (!wasMoved && start) {
      setSelRect(null);
      setSelGhost(null);
      setMultiSelUids(new Set());
      const hit = uidAt(occ, currentLayer, start.x, start.y);
      setSelectedUid(hit ?? null);
    }
  }

  // ✅ SELECT 드래그-복사 적용
  if (selDragRef.current.active && selRect && selGhost) {
    // 역할: 선택영역을 복제해 고스트 위치(좌하단)부터 붙여넣습니다.
    const x0 = selRect.x0;
    const y0 = selRect.y0;
    const x1 = selRect.x1;
    const y1 = selRect.y1;

    const within = (x: number, y: number) => x >= x0 && x <= x1 && y >= y0 && y <= y1;
    const safeClone = (o: any) => {
      try {
        return (globalThis as any).structuredClone ? (globalThis as any).structuredClone(o) : JSON.parse(JSON.stringify(o));
      } catch {
        return { ...o };
      }
    };

    const relObjects: BoardObject[] = [];
    for (const o of targetObjects) {
      if (objLayer(o) !== currentLayer) continue;
      const cells = cellsOf(o);
      if (cells.some((c) => !within(c.x, c.y))) continue;
      const no: any = safeClone(o as any);
      no.x = Math.floor(no.x ?? 0) - x0;
      no.y = Math.floor(no.y ?? 0) - y0;
      relObjects.push(no as BoardObject);
    }

    if (relObjects.length > 0) {
      const anchor = { x: selGhost.x0, y: selGhost.y0 };
      pasteObjects(anchor, relObjects);
      const flash: Array<{ x: number; y: number }> = [];
      for (const o of relObjects) {
        const ax = Math.floor((o as any).x ?? 0) + anchor.x;
        const ay = Math.floor((o as any).y ?? 0) + anchor.y;
        const tmp: any = { ...(o as any), x: ax, y: ay };
        for (const c of cellsOf(tmp as any)) flash.push(c);
      }
      flashCells(flash);
    }

    selDragRef.current.active = false;
    selDragRef.current.grab = null;
    selDragRef.current.offset = { dx: 0, dy: 0 };
    setSelGhost(null);
  }

  // ✅ Shift 사각형 적용
  if (rectRef.current.active && rectRef.current.start && rectRef.current.end) {
    const a = rectRef.current.start;
    const b = rectRef.current.end;
    const x0 = Math.min(a.x, b.x);
    const x1 = Math.max(a.x, b.x);
    const y0 = Math.min(a.y, b.y);
    const y1 = Math.max(a.y, b.y);

    const cells: Array<{ x: number; y: number }> = [];
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) cells.push({ x, y });
    }
    applyCells(cells, { mode: rectRef.current.mode, forceErase: rectRef.current.forceErase });
    flashCells(cells);

    rectRef.current.active = false;
    rectRef.current.start = null;
    rectRef.current.end = null;
    rectRef.current.forceErase = false;
    rectRef.current.mode = 'PAINT';
    setRectPreview(null);
  }

  dragRef.current.active = false;
  dragRef.current.lastKey = '';
  dragRef.current.forceErase = false;
  // 드래그 경로 표시 reset
  setDragMark(null);
};

  useEffect(() => {
    const up = () => endDrag();
    window.addEventListener('pointerup', up);
    return () => window.removeEventListener('pointerup', up);
  }, []);

  // 툴 변경 시 보드 상호작용 상태 초기화
  // 역할: 이전 툴에서 드래그/선택/프리뷰가 남아 오동작하는 것을 방지합니다.
  useEffect(() => {
    setSelRect(null);
    setRectPreview(null);
    setPasteAnchor(null);
    setDragMark(null);
    setHoverCell(null);
    setMultiSelUids(new Set());
    selRef.current.active = false;
    selRef.current.start = null;
    selRef.current.end = null;
    selRef.current.moved = false;
    rectRef.current.active = false;
    rectRef.current.start = null;
    rectRef.current.end = null;
    rectRef.current.forceErase = false;
    rectRef.current.mode = 'PAINT';
    selDragRef.current.active = false;
    selDragRef.current.grab = null;
  }, [toolMode]);

  return (
    <div className="container">
      <div className="header">
        <div className="row">
          <b>블럭몬 스테이지툴v1.0.0</b>
          <span className="badge">schema v2</span>
          <span className={`badge ${errorCount > 0 ? 'error' : ''}`}>검증: 에러 {errorCount} / 경고 {issues.length - errorCount}</span>
          <span className="badge">
            자동저장: {lastSavedAt ? new Date(lastSavedAt).toLocaleTimeString() : '—'}
          </span>
          <button className="iconBtn" onClick={() => setHelpOpen(true)} title="도움말 / 단축키">?</button>

          <button
            className="chip"
            onClick={async () => {
              setReplayOpen(true);
              setReplayErr(null);
              setReplayRes(null);
              setReplayIdx(0);
              setReplayRunning(true);
              try {
                // "실제 게임"에 가까운 흐름(W1 클릭 → S 장착 → 자동 발사)을 시간축으로 리플레이 생성
                const isBigStage = ((stage as any)?.meta?.blockCount ?? 0) > 900 || (((stage as any)?.cards?.authored?.length ?? 0) > 400);
                const r = await simulateStageReplay(stage as any, {
                  detail: replayDetail,
                  strictHintOrder: replayStrictHint,
                  // 대형 스테이지는 프레임 캡처가 메모리/속도를 크게 잡아먹습니다.
                  // (필요 시 detail=full + 소형 스테이지에서만 캡처)
                  captureFrames: replayDetail === 'full' && !isBigStage,
                  maxRounds: 200000,
                  maxShots: 2000000,
                });
                setReplayRes(r);
                setReplayIdx(0);
              } catch (e: any) {
                const msg = String(e?.message ?? e);
                // Stage를 수정(blockCount/보드/공급 등)했는데 deck(authored)가 갱신되지 않으면
                // StageCompiler가 authored ammo mismatch로 컴파일을 거부할 수 있습니다.
                if (msg.includes('authored ammo mismatch') || msg.includes('ammo sum mismatch')) {
                  try {
                    // maxIters=0: deck 재베이크(필요 시)만 하고, 순서 리페어는 하지 않습니다.
                    await repairStageUntilReplaySolved(stage as any, {
                      maxIters: 0,
                      maxRounds: 200000,
                      maxShots: 2000000,
                    });
                    const r2 = await simulateStageReplay(stage as any, {
                      detail: replayDetail,
                      strictHintOrder: replayStrictHint,
                      maxRounds: 200000,
                      maxShots: 2000000,
                    });
                    setReplayRes(r2);
                    setReplayIdx(0);
                    setReplayErr(null);
                  } catch (e2: any) {
                    setReplayErr(String(e2?.message ?? e2));
                  }
                } else {
                  setReplayErr(msg);
                }
              } finally {
                setReplayRunning(false);
              }
            }}
            title="W1 클릭 → 슈팅라인 장착 → 자동발사 흐름을 간이 시뮬(리플레이)로 확인"
          >
            플레이
          </button>

          <div className="row" style={{ gap: 6, marginLeft: 6, flexWrap: 'wrap' }}>
            <span className="small" style={{ opacity: 0.85 }}>저장레이어</span>
            {savedLayers.map((slot, i) => (
              <button
                key={i}
                className="chip"
                onClick={() => setLayerSlotOpen(i)}
                title={slot ? `저장레이어 ${i + 1} (L${slot.layer})` : `저장레이어 ${i + 1} (비어있음)`}
              >
                {i + 1}. {slot ? `L${slot.layer}` : '비어있음'}
              </button>
            ))}
          </div>
        </div>

        <div className="spacer" />

        <div className="row">
          <label className="small">스테이지</label>
          <select
            value={stage.id}
            onChange={(e) => selectStage(Number(e.target.value))}
          >
            {pack.stages
              .slice()
              .sort((a, b) => a.id - b.id)
              .map((s) => (
                <option key={s.id} value={s.id}>
                  {s.id}
                </option>
              ))}
          </select>

          <button
            className="btn"
            onClick={addStageAfter}
            title="비어있는 번호 중 가장 작은 번호로 새 스테이지를 생성합니다. (예: 1이 비어 있으면 1, 아니면 max+1)"
          >
            추가
          </button>
          <button className="btn" onClick={duplicateStage} title="현재 스테이지를 복제해서 비어있는 번호(가장 작은 번호)에 생성합니다">복제</button>
          <button className="btn danger" onClick={deleteStage} title="현재 선택된 스테이지만 삭제합니다(다른 스테이지 번호는 유지)">삭제</button>

          <span className="hr" style={{ width: 1, margin: '0 6px' }} />

          <button
            className="btn primary"
            onClick={onExport}
            disabled={exporting}
            title="현재 편집 중인 stagepack을 JSON으로 Export 합니다"
          >
            {exporting ? 'Exporting…' : 'Export JSON'}
          </button>
          <label className="btn" style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            Import JSON
            <input
              type="file"
              accept="application/json"
              style={{ display: 'none' }}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) onImport(f);
                e.currentTarget.value = '';
              }}
            />
          </label>
          <button className="btn" onClick={onResetLocal} title="localStorage 저장도 같이 초기화됩니다">초기화</button>
        </div>
      </div>

      {/* Left: tools */}
      <div className="panel">
        <h3 style={{ margin: '0 0 8px' }}>툴</h3>

        <div className="row">
          <button className={`btn ${toolMode === 'PAINT' ? 'primary' : ''}`} onClick={() => setToolMode('PAINT')}>그리기</button>
          <button className={`btn ${toolMode === 'ERASE' ? 'primary' : ''}`} onClick={() => setToolMode('ERASE')}>지우기</button>
          <button className={`btn ${toolMode === 'SELECT' ? 'primary' : ''}`} onClick={() => setToolMode('SELECT')}>선택</button>
        </div>

        <div className="hr" />

        <div className="small" style={{ marginBottom: 6 }}>브러시</div>
        <div style={{ display: 'grid', gap: 6 }}>
          {visibleBrushes.map((b) => (
            <button
              key={b.type}
              className={`btn ${brush === b.type ? 'primary' : ''}`}
              onClick={() => {
                if (!isBrushAllowedForTarget(editTarget.kind, b.type)) return;
                setBrush(b.type);
                setToolMode('PAINT');
              }}
            >
              {b.label}
            </button>
          ))}
        </div>

        <div className="hr" />

        <div className="small" style={{ marginBottom: 6 }}>색상({COLOR_UI.length}종) <span style={{ opacity: 0.6 }}>(휠로 변경 가능)</span></div>
        <div
          ref={paletteRef}
          className="row"
          onPointerEnter={() => (hoverRef.current.palette = true)}
          onPointerLeave={() => (hoverRef.current.palette = false)}
        >
          {COLOR_UI.map((c) => (
            <button
              key={c}
              className={`btn ${color === c ? 'primary' : ''}`}
              onClick={() => setColor(c)}
              title={c}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}
            >
              <span style={{ width: 14, height: 14, borderRadius: 6, border: '1px solid #e5e7eb', background: COLOR_HEX[c] }} />
              {COLOR_LABEL[c]}({c})
            </button>
          ))}
        </div>

        <div className="hr" />

        <div className="small" style={{ marginBottom: 6 }}>레이어(겹)</div>
        <div className="row" style={{ alignItems: 'center' }}>
          <label className="small">현재 레이어</label>
          <select value={currentLayer} onChange={(e) => setCurrentLayer(Number(e.target.value))}>
            {Array.from({ length: Math.max(1, Math.min(5, stage.meta.layerCount ?? 1)) }, (_, i) => (
              <option key={i} value={i}>
                L{i + 1}
              </option>
            ))}
          </select>
          <span className="small" style={{ opacity: 0.8 }}>
            / {Math.max(1, Math.min(5, stage.meta.layerCount ?? 1))}겹
          </span>
        </div>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <button className="btn" onClick={() => fillLayerWithColor('EMPTY_ONLY')} title="현재 레이어의 빈 칸만 선택한 색의 일반 블록으로 채웁니다">
            색 전체 채우기(빈칸)
          </button>
          <button className="btn" onClick={() => fillLayerWithColor('OVERWRITE')} title="현재 레이어를 선택한 색의 일반 블록으로 덮어씁니다. (기둥/생성 박스는 유지)">
            색 전체 채우기(덮어쓰기)
          </button>
          <button className="btn" onClick={() => setRandOpen(true)} title="패턴/난이도/특수블럭 옵션으로 랜덤 스테이지를 만들고, 리플레이 SOLVED까지 자동 보정합니다.">
            랜덤 생성
          </button>
        </div>

        <div className="hr" />

        {importErr ? (
          <div className="notice error" style={{ marginTop: 10 }}>
            Import 오류: {importErr}
          </div>
        ) : null}

        {exportErr ? (
          <div className="notice error" style={{ marginTop: 10 }}>
            Export 오류: {exportErr}
            {exportErrDetails ? (
              <div style={{ marginTop: 8 }}>
                <div className="small" style={{ opacity: 0.9 }}>
                  stageId={exportErrDetails.stageId}
                  {exportErrDetails.failEquipStep != null ? ` · failStep=${exportErrDetails.failEquipStep}` : ''}
                  {exportErrDetails.nextHint != null ? ` · nextHint=${exportErrDetails.nextHint}` : ''}
                  {exportErrDetails.remainingTiles != null ? ` · remaining=${exportErrDetails.remainingTiles}` : ''}
                  {exportErrDetails.clicked != null ? ` · clicked=${exportErrDetails.clicked}` : ''}
                  {exportErrDetails.rounds != null ? ` · rounds=${exportErrDetails.rounds}` : ''}
                  {exportErrDetails.shotsFired != null ? ` · shots=${exportErrDetails.shotsFired}` : ''}
                  {exportErrDetails.reason != null ? ` · reason=${exportErrDetails.reason}` : ''}
                  {exportErrDetails.desiredColor != null ? ` · desiredColor=${exportErrDetails.desiredColor}` : ''}
                </div>
                <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                  <button
                    className="btn"
                    onClick={() => downloadText(`guarantee_fail_stage${exportErrDetails.stageId ?? 'unknown'}.json`, JSON.stringify(exportErrDetails, null, 2))}
                    title="검증 실패 스냅샷/정보를 JSON으로 저장합니다"
                  >
                    실패 리포트 저장
                  </button>
                  <button
                    className="btn"
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(JSON.stringify(exportErrDetails, null, 2));
                      } catch {}
                    }}
                    title="실패 리포트를 클립보드로 복사합니다"
                  >
                    리포트 복사
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        ) : null}

        {exporting ? (
          <div className="notice" style={{ marginTop: 10 }}>
            <div style={{ fontWeight: 700, marginBottom: 4 }}>클리어 보장 검증 중…</div>
            <div className="small" style={{ opacity: 0.9 }}>
              {exportProg
                ? `Stage ${exportProg.stageId} (${(exportProg.stageIndex ?? 0) + 1}/${exportProg.stageCount}) · ` +
                  `Attempt ${exportProg.attempt}/${exportProg.maxAttempts}` +
                  (exportProg.phase === 'refine' ? ` · refine ${exportProg.refineIter ?? 0}` : '') +
                  (exportProg.failEquipStep != null ? ` · failStep ${exportProg.failEquipStep}` : '')
                : '초기화…'}
            </div>
            {exportProg && (exportProg.deadlyTotal || exportProg.pushOutCandidates) ? (
              <div className="small" style={{ opacity: 0.85, marginTop: 6, lineHeight: 1.35 }}>
                {typeof exportProg.deadlyTotal === 'number' && exportProg.deadlyTotal > 0 ? (
                  <div>
                    deadly guard: {exportProg.deadlyRejected ?? 0}/{exportProg.deadlyTotal}{' '}
                    ({Math.round(((exportProg.deadlyRejected ?? 0) / exportProg.deadlyTotal) * 100)}%)
                  </div>
                ) : null}
                {typeof exportProg.pushOutCandidates === 'number' && exportProg.pushOutCandidates > 0 ? (
                  <div>
                    push-out 개선: {exportProg.pushOutImproved ?? 0}/{exportProg.pushOutCandidates}{' '}
                    ({Math.round(((exportProg.pushOutImproved ?? 0) / exportProg.pushOutCandidates) * 100)}%)
                  </div>
                ) : null}
              </div>
            ) : null}
            <div className="small" style={{ opacity: 0.7, marginTop: 6 }}>
              (진행률이 멈춘 것처럼 보여도 백트래킹/검증 중일 수 있습니다)
            </div>
          </div>
        ) : null}
      </div>

      {/* Center: board */}
      <div className="panel centerPanel">
        <div className="gridWrap">
	          <div className="row" style={{ justifyContent: 'space-between' }}>
	            <div className="badge" title="현재(초기 보드에 찍힌 블럭) / 목표(blockCount)">
	              현재/목표: {designedTotal} / {totalBlocks}
	              {remainToGoal > 0 ? ` (남음 ${remainToGoal})` : ''}
	            </div>
	            <div className="badge">초기(initial): {initialBlocks}</div>
          </div>

          <div className="boardTopBar">
<div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginTop: 10 }}>
            <div className="row" style={{ flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
              <span className="small" style={{ opacity: 0.85 }}>편집 보드</span>
              <button
                className={`btn ${editTarget.kind === 'INITIAL' ? 'primary' : ''}`}
                onClick={() => setEditTarget({ kind: 'INITIAL' })}
              >
                초기(Initial)
              </button>

              <button
                className={`btn ${editTarget.kind === 'SUPPLY' ? 'primary' : ''}`}
                onClick={() => {
                  const cur = editTarget.kind === 'SUPPLY' ? editTarget.index : 0;
                  const maxI = (supplyPages.length > 0 ? supplyPages.length - 1 : 0);
                  const i = Math.max(0, Math.min(maxI, cur));
                  setEditTarget({ kind: 'SUPPLY', index: i });
                }}
                title="공급(Supply) 페이지를 편집합니다"
              >
                공급(Supply)
              </button>

              <div className="row" style={{ alignItems: 'center', gap: 6 }}>
                <span className="small" style={{ opacity: 0.75 }}>page</span>
                <input
                  type="number"
                  min={1}
                  max={50}
                  value={(editTarget.kind === 'SUPPLY' ? (editTarget.index + 1) : 1)}
                  onChange={(e) => {
                    const v = Math.max(1, Math.min(50, Math.floor(Number(e.target.value) || 1)));
                    setEditTarget({ kind: 'SUPPLY', index: v - 1 });
                  }}
                  style={{ width: 64 }}
                  title="편집할 공급 페이지 번호(1~50)"
                />
                <span className="small" style={{ opacity: 0.7 }}>/ {supplyPages.length}</span>
                <button className="btn" onClick={() => addSupplyPage()} title="새 공급 페이지를 추가하고 편집 대상으로 전환합니다">+페이지</button>
                <button
                  className="btn"
                  disabled={supplyPages.length <= 0 || editTarget.kind !== 'SUPPLY'}
                  onClick={() => {
                    if (editTarget.kind !== 'SUPPLY') return;
                    removeSupplyPage(editTarget.index);
                  }}
                  title={supplyPages.length <= 0 ? '삭제할 공급 페이지가 없습니다' : '현재 공급 페이지를 삭제합니다'}
                >
                  삭제
                </button>
              </div>
            </div>

            <div className="row" style={{ gap: 6 }}>
              <button className="btn" onClick={() => saveCurrentLayerAuto()} title="현재 페이지의 현재 레이어를 저장 슬롯에 저장합니다">
                레이어 저장
              </button>
              <button className="btn" onClick={() => clearCurrentLayer()}>현재 레이어 비우기</button>
              <button className="btn" onClick={() => clearCurrentPage()}>현재 페이지 비우기</button>
              <button className="btn" onClick={() => undo()} disabled={undoDepth <= 0} title="Ctrl+Z">Undo</button>
              <button className="btn" onClick={() => redo()} disabled={redoDepth <= 0} title="Ctrl+Y / Ctrl+Shift+Z">Redo</button>
            </div>
          </div>

          <div className="small" style={{ marginTop: 6, opacity: 0.8 }}>
            {editTarget.kind === 'INITIAL'
              ? '초기 보드 편집 중'
              : `공급 보드 편집 중 (page ${editTarget.index + 1}${supplyPages.length > 0 ? `/${supplyPages.length}` : ''})`}
          </div>

          </div>

          <div ref={boardAreaRef} className="boardArea">
            <div
              ref={gridRef}
              className="grid"
              style={{ ['--cell' as any]: `${cellPx}px`, touchAction: 'none' }}
              onPointerEnter={() => (hoverRef.current.grid = true)}
              onPointerLeave={() => {
                hoverRef.current.grid = false;
                setHoverCell(null);
                setRectPreview(null);
                endDrag();
              }}
              onPointerDown={onGridPointerDown}
              onPointerMove={onGridPointerMove}
              onMouseMove={(e) => onGridPointerMove(e as any)}
              onPointerUp={() => endDrag()}
              onContextMenu={(e) => e.preventDefault()}
            >
              {Array.from({ length: 100 }, (_, idx) => {
              const x = idx % 10;
              const viewY = Math.floor(idx / 10);
              const y = 9 - viewY; // y=0 bottom

              const xyKey = `${x},${y}`;
              const uid = uidAt(occ, currentLayer, x, y);
              const obj = uid ? (objByUid.get(uid) ?? null) : null;
              const selected = selectedCells.has(xyKey);
              const stack = stackCount.get(`${x},${y}`) ?? 0;

              const bg = getCellBgHex(obj, x, y);
              const fg = obj ? (isLightHex(bg) ? '#111' : '#fff') : '#6b7280';

              // ✅ 오브젝트 묶음 테두리(체인/기둥/2x2 등)
              const isMultiObj = !!obj && cellsOf(obj).length > 1;
              const chainG = obj?.type === 'CHAIN_BARRIER' ? (chainGroups.groupOf.get(xyKey) ?? null) : null;
              const chainSize = chainG != null ? (chainGroups.groupSize.get(chainG) ?? 1) : 1;
              const isChainGroup = obj?.type === 'CHAIN_BARRIER' && chainG != null && chainSize > 1;
              const isGrouped = isMultiObj || isChainGroup;

              const sameGroupAt = (nx: number, ny: number): boolean => {
                if (nx < 0 || nx >= 10 || ny < 0 || ny >= 10) return false;
                if (!isGrouped) return false;
                if (isChainGroup) return (chainGroups.groupOf.get(`${nx},${ny}`) ?? null) === chainG;
                // multi-cell object (same uid)
                return uid != null && uidAt(occ, currentLayer, nx, ny) === uid;
              };

              const outlineCol = obj ? (isLightHex(bg) ? 'rgba(17,24,39,0.70)' : 'rgba(255,255,255,0.80)') : 'rgba(17,24,39,0.35)';
              const innerCol = obj ? bg : '#e5e7eb';
              const OUT_W = 3;
              const IN_W = 1;

              const groupBorders = isGrouped
                ? {
                    borderTop: sameGroupAt(x, y + 1) ? `${IN_W}px solid ${innerCol}` : `${OUT_W}px solid ${outlineCol}`,
                    borderRight: sameGroupAt(x + 1, y) ? `${IN_W}px solid ${innerCol}` : `${OUT_W}px solid ${outlineCol}`,
                    borderBottom: sameGroupAt(x, y - 1) ? `${IN_W}px solid ${innerCol}` : `${OUT_W}px solid ${outlineCol}`,
                    borderLeft: sameGroupAt(x - 1, y) ? `${IN_W}px solid ${innerCol}` : `${OUT_W}px solid ${outlineCol}`,
                  }
                : null;

              // ✅ 기둥/체인/2x2 블럭은 셀 경계 밖으로 색이 이어져 보이게 합니다.
              // 역할: grid gap(셀 사이 간격) 때문에 끊겨 보이는 것을 줄여, 형태 파악을 쉽게 합니다.
              const needsOuterStroke =
                !!obj &&
                (obj.type === 'PILLAR' || obj.type === 'CHAIN_BARRIER' || obj.type === 'BLOCK_LARGE' || obj.type === 'BLOCK_LARGE_HIDDEN' || obj.type === 'SPAWNER_BOX');
              // gap=2px 기준으로 3px spread로 덮어 연결감을 줌
              const outerStroke = needsOuterStroke ? `0 0 0 3px ${bg}` : undefined;

              const showChainMarkers = obj?.type === 'CHAIN_BARRIER' && chainG != null && chainSize > 1;
              const isChainHead = showChainMarkers && chainGroups.headCells.has(xyKey);
              const isChainTail = showChainMarkers && chainGroups.tailCells.has(xyKey);

                return (
                  <div
                    key={`${x},${y}`}
                    className={`cell ${obj ? 'filled' : ''} ${selected ? 'selected' : ''} ${isIssueCell(x,y) ? 'issue' : ''} ${isFocusCell(x,y) ? 'issueFocus' : ''} ${isRectPreviewCell(x,y) ? 'previewRect' : ''} ${isSelRectCell(x,y) ? 'selRect' : ''} ${isSelGhostCell(x,y) ? 'selGhost' : ''} ${isPasteAnchorCell(x,y) ? 'pasteAnchor' : ''} ${isPillarPreviewCell(x,y) ? 'previewPillar' : ''} ${isChainPreviewCell(x,y) ? 'previewChain' : ''} ${isDragMarkCell(x,y) ? 'dragMark' : ''} ${isFlashCell(x,y) ? 'flash' : ''}`}
                    style={{
                      background: obj ? bg : undefined,
                      color: fg,
                      boxShadow: outerStroke,
                      ...(groupBorders ?? undefined),
                    }}
                    title={`L${currentLayer + 1} (${x},${y})${uid ? ' uid=' + uid : ''}`}
                  >
                    {isChainHead ? <div className="chainTag head">H</div> : null}
                    {isChainTail ? <div className="chainTag tail">T</div> : null}
                    <div className="label" style={{ color: fg }}>{obj ? shortLabel(obj) : ''}</div>
                    {stack > 1 ? (
                      <div className="stackBadge" title="같은 칸에 여러 레이어로 블록이 쌓여있습니다">
                        ×{stack}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </div>

          <div className="small">
            좌표: (0,0)은 최하단 좌측입니다. (y는 아래가 0)
          </div>
        </div>
      </div>

      {/* Right: properties */}
      <div className="panel panelRight">
        <div className="rightHeader">
          <h3 style={{ margin: 0 }}>스테이지 설정</h3>
        </div>

        {/* ✅ 스테이지 설정 영역은 스크롤(내용 길이 변동) */}
        <div className="rightScroll">
          <div className="kv">
            <div className="small">id</div>
            <div>
              <b>{stage.id}</b>
            </div>
          </div>

          <div className="hr" />

          <DraftNumField stageId={stage.id} field="meta.blockCount" label="blockCount (총 블록 수)" value={stage.meta.blockCount} onCommit={(v) => setMeta({ blockCount: v })} />
          <DraftNumField stageId={stage.id} field="meta.layerCount" label="layerCount (보드 레이어 수)" value={stage.meta.layerCount} onCommit={(v) => setMeta({ layerCount: v })} />
          <NumField label="colorCount (사용 색상 개수)-(자동계산)" value={stage.meta.colorCount} onChange={() => {}} disabled />
          <DraftNumField stageId={stage.id} field="meta.slotCount" label="slotCount (캐넌 장착 슬롯 수)" value={stage.meta.slotCount} onCommit={(v) => setMeta({ slotCount: v })} />
          <DraftNumField stageId={stage.id} field="meta.waitLineCount" label="waitLineCount (캐넌 대기 라인 수)" value={stage.meta.waitLineCount} onCommit={(v) => setMeta({ waitLineCount: v })} />

          <div className="hr" />

          <DraftNumField
            stageId={stage.id}
            field="meta.connectShooterCount"
            label="connectShooterCount (커넷 슈터 개수)"
            value={stage.meta.connectShooterCount}
            onCommit={(v) => setMeta({ connectShooterCount: v })}
          />
          <DraftNumField
            stageId={stage.id}
            field="meta.hiddenShooterCount"
            label="hiddenShooterCount (히든 슈터 개수)"
            value={stage.meta.hiddenShooterCount}
            onCommit={(v) => setMeta({ hiddenShooterCount: v })}
          />
          {/* ✅ 자물쇠 유닛 카운터(자동): KEY 블럭 개수 기반 */}
          <NumField label="lockShooterCount (KEY 기반 자동)" value={stage.meta.lockShooterCount} onChange={() => {}} disabled />
          <NumField label="ammoMin (탄약 최소)-(자동 추천)" value={stage.meta.ammoMin} onChange={(v) => setMeta({ ammoMin: v })} disabled />
          <NumField label="ammoMax (탄약 최대)-(수동)" value={stage.meta.ammoMax} onChange={(v) => setMeta({ ammoMax: v })} />
          <DraftNumField stageId={stage.id} field="meta.seed" label="seed (랜덤 시드)" value={stage.meta.seed ?? 0} onCommit={(v) => setMeta({ seed: v })} />
          <DraftNumField stageId={stage.id} field="meta.pickerCols" label="pickerCols (피커 열 수)" value={stage.meta.pickerCols} onCommit={(v) => setMeta({ pickerCols: v })} />
          <NumField label="pickerMaxCards (피커 최대 카드 수)-(자동계산)" value={stage.meta.pickerMaxCards} onChange={() => {}} disabled />

          {/* ✅ 공급/해석 UI는 제거했습니다. */}
        </div>

        {/* ✅ 하단 2영역은 항상 같은 자리/높이(완전 고정 레이아웃) */}
        <div className="rightBottom">
          <Accordion title="선택 오브젝트" open={accSelectedOpen} onToggle={() => setAccSelectedOpen((v) => !v)}>
            <div className="fixedBox fixedSelectedBox">
              {(selRect != null || multiSelUidsArr.length > 0) ? (
                bulkSelUids.length > 0 ? (
                  <div style={{ display: 'grid', gap: 10 }}>
                    <div className="badge">
                      {selRect
                        ? `선택 영역: ${bulkSelUids.length}개 오브젝트 · ${Math.max(0, (selRect.x1 - selRect.x0 + 1) * (selRect.y1 - selRect.y0 + 1))}칸`
                        : `다중 선택: ${bulkSelUids.length}개 오브젝트`}
                    </div>

                    <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                      <button
                        className="btn"
                        onClick={() => {
                          setSelRect(null);
                          setSelGhost(null);
                          setSelectedUid(null);
                          setMultiSelUids(new Set());
                        }}
                      >
                        선택 해제
                      </button>
                    </div>

                    <div className="hr" />

                    <div style={{ display: 'grid', gap: 8 }}>
                      <div className="small" style={{ opacity: 0.85 }}>
                        • 컬러 일괄: 현재 팔레트 색상({COLOR_LABEL[color]} · {color})을 선택된 오브젝트에 적용
                      </div>
                      <button
                        className="btn"
                        disabled={bulkSelColorUids.length === 0}
                        onClick={() => {
                          if (bulkSelColorUids.length === 0) return;
                          bulkUpdateObjects(bulkSelColorUids, { color } as any);
                        }}
                        title={bulkSelColorUids.length === 0 ? '선택된 오브젝트 중 색상을 갖는 대상이 없습니다' : `컬러 적용 대상: ${bulkSelColorUids.length}개`}
                      >
                        컬러 일괄 적용 ({bulkSelColorUids.length})
                      </button>

                      <div className="hr" />

                      <div className="small" style={{ opacity: 0.85 }}>
                        • HP 일괄: 라지(2x2) 및 생성박스(2x2)에 hp 적용
                      </div>
                      <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                        <input
                          type="text"
                          inputMode="numeric"
                          value={bulkHpDraft}
                          onChange={(e) => {
                            const v = e.target.value;
                            if (/^-?\d*$/.test(v)) setBulkHpDraft(v);
                          }}
                          onBlur={() => {
                            const n = parseDraftInt(bulkHpDraft);
                            if (n == null) {
                              // 입력이 비어있으면 기존 값으로 복구
                              setBulkHpDraft(String(bulkHp));
                              return;
                            }
                            setBulkHp(n);
                            setBulkHpDraft(String(n));
                          }}
                          style={{ width: 110 }}
                          title="적용할 HP"
                        />
                        <button
                          className="btn"
                          disabled={bulkSelHpUids.length === 0}
                          onClick={() => {
                            if (bulkSelHpUids.length === 0) return;
                            const n = parseDraftInt(bulkHpDraft);
                            if (n == null) return;
                            bulkUpdateObjects(bulkSelHpUids, { hp: n } as any);
                          }}
                          title={bulkSelHpUids.length === 0 ? '선택된 오브젝트 중 HP 대상이 없습니다' : `HP 적용 대상: ${bulkSelHpUids.length}개`}
                        >
                          HP 일괄 적용 ({bulkSelHpUids.length})
                        </button>
                      </div>
                    </div>

                    <div className="small" style={{ opacity: 0.7, lineHeight: 1.4 }}>
                      ※ x/y 좌표는 일괄 수정 대상이 아닙니다. (게임 로직/힌트 순서 안정성)
                    </div>
                  </div>
                ) : (
                  <div className="small">
                    선택은 존재하지만(영역/다중) 오브젝트가 없습니다.{' '}
                    <button className="btn" onClick={() => { setSelRect(null); setSelGhost(null); setMultiSelUids(new Set()); }}>
                      선택 해제
                    </button>
                  </div>
                )
              ) : selectedUid ? (
                <SelectedObjectEditor obj={selectedObj} onChange={(patch) => updateSelectedObject(patch as any)} onDeselect={() => setSelectedUid(null)} />
              ) : (
                <div className="small">
                  SELECT 모드에서 드래그(사각형 선택) 또는 Ctrl/Cmd+클릭(중복 선택)을 해주세요.
                </div>
              )}
            </div>
          </Accordion>

          <Accordion title="검증 결과" open={accIssuesOpen} onToggle={() => setAccIssuesOpen((v) => !v)}>
            <div className="fixedBox fixedIssuesBox">
              {issues.length === 0 ? (
                <div className="small">문제 없음</div>
              ) : (
                <>
                  <label className="row" style={{ alignItems: 'center', gap: 8, marginBottom: 6 }}>
                    <input type="checkbox" checked={issueHighlightMode} onChange={(e) => setIssueHighlightMode(e.target.checked)} />
                    문제 셀 하이라이트
                  </label>

                  <div style={{ display: 'grid', gap: 6 }}>
                    {issues.map((it, i) => (
                      <div
                        key={i}
                        className={`notice ${it.level === 'error' ? 'error' : ''} ${it.at ? 'clickable' : ''}`}
                        onClick={() => {
                          if (!it.at) return;
                          // 이슈 좌표는 '초기 보드' 기준이므로 빠르게 초기 편집으로 이동
                          if (editTarget.kind !== 'INITIAL') setEditTarget({ kind: 'INITIAL' });
                          const now = Date.now();
                          setFocusIssueAt({ x: it.at.x, y: it.at.y, t: now });
                          window.setTimeout(() => setFocusIssueAt(null), 1200);
                        }}
                        title={it.at ? `클릭: (${it.at.x},${it.at.y}) 하이라이트` : undefined}
                      >
                        <b>{it.level === 'error' ? '에러' : '경고'}</b> — {it.msg}
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          </Accordion>
        </div>
      </div>


      {/* ✅ 특수 오브젝트 배치 모달(HP/색상) */}
      {placeModal ? (
        <div className="modalOverlay" onPointerDown={() => setPlaceModal(null)}>
          <div className="modal" style={{ width: 'min(560px, 100%)' }} onPointerDown={(e) => e.stopPropagation()}>
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
              <b>
                {placeModal.brush === 'BLOCK_LARGE' ? '라지 블럭(2x2) 설정' : null}
                {placeModal.brush === 'BLOCK_LARGE_HIDDEN' ? '라지 히든 블럭(2x2) 설정' : null}
                {placeModal.brush === 'SPAWNER_BOX' ? '생성 박스(2x2) 설정' : null}
              </b>
              <button className="btn" onClick={() => setPlaceModal(null)}>
                닫기
              </button>
            </div>

            <div className="small" style={{ opacity: 0.8, marginTop: 6, lineHeight: 1.35 }}>
              배치 위치: ({placeModal.x},{placeModal.y})
            </div>

            <div className="hr" />

            {(placeModal.brush === 'BLOCK_LARGE' || placeModal.brush === 'BLOCK_LARGE_HIDDEN') ? (
              <div style={{ display: 'grid', gap: 10 }}>
                <div className="small" style={{ opacity: 0.85 }}>
                  HP(블럭 수)를 입력하세요. (입력 중에는 빈칸/음수도 허용)
                </div>
                <input
                  ref={placeHpRef}
                  type="text"
                  inputMode="numeric"
                  value={largeHpDraft}
                  onChange={(e) => {
                    const v = e.target.value;
                    if (/^-?\d*$/.test(v)) setLargeHpDraft(v);
                  }}
                  onKeyDown={(e) => {
                    if (e.key !== 'Enter') return;
                    // Enter=적용
                    const hp = parseDraftInt(largeHpDraft);
                    if (hp == null) return;
                    if (placeModal.brush === 'BLOCK_LARGE') setBrushConfig({ largeHp: hp });
                    else setBrushConfig({ largeHiddenHp: hp });
                    const { x, y } = placeModal;
                    setPlaceModal(null);
                    clickCell(x, y);
                  }}
                  placeholder="예: 80"
                  style={{ width: 160 }}
                />
              </div>
            ) : null}

            {placeModal.brush === 'SPAWNER_BOX' ? (
              <div style={{ display: 'grid', gap: 12 }}>
                <div>
                  <div className="small" style={{ opacity: 0.85, marginBottom: 6 }}>
                    HP(총 생성량)
                  </div>
                  <input
                    ref={placeHpRef}
                    type="text"
                    inputMode="numeric"
                    value={spawnerHpDraft}
                    onChange={(e) => {
                      const v = e.target.value;
                      if (/^-?\d*$/.test(v)) setSpawnerHpDraft(v);
                    }}
                    onKeyDown={(e) => {
                      if (e.key !== 'Enter') return;
                      const hp = parseDraftInt(spawnerHpDraft);
                      if (hp == null) return;
                      setBrushConfig({ spawnerHp: hp, spawnerLeft, spawnerRight });
                      const { x, y } = placeModal;
                      setPlaceModal(null);
                      clickCell(x, y);
                    }}
                    placeholder="예: 10"
                    style={{ width: 160 }}
                  />
                </div>

                <div className="row" style={{ gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                  <div>
                    <div className="small" style={{ opacity: 0.85, marginBottom: 6 }}>왼쪽 컬러</div>
                    <select value={spawnerLeft} onChange={(e) => setSpawnerLeft(e.target.value as any)}>
                      {COLOR_UI.map((c) => (
                        <option key={c} value={c}>
                          {c} ({COLOR_LABEL[c]})
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <div className="small" style={{ opacity: 0.85, marginBottom: 6 }}>오른쪽 컬러</div>
                    <select value={spawnerRight} onChange={(e) => setSpawnerRight(e.target.value as any)}>
                      {COLOR_UI.map((c) => (
                        <option key={c} value={c}>
                          {c} ({COLOR_LABEL[c]})
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <div className="small" style={{ opacity: 0.75, lineHeight: 1.35 }}>
                  • 툴 표시: 좌측 2칸은 왼쪽 컬러, 우측 2칸은 오른쪽 컬러로 칠해집니다.<br />
                  • 런타임: poolColors[0]=왼쪽 고정, poolColors[1]=오른쪽 고정
                </div>
              </div>
            ) : null}

            <div className="hr" />

            <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
              <button className="btn" onClick={() => setPlaceModal(null)}>
                취소
              </button>
              <button
                className="btn primary"
                disabled={
                  (placeModal.brush === 'BLOCK_LARGE' || placeModal.brush === 'BLOCK_LARGE_HIDDEN')
                    ? parseDraftInt(largeHpDraft) == null
                    : placeModal.brush === 'SPAWNER_BOX'
                      ? parseDraftInt(spawnerHpDraft) == null
                      : false
                }
                onClick={() => {
                  if (!placeModal) return;
                  const { brush: b, x, y } = placeModal;

                  if (b === 'BLOCK_LARGE' || b === 'BLOCK_LARGE_HIDDEN') {
                    const hp = parseDraftInt(largeHpDraft);
                    if (hp == null) return;
                    if (b === 'BLOCK_LARGE') setBrushConfig({ largeHp: hp });
                    else setBrushConfig({ largeHiddenHp: hp });
                  }

                  if (b === 'SPAWNER_BOX') {
                    const hp = parseDraftInt(spawnerHpDraft);
                    if (hp == null) return;
                    setBrushConfig({ spawnerHp: hp, spawnerLeft, spawnerRight });
                  }

                  setPlaceModal(null);
                  clickCell(x, y);
                }}
              >
                적용 후 배치
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* ✅ 체인 블럭 배치(머리 방향 선택) 모달 */}
      {chainModal ? (
        <div
          className="modalOverlay"
          onPointerDown={() => {
            // 오버레이 클릭 = 취소(라인 시작점도 정리)
            setChainModal(null);
            cancelChainLine();
          }}
        >
          <div className="modal" style={{ width: 'min(520px, 100%)' }} onPointerDown={(e) => e.stopPropagation()}>
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
              <b>체인 블럭(1xN) 머리 방향</b>
              <button
                className="btn"
                onClick={() => {
                  setChainModal(null);
                  cancelChainLine();
                }}
              >
                닫기
              </button>
            </div>

            <div className="small" style={{ opacity: 0.8, marginTop: 6, lineHeight: 1.35 }}>
              배치 라인: y={chainModal.y}, x={chainModal.x0}..{chainModal.x1}
            </div>

            <div className="hr" />

            <div style={{ display: 'grid', gap: 10 }}>
              <div className="small" style={{ opacity: 0.85 }}>
                체인의 머리가 어느 쪽인지 선택하세요.
              </div>

              <div className="row" style={{ gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                <label className="row" style={{ gap: 6, alignItems: 'center' }}>
                  <input
                    type="radio"
                    checked={chainHeadSideDraft === 'LEFT'}
                    onChange={() => setChainHeadSideDraft('LEFT')}
                  />
                  머리: 왼쪽
                </label>
                <label className="row" style={{ gap: 6, alignItems: 'center' }}>
                  <input
                    type="radio"
                    checked={chainHeadSideDraft === 'RIGHT'}
                    onChange={() => setChainHeadSideDraft('RIGHT')}
                  />
                  머리: 오른쪽
                </label>
              </div>
            </div>

            <div className="hr" />

            <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
              <button
                className="btn"
                onClick={() => {
                  setChainModal(null);
                  cancelChainLine();
                }}
              >
                취소
              </button>
              <button
                className="btn primary"
                onClick={() => {
                  if (!chainModal) return;
                  // 선택한 방향을 다음 배치에도 기억
                  setBrushConfig({ chainHeadSide: chainHeadSideDraft } as any);
                  const { endX, endY } = chainModal;
                  setChainModal(null);
                  clickCell(endX, endY);
                }}
              >
                적용 후 배치
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* Help modal */}
      {helpOpen ? (
        <div className="modalOverlay" onPointerDown={() => setHelpOpen(false)}>
          <div className="modal" onPointerDown={(e) => e.stopPropagation()}>
            <h3 style={{ margin: 0 }}>도움말</h3>
            <div className="small" style={{ opacity: 0.85, marginTop: 4 }}>
              자주 쓰는 기능/단축키만 간단히 정리했습니다.
            </div>

            <div className="hr" />

            <div style={{ display: 'grid', gap: 8 }}>
              <div>
                <b>단축키</b>
                <div className="small" style={{ marginTop: 4, lineHeight: 1.5 }}>
                  • Ctrl+Z / Ctrl+Y(또는 Ctrl+Shift+Z): Undo / Redo<br />
	                  • Q: 툴 순환(그리기 → 지우기 → 선택)<br />
	                  • (SELECT) 드래그: 선택영역 만들기<br />
	                  • (SELECT) Ctrl/Cmd+클릭: 중복 선택(다중 선택)<br />
	                  • (SELECT) 선택영역 안에서 드래그: 드래그-복사(복제 붙여넣기)<br />
	                  • (SELECT) 셀 클릭: 붙여넣기 기준점 지정<br />
	                  • (SELECT) Ctrl+C / Ctrl+V: 선택영역 복사 / 붙여넣기<br />
                  • 1~{visibleBrushes.length}: 브러시 변경<br />
                  • ESC: 선택 모드로 전환<br />
                  • Alt+클릭: 스포이드(찍힌 오브젝트에서 브러시/색 가져오기)<br />
                  • 우클릭 드래그: 지우기<br />
                  • Shift+드래그: 사각형 채우기 / (우클릭이면) 사각형 지우기
	                  <br />
	                  • (숫자 입력) 휠/↑↓: ±1, Shift+휠/Shift+↑↓: ±10
                </div>
              </div>
            </div>

            <div className="hr" />

            <div className="row" style={{ justifyContent: 'flex-end' }}>
              <button className="btn primary" onClick={() => setHelpOpen(false)}>닫기</button>
            </div>
          </div>
        </div>
      ) : null}

      {/* replay(간이 플레이) modal */}
      {replayOpen ? (
        <div className="modalOverlay" onPointerDown={() => setReplayOpen(false)}>
          <div
            className="modal"
            style={{ width: 'min(1100px, 100%)', maxHeight: 'min(90vh, 980px)' }}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
              <b>간이 플레이(리플레이) (stage {stage.id})</b>
              <button className="btn" onClick={() => setReplayOpen(false)}>
                닫기
              </button>
            </div>

            <div className="small" style={{ opacity: 0.85, marginTop: 6, lineHeight: 1.45 }}>
              W1 클릭 → 슈팅라인(S) 장착 → 자동 발사 루프를 headless Board/StageCompiler로 돌려,
              실제 게임 진행 흐름을 “시간축”으로 확인합니다.
            </div>

            <div className="row" style={{ gap: 12, marginTop: 10 }}>
              <label className="row" style={{ alignItems: 'center', gap: 8 }}>
                <span className="small">기록</span>
                <select
                  value={replayDetail}
                  onChange={(e) => setReplayDetail(e.target.value as ReplayDetail)}
                  title="compact: 클릭/빈슬롯/종료 중심, round: 매 발사 라운드까지 기록"
                >
                  <option value="compact">compact</option>
                  <option value="round">round</option>
                </select>
              </label>

              <label className="row" style={{ alignItems: 'center', gap: 8 }}>
                <input type="checkbox" checked={replayStrictHint} onChange={(e) => setReplayStrictHint(e.target.checked)} />
                hintStep 순서대로만 클릭
              </label>
            </div>

            <div className="hr" />

            {replayRunning ? (
              <div className="small">리플레이 생성 중…</div>
            ) : replayErr ? (
              <div className="notice error">{replayErr}</div>
            ) : replayRes ? (
              (() => {
                const frames = replayRes.frames ?? [];
                const cur = frames[Math.max(0, Math.min(replayIdx, frames.length - 1))];

                const eventText = (() => {
                  if (!cur) return '—';
                  const ev: any = cur.event;
                  if (!ev) return '—';
                  if (ev.type === 'CLICK') return `CLICK: hintStep=${ev.hintStep}  W1[col=${ev.col}] → S[${ev.shooterIdx}]  ${ev.token} ammo=${ev.ammo}`;
                  if (ev.type === 'ROUND') return `ROUND #${ev.round}: fired=${ev.fired}`;
                  if (ev.type === 'STUCK') return `STUCK: ${ev.reason}`;
                  if (ev.type === 'END') return `END: ${ev.status}`;
                  return String(ev.type);
                })();

                const renderCell = (cell: any, key: string) => {
                  if (!cell) {
                    return (
                      <div
                        key={key}
                        style={{
                          width: 18,
                          height: 18,
                          borderRadius: 3,
                          border: '1px solid rgba(0,0,0,0.06)',
                          background: '#f9fafb',
                        }}
                      />
                    );
                  }
                  const token = String(cell.token ?? '?');
                  const special = cell.special ? String(cell.special) : '';
                  const hidden = !!cell.hidden;

                  // 색상 규칙(툴 편집 팔레트와 최대한 동일하게)
                  let bg = (COLOR_HEX as any)[token] ?? '#111827';
                  if (hidden) bg = '#7f8c8d';
                  if (special === 'CHAIN') bg = '#2c3e50';
                  if (special === 'KEY') bg = '#f1c40f';
                  if (special === 'SPAWNER') bg = '#16a085';

                  const fg = isLightHex(bg) ? '#111' : '#fff';
                  const isBig = !!cell.isBig;
                  const hp = Math.max(0, (cell.hp ?? 0) | 0);

                  return (
                    <div
                      key={key}
                      title={`${token}${special ? ' ' + special : ''}${hidden ? ' (hidden)' : ''}${isBig ? ' BIG' : ''}${hp > 0 ? ' HP' + hp : ''}`}
                      style={{
                        width: 18,
                        height: 18,
                        borderRadius: 3,
                        border: '1px solid rgba(0,0,0,0.06)',
                        background: bg,
                        color: fg,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontSize: 10,
                        lineHeight: 1,
                        fontWeight: 700,
                      }}
                    >
                      {token}
                    </div>
                  );
                };

                const renderCard = (c: any, key: string, mode: 'WAIT' | 'SHOOT') => {
                  if (!c) {
                    return (
                      <div
                        key={key}
                        style={{
                          width: 56,
                          height: 34,
                          borderRadius: 8,
                          border: '1px solid rgba(0,0,0,0.08)',
                          background: 'transparent',
                        }}
                      />
                    );
                  }
                  const token = String(c.token ?? '?');
                  const bg = (COLOR_HEX as any)[token] ?? '#111827';
                  const fg = isLightHex(bg) ? '#111' : '#fff';
                  const hint = (c.hintStep ?? 0) | 0;
                  const ammo = (c.ammo ?? 0) | 0;
                  const sc = (c.shotCount ?? 1) | 0;

                  return (
                    <div
                      key={key}
                      title={`${token} hint=${hint} ammo=${ammo} shotCount=${sc}`}
                      style={{
                        width: 56,
                        height: 34,
                        borderRadius: 8,
                        border: '1px solid rgba(0,0,0,0.08)',
                        background: bg,
                        color: fg,
                        padding: '4px 6px',
                        display: 'grid',
                        alignContent: 'center',
                        gap: 1,
                        fontSize: 11,
                        fontWeight: 700,
                      }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <span>{token}</span>
                        <span style={{ opacity: 0.95 }}>#{hint}</span>
                      </div>
                      <div style={{ fontSize: 10, fontWeight: 600, opacity: 0.95 }}>
                        {mode === 'SHOOT' ? `ammo ${ammo}` : `ammo ${ammo}`} · x{Math.max(1, sc)}
                      </div>
                    </div>
                  );
                };

                return (
                  <>
                    <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                      <span className={`badge ${replayRes.status === 'SOLVED' ? '' : replayRes.status === 'STUCK' ? 'error' : ''}`}>
                        status: {replayRes.status}
                      </span>
                      <span className="badge">frames: {frames.length}</span>
                      <span className="badge">clicked: {replayRes.clicked}</span>
                      <span className="badge">rounds: {replayRes.rounds}</span>
                      <span className="badge">shots: {replayRes.shotsFired}</span>
                      <span className="badge">nextHint: {replayRes.nextHint}</span>
                      {replayRes.reason ? <span className="badge error">reason: {replayRes.reason}</span> : null}
                    </div>

                    <div className="small" style={{ marginTop: 8, opacity: 0.9 }}>
                      {eventText}
                    </div>

                    <div className="row" style={{ gap: 8, marginTop: 10, alignItems: 'center' }}>
                      <button
                        className="btn"
                        onClick={() => setReplayIdx((v) => Math.max(0, v - 1))}
                        disabled={frames.length <= 0 || replayIdx <= 0}
                      >
                        ◀
                      </button>
                      <input
                        type="range"
                        min={0}
                        max={Math.max(0, frames.length - 1)}
                        value={Math.max(0, Math.min(replayIdx, Math.max(0, frames.length - 1)))}
                        onChange={(e) => setReplayIdx(Number(e.target.value))}
                        style={{ flex: 1 }}
                      />
                      <button
                        className="btn"
                        onClick={() => setReplayIdx((v) => Math.min(Math.max(0, frames.length - 1), v + 1))}
                        disabled={frames.length <= 0 || replayIdx >= frames.length - 1}
                      >
                        ▶
                      </button>
                      <span className="badge">
                        {frames.length > 0 ? `${Math.max(0, Math.min(replayIdx, frames.length - 1)) + 1}/${frames.length}` : '0/0'}
                      </span>
                    </div>

                    {cur ? (
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 420px', gap: 14, marginTop: 12 }}>
                        {/* Board */}
                        <div>
                          <div className="row" style={{ justifyContent: 'space-between' }}>
                            <span className="badge">remaining: {cur.board.remaining}</span>
                            <span className="badge">rows×cols: {cur.board.rows}×{cur.board.cols}</span>
                          </div>
                          <div
                            style={{
                              marginTop: 8,
                              display: 'grid',
                              gridTemplateColumns: `repeat(${cur.board.cols}, 18px)`,
                              gridTemplateRows: `repeat(${cur.board.rows}, 18px)`,
                              gap: 2,
                              padding: 8,
                              border: '1px solid rgba(0,0,0,0.08)',
                              borderRadius: 10,
                              background: 'rgba(0,0,0,0.02)',
                              width: 'fit-content',
                              maxWidth: '100%',
                              overflow: 'auto',
                            }}
                          >
                            {/* y=0 bottom 이므로, 화면에서는 위가 y=max (기존 편집 보드와 동일) */}
                            {Array.from({ length: cur.board.rows * cur.board.cols }, (_, idx) => {
                              const x = idx % cur.board.cols;
                              const viewY = (idx / cur.board.cols) | 0;
                              const y = cur.board.rows - 1 - viewY;
                              const cell = cur.board.cells[y * cur.board.cols + x];
                              return renderCell(cell, `${x},${y}`);
                            })}
                          </div>
                        </div>

                        {/* Lines */}
                        <div style={{ display: 'grid', gap: 10 }}>
                          <div>
                            <div className="badge">Shooter(S)</div>
                            <div className="row" style={{ marginTop: 6, gap: 6 }}>
                              {cur.shooter.map((c, i) => renderCard(c, `S${i}`, 'SHOOT'))}
                            </div>
                          </div>

                          <div>
                            <div className="badge">Waiting(W1/W2/W3) · cols={cur.waiting.cols}</div>
                            <div style={{ display: 'grid', gap: 6, marginTop: 6 }}>
                              <div>
                                <div className="small" style={{ opacity: 0.85 }}>W1</div>
                                <div className="row" style={{ gap: 6, marginTop: 4 }}>
                                  {cur.waiting.w1.map((c, i) => renderCard(c, `W1${i}`, 'WAIT'))}
                                </div>
                              </div>
                              {cur.waiting.waitLineCount >= 2 ? (
                                <div>
                                  <div className="small" style={{ opacity: 0.85 }}>W2</div>
                                  <div className="row" style={{ gap: 6, marginTop: 4 }}>
                                    {cur.waiting.w2.map((c, i) => renderCard(c, `W2${i}`, 'WAIT'))}
                                  </div>
                                </div>
                              ) : null}
                              {cur.waiting.waitLineCount >= 3 ? (
                                <div>
                                  <div className="small" style={{ opacity: 0.85 }}>W3</div>
                                  <div className="row" style={{ gap: 6, marginTop: 4 }}>
                                    {cur.waiting.w3.map((c, i) => renderCard(c, `W3${i}`, 'WAIT'))}
                                  </div>
                                </div>
                              ) : null}
                            </div>

                            <div className="small" style={{ marginTop: 8, opacity: 0.9 }}>
                              overflow: {cur.waiting.overflowCounts.map((n, i) => `C${i}:${n}`).join('  ')}
                            </div>
                          </div>
                        </div>
                      </div>
                    ) : null}
                  </>
                );
              })()
            ) : (
              <div className="small">결과 없음</div>
            )}

            <div className="hr" />
            <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
              <button
                className="btn"
                onClick={async () => {
                  setReplayErr(null);
                  setReplayRes(null);
                  setReplayIdx(0);
                  setReplayRunning(true);
                  try {
                    const r = await simulateStageReplay(stage as any, {
                      detail: replayDetail,
                      strictHintOrder: replayStrictHint,
                      maxRounds: 200000,
                      maxShots: 2000000,
                    });
                    setReplayRes(r);
                    setReplayIdx(0);
                  } catch (e: any) {
                    setReplayErr(String(e?.message ?? e));
                  } finally {
                    setReplayRunning(false);
                  }
                }}
                disabled={replayRunning}
              >
                다시 실행
              </button>

              {replayRes && replayRes.status !== 'SOLVED' ? (
                <button
                  className="btn danger"
                  onClick={async () => {
                    setReplayErr(null);
                    setReplayRunning(true);
                    try {
                      const { stage: fixedStage, replay, report } = await repairStageUntilReplaySolved(stage as any, {
                        maxIters: 800,
                        maxRounds: 200000,
                        maxShots: 2000000,
                      });

                      // ✅ 편집 데이터에도 그대로 반영 (Undo 가능)
                      replaceCurrentStage(fixedStage as any);

                      // 결과를 바로 타임라인으로 확인(프레임 캡처)
                      const r = await simulateStageReplay(fixedStage as any, {
                        detail: replayDetail,
                        strictHintOrder: replayStrictHint,
                        maxRounds: 200000,
                        maxShots: 2000000,
                      });
                      setReplayRes(r);
                      setReplayIdx(0);

                      if (replay?.status !== 'SOLVED') {
                        setReplayErr(`자동 수정 실패: ${String(replay?.status ?? 'UNKNOWN')} ${String(replay?.reason ?? '')}`);
                      }

                      // 디버그 필요하면 아래 콘솔 로그를 활성화하세요.
                      console.log('[ReplayRepair] applied', { stageId: stage.id, iters: report?.iters, status: replay?.status, reason: replay?.reason });
                    } catch (e: any) {
                      setReplayErr(String(e?.message ?? e));
                    } finally {
                      setReplayRunning(false);
                    }
                  }}
                  disabled={replayRunning}
                  title="리플레이(실제 게임 흐름) 기준으로 카드 순서를 자동 수정해서 SOLVED 될 때까지 재검증합니다."
                >
                  자동 수정(리플레이)
                </button>
              ) : null}
              <button
                className="btn primary"
                onClick={() => {
                  try {
                    navigator.clipboard?.writeText(JSON.stringify(replayRes ?? {}, null, 2));
                  } catch {}
                }}
                disabled={!replayRes}
                title="리플레이 JSON(프레임 포함)을 클립보드에 복사"
              >
                JSON 복사
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* Saved Layer Slot modal */}
      {layerSlotOpen !== null ? (
        <div className="modalOverlay" onPointerDown={() => setLayerSlotOpen(null)}>
          <div className="modal" onPointerDown={(e) => e.stopPropagation()}>
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
              <b>저장레이어 {layerSlotOpen + 1}</b>
              <button className="btn" onClick={() => setLayerSlotOpen(null)}>닫기</button>
            </div>

            {savedLayers[layerSlotOpen] ? (
              <>
                <div className="small" style={{ opacity: 0.85, marginTop: 6 }}>
                  레이어: L{savedLayers[layerSlotOpen]!.layer}
                </div>

                <div style={{ marginTop: 10, border: '1px solid rgba(255,255,255,0.12)', borderRadius: 8, padding: 8 }}>
                  <MiniLayerPreview objects={savedLayers[layerSlotOpen]!.objects} />
                </div>

                <div className="row" style={{ gap: 8, marginTop: 12, justifyContent: 'flex-end' }}>
                  <button
                    className="btn"
                    onClick={() => {
                      setClipboardFromSavedLayer(layerSlotOpen);
                      setToolMode('SELECT');
                      setSelectedUid(null);
                      setLayerSlotOpen(null);
                    }}
                    title="저장된 레이어를 클립보드에 복사합니다(붙여넣기 Ctrl+V)"
                  >
                    복사
                  </button>
                  <button
                    className="btn danger"
                    onClick={() => {
                      setSavedLayers((prev) => {
                        const next = prev.slice();
                        next[layerSlotOpen] = null;
                        return next;
                      });
                      setLayerSlotOpen(null);
                    }}
                  >
                    삭제
                  </button>
                </div>
              </>
            ) : (
              <div className="small" style={{ opacity: 0.85, marginTop: 12 }}>비어있음</div>
            )}
          </div>
        </div>
      ) : null}

      {/* Random stage generator modal */}
      {randOpen ? (
        <div className="modalOverlay" onPointerDown={() => (!randGenerating ? setRandOpen(false) : null)}>
          <div className="modal" onPointerDown={(e) => e.stopPropagation()}>
            <h3 style={{ margin: 0 }}>랜덤 스테이지 생성</h3>
            <div className="small" style={{ opacity: 0.85, marginTop: 4 }}>
              초기 보드(10×10)에 패턴을 찍고, blockCount에 맞춰 공급까지 자동 생성합니다. 생성 후에는 <b>repairStagePack</b> + <b>리플레이</b>로
              <b> SOLVED</b> 될 때까지 자동 보정합니다.
            </div>

            <div className="hr" />

            <div className="row" style={{ flexWrap: 'wrap', gap: 14 }}>
              <div style={{ minWidth: 160 }}>
                <div className="small" style={{ marginBottom: 4 }}>목표 blockCount</div>
                <input
                  type="number"
                  min={1}
                  value={randCfg.blockCount}
                  onChange={(e) => setRandCfg((p) => ({ ...p, blockCount: Number(e.target.value) }))}
                  style={{ width: 160 }}
                  disabled={randGenerating}
                />
                <div className="small" style={{ opacity: 0.7, marginTop: 4 }}>※ 자동으로 10의 배수로 올림될 수 있습니다.</div>
              </div>

              <div style={{ minWidth: 220 }}>
                <div className="small" style={{ marginBottom: 4 }}>난이도 (1~10)</div>
                <input
                  type="range"
                  min={1}
                  max={10}
                  step={1}
                  value={randCfg.difficulty}
                  onChange={(e) => setRandCfg((p) => ({ ...p, difficulty: Number(e.target.value) }))}
                  disabled={randGenerating}
                  style={{ width: 220 }}
                />
                <div className="small" style={{ opacity: 0.85 }}>선택: {randCfg.difficulty} (색상수: {Math.max(2, Math.min(6, 2 + Math.floor((randCfg.difficulty - 1) / 2)))})</div>
              </div>
            </div>

            <div className="hr" />

            <div className="row" style={{ gap: 14, flexWrap: 'wrap' }}>
              <div style={{ minWidth: 220 }}>
                <div className="small" style={{ marginBottom: 6 }}>패턴(초기 보드만)</div>
                <select
                  value={randCfg.pattern}
                  onChange={(e) => setRandCfg((p) => ({ ...p, pattern: e.target.value as PatternKey }))}
                  disabled={randGenerating}
                  style={{ width: 220 }}
                >
                  {randPatternGroups.map((g) => (
                    <optgroup key={g.group} label={g.group}>
                      {g.items.map((p) => (
                        <option key={p.key} value={p.key}>
                          {p.label}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>

                <label className="row" style={{ alignItems: 'center', gap: 8, marginTop: 10 }}>
                  <input
                    type="checkbox"
                    checked={!!randCfg.fillBackground}
                    onChange={(e) => setRandCfg((p) => ({ ...p, fillBackground: e.target.checked }))}
                    disabled={randGenerating}
                  />
                  배경도 채우기(패턴은 색/특수로 표현)
                </label>

                <div className="small" style={{ marginTop: 12, marginBottom: 6 }}>대칭</div>
                <select
                  value={(randCfg as any).symmetry ?? 'NONE'}
                  onChange={(e) => setRandCfg((p) => ({ ...(p as any), symmetry: e.target.value as any }))}
                  disabled={randGenerating}
                  style={{ width: 220 }}
                >
                  <option value="RANDOM">랜덤(좌우/상하)</option>
                  <option value="VERTICAL">좌우 대칭</option>
                  <option value="HORIZONTAL">상하 대칭</option>
                  <option value="NONE">없음</option>
                </select>
                <div className="small" style={{ opacity: 0.7, marginTop: 4 }}>※ 초기 보드 배치에만 영향</div>
              </div>

              <div style={{ border: '1px solid rgba(0,0,0,0.1)', borderRadius: 10, padding: 10 }}>
                <div className="small" style={{ marginBottom: 6, opacity: 0.8 }}>미리보기</div>
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(10, 10px)',
                    gridAutoRows: '10px',
                    gap: 2,
                  }}
                >
                  {getPatternRows(randCfg.pattern).flatMap((row, ri) =>
                    row.split('').map((ch, ci) => (
                      <div
                        key={`${ri}-${ci}`}
                        style={{
                          width: 10,
                          height: 10,
                          borderRadius: 2,
                          border: '1px solid rgba(0,0,0,0.08)',
                          background: ch === 'X' ? '#111827' : 'transparent',
                        }}
                      />
                    ))
                  )}
                </div>
              </div>
            </div>

            <div className="hr" />

            <div className="small" style={{ marginBottom: 8 }}>특수 블럭(체인/히든) 포함</div>
            <div className="row" style={{ flexWrap: 'wrap', gap: 14 }}>
              <label className="row" style={{ alignItems: 'center', gap: 8 }}>
                <input
                  type="checkbox"
                  checked={!!randCfg.includeChain}
                  onChange={(e) => setRandCfg((p) => ({ ...p, includeChain: e.target.checked }))}
                  disabled={randGenerating}
                />
                체인
              </label>
              <label className="row" style={{ alignItems: 'center', gap: 8 }}>
                <input
                  type="checkbox"
                  checked={!!randCfg.includeHidden}
                  onChange={(e) => setRandCfg((p) => ({ ...p, includeHidden: e.target.checked }))}
                  disabled={randGenerating}
                />
                히든
              </label>
            </div>

            <div className="small" style={{ marginTop: 12, marginBottom: 8 }}>추가 오브젝트(선택)</div>
            <div className="row" style={{ flexWrap: 'wrap', gap: 14 }}>
              <label className="row" style={{ alignItems: 'center', gap: 8 }}>
                <input
                  type="checkbox"
                  checked={!!randCfg.includeLarge}
                  onChange={(e) => setRandCfg((p) => ({ ...p, includeLarge: e.target.checked }))}
                  disabled={randGenerating}
                />
                빅(2×2)
              </label>
              <label className="row" style={{ alignItems: 'center', gap: 8 }}>
                <input
                  type="checkbox"
                  checked={!!randCfg.includeLargeHidden}
                  onChange={(e) => setRandCfg((p) => ({ ...p, includeLargeHidden: e.target.checked }))}
                  disabled={randGenerating || !randCfg.includeLarge}
                />
                빅 히든(2×2)
              </label>
              <label className="row" style={{ alignItems: 'center', gap: 8 }}>
                <input
                  type="checkbox"
                  checked={!!randCfg.includeSpawner}
                  onChange={(e) => setRandCfg((p) => ({ ...p, includeSpawner: e.target.checked }))}
                  disabled={randGenerating}
                />
                생성 박스
              </label>
              <label className="row" style={{ alignItems: 'center', gap: 8 }}>
                <input
                  type="checkbox"
                  checked={!!randCfg.includeKeyLock}
                  onChange={(e) => setRandCfg((p) => ({ ...p, includeKeyLock: e.target.checked }))}
                  disabled={randGenerating}
                />
                열쇠/자물쇠
              </label>
            </div>

            {randGenProg ? (
              <div className="small" style={{ marginTop: 12, opacity: 0.9 }}>
                진행: {randGenProg}
              </div>
            ) : null}

            {randGenErr ? (
              <div className="small" style={{ marginTop: 8, color: '#ef4444' }}>
                오류: {randGenErr}
              </div>
            ) : null}

            <div className="row" style={{ justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
              <button className="btn" onClick={() => setRandOpen(false)} disabled={randGenerating}>
                취소
              </button>
              <button className="btn primary" onClick={applyRandomStage} disabled={randGenerating}>
                {randGenerating ? '생성 중...' : '생성'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}


function Accordion(props: { title: string; open: boolean; onToggle: () => void; children: React.ReactNode }) {
  // ✅ 아코디언 (선택/검증 영역)
  // 역할: 영역 자체 높이를 고정(내부만 스크롤)하면서, 필요 시 접어서 UX를 안정적으로 만듭니다.
  return (
    <div className="accordion">
      <button type="button" className="accordionHeader" onClick={props.onToggle}>
        <span>{props.title}</span>
        <span className="accordionChevron" aria-hidden>
          {props.open ? '▾' : '▸'}
        </span>
      </button>
      {props.open ? <div className="accordionBody">{props.children}</div> : null}
    </div>
  );
}

function DraftNumField(props: { stageId: number; field: string; label: string; value: number; onCommit: (v: number) => void; disabled?: boolean }) {
  const numDraft = useStageTool((s) => s.numDraft);
  const setNumDraft = useStageTool((s) => s.setNumDraft);
  const clearNumDraft = useStageTool((s) => s.clearNumDraft);

  const key = `${props.stageId}:${props.field}`;
  const draft = numDraft[key];
  const view = draft !== undefined ? draft : String(props.value ?? '');

  return (
    <div style={{ marginBottom: 10 }}>
      <div className="kv" style={{ marginBottom: 4 }}>
        <div className="small">{props.label}</div>
        <input
          type="text"
          inputMode="numeric"
          value={view}
          disabled={!!props.disabled}
          onFocus={(e) => {
            try {
              (e.currentTarget as HTMLInputElement).select();
            } catch {}
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur();
          }}
          onChange={(e) => {
            const v = e.target.value;
            // ✅ 빈 문자열 허용, 숫자만 입력(음수도 허용)
            // 역할: 입력 중 강제로 1자리가 생기는 문제를 제거합니다.
            if (!/^-?\d*$/.test(v)) return;
            setNumDraft(key, v);
          }}
          onBlur={(e) => {
            const v = (e.currentTarget as HTMLInputElement).value.trim();
            if (v === '' || v === '-') return;
            const n = parseInt(v, 10);
            if (!Number.isFinite(n)) return;
            props.onCommit(n);
            // 커밋 후 draft 제거(=정규화된 stage 값으로 표시)
            clearNumDraft(key);
          }}
        />
      </div>
    </div>
  );
}

function NumField(props: { label: string; value: number; onChange: (v: number) => void; help?: string; disabled?: boolean }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div className="kv" style={{ marginBottom: 4 }}>
        <div className="small">{props.label}</div>
        <input
          type="number"
          value={props.value}
          disabled={!!props.disabled}
          onFocus={(e) => {
            try {
              (e.currentTarget as HTMLInputElement).select();
            } catch {}
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur();
          }}
          onChange={(e) => props.onChange(Number(e.target.value))}
        />
      </div>
      {/* 부가설명(help)은 UI를 복잡하게 만들어서 출력하지 않습니다. */}
    </div>
  );
}

function MiniLayerPreview(props: { objects: BoardObject[] }) {
  const occ = useMemo(() => {
    const m = new Map<string, BoardObject>();
    // 뒤에 있는 오브젝트가 위로 오도록(최근/마지막 우선)
    for (const o of props.objects) {
      for (const c of cellsOf(o)) m.set(`${c.x},${c.y}`, o);
    }
    return m;
  }, [props.objects]);

  const cells = [] as Array<{ x: number; y: number; obj: BoardObject | null }>;
  for (let y = 9; y >= 0; y--) {
    for (let x = 0; x < 10; x++) {
      cells.push({ x, y, obj: occ.get(`${x},${y}`) ?? null });
    }
  }

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(10, 14px)',
        gridTemplateRows: 'repeat(10, 14px)',
        gap: 2,
        justifyContent: 'start',
      }}
    >
      {cells.map((c, i) => {
        const bg = c.obj ? getCellBgHex(c.obj, c.x, c.y) : 'rgba(255,255,255,0.04)';
        return (
          <div
            key={i}
            title={c.obj ? `${shortLabel(c.obj)} @(${c.x},${c.y})` : `${c.x},${c.y}`}
            style={{ width: 14, height: 14, borderRadius: 3, background: bg, border: '1px solid rgba(0,0,0,0.2)' }}
          />
        );
      })}
    </div>
  );
}

function objHasColor(obj: BoardObject): obj is Extract<BoardObject, { color: Color12 }> {
  return obj.type === 'BLOCK_NORMAL' || obj.type === 'BLOCK_LARGE' || obj.type === 'CHAIN_BARRIER';
}

function shortLabel(obj: BoardObject): string {
  const safeInt = (v: any, fb: number) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.floor(n) : fb;
  };
  switch (obj.type) {
    case 'BLOCK_NORMAL':
      return obj.color;
    case 'BLOCK_LARGE':
      return `2x2 ${obj.color} HP${safeInt((obj as any).hp, 80)}`;
    case 'BLOCK_LARGE_HIDDEN':
      return `2x2 히든(${(obj as any).color ?? 'R'}) HP${safeInt((obj as any).hp, 80)}`;
    case 'PILLAR':
      return `기둥`;
    case 'BLOCK_HIDDEN':
      return `히든(${(obj as any).color ?? 'R'})`;
    case 'CHAIN_BARRIER':
      return `체인`;
    case 'KEY':
      return `열쇠`;
    case 'SPAWNER_BOX':
      return `박스 HP${safeInt((obj as any).hp, 10)}`;
    default:
      // 역할: 모든 타입에 대해 안전한 라벨 반환(타입 확장/누락 대비)
      return (obj as any).type ?? '';
  }
}

function SelectedObjectEditor(props: {
  obj: BoardObject | null;
  onChange: (patch: Partial<BoardObject>) => void;
  onDeselect: () => void;
}) {
  const { obj } = props;
  if (!obj) return <div className="small">선택한 오브젝트를 찾을 수 없습니다.</div>;

  const stageId = useStageTool((s) => s.currentStageId);

  return (
    <div style={{ display: 'grid', gap: 6 }}>
      <div className="badge">{obj.type}</div>

      <div className="row">
        <button className="btn" onClick={props.onDeselect}>선택 해제</button>
      </div>

      <DraftNumField
        stageId={stageId}
        field={`obj:${(obj as any).uid}:layer`}
        label="layer(레이어)"
        value={(obj as any).layer ?? 0}
        onCommit={(v) => {
          const n = Math.max(0, Math.min(4, Math.floor(v)));
          props.onChange({ layer: n } as any);
        }}
      />

      <div className="kv">
        <div className="small">x</div>
        <div><b>{obj.x}</b></div>
      </div>
      <div className="kv">
        <div className="small">y</div>
        <div><b>{obj.y}</b></div>
      </div>

      {obj.type === 'PILLAR' ? (
        <DraftNumField
          stageId={stageId}
          field={`obj:${(obj as any).uid}:h`}
          label="h"
          value={(obj as any).h ?? 1}
          onCommit={(v) => props.onChange({ h: Math.max(1, Math.floor(v)) } as any)}
        />
      ) : null}

      {(obj.type === 'BLOCK_NORMAL' || obj.type === 'BLOCK_LARGE' || obj.type === 'BLOCK_HIDDEN' || obj.type === 'BLOCK_LARGE_HIDDEN' || obj.type === 'CHAIN_BARRIER') ? (
        <div className="kv">
          <div className="small">color</div>
          <select value={obj.color} onChange={(e) => props.onChange({ color: e.target.value as any } as any)}>
            {COLOR12.map((c) => (
              <option key={c} value={c}>{COLOR_LABEL[c]}({c})</option>
            ))}
          </select>
        </div>
      ) : null}

      {obj.type === 'CHAIN_BARRIER' ? (
        <>
          <div className="kv">
            <div className="small">chainId</div>
            <input
              value={String((obj as any).chainId ?? '')}
              placeholder="(비우면 셀 단위 체인)"
              onChange={(e) => props.onChange({ chainId: e.target.value } as any)}
            />
          </div>
          <DraftNumField
            stageId={stageId}
            field={`obj:${(obj as any).uid}:chainOrder`}
            label="chainOrder"
            value={Number.isFinite((obj as any).chainOrder) ? Number((obj as any).chainOrder) : 0}
            onCommit={(v) => props.onChange({ chainOrder: Math.floor(v) } as any)}
          />
          <div className="small" style={{ opacity: 0.8 }}>
            • 같은 chainId만 1개의 체인으로 묶입니다(인접해도 chainId가 다르면 연결되지 않음)
            <br />
            • 권장: 1xN(가로)으로 연속 배치 + chainOrder=0..N-1
          </div>
        </>
      ) : null}

      {obj.type === 'KEY' ? (
        <div className="kv">
          <div className="small">keyId</div>
          <input value={obj.keyId} onChange={(e) => props.onChange({ keyId: e.target.value } as any)} />
        </div>
      ) : null}

      {obj.type === 'SPAWNER_BOX' ? (
        <>
          <DraftNumField
            stageId={stageId}
            field={`obj:${(obj as any).uid}:hp`}
            label="hp(생성 블럭 수)"
            value={(obj as any).hp ?? 10}
            onCommit={(v) => props.onChange({ hp: v } as any)}
          />
          <div className="kv">
            <div className="small">size</div>
            <div>
              <b>2x2</b>
            </div>
          </div>
          <div className="kv">
            <div className="small">좌/우 고정색(2색)</div>
            {(() => {
              const pool = Array.isArray((obj as any).spawn?.poolColors) ? ((obj as any).spawn.poolColors as any[]) : [];
              const c1 = (pool[0] ?? 'R') as any;
              const c2 = (pool[1] ?? c1) as any;
              return (
                <div style={{ display: 'flex', gap: 8 }}>
                  <div className="small" style={{ alignSelf: 'center' }}>L</div>
                  <select
                    value={c1}
                    onChange={(e) => {
                      const next1 = e.target.value as any;
                      props.onChange({ spawn: { ...(obj as any).spawn, poolColors: [next1, c2] } } as any);
                    }}
                  >
                    {COLOR12.map((c) => (
                      <option key={c} value={c}>{COLOR_LABEL[c]}({c})</option>
                    ))}
                  </select>
                  <div className="small" style={{ alignSelf: 'center' }}>R</div>
                  <select
                    value={c2}
                    onChange={(e) => {
                      const next2 = e.target.value as any;
                      props.onChange({ spawn: { ...(obj as any).spawn, poolColors: [c1, next2] } } as any);
                    }}
                  >
                    {COLOR12.map((c) => (
                      <option key={c} value={c}>{COLOR_LABEL[c]}({c})</option>
                    ))}
                  </select>
                </div>
              );
            })()}
          </div>
          <div className="small">(좌/우 고정색으로 생성됩니다)</div>
        </>
      ) : null}

      {(obj.type === 'BLOCK_HIDDEN' || obj.type === 'BLOCK_LARGE_HIDDEN') ? (
        <div className="kv">
          <div className="small">revealRule</div>
          <div><b>{obj.revealRule}</b></div>
        </div>
      ) : null}

      {(obj.type === 'BLOCK_LARGE' || obj.type === 'BLOCK_LARGE_HIDDEN') ? (
        <DraftNumField
          stageId={stageId}
          field={`obj:${(obj as any).uid}:hp`}
          label="hp(블럭 목표치)"
          value={(obj as any).hp ?? 80}
          onCommit={(v) => props.onChange({ hp: v } as any)}
        />
      ) : null}

      {(obj.type === 'BLOCK_LARGE' || obj.type === 'BLOCK_LARGE_HIDDEN') ? (
        <div className="kv">
          <div className="small">size</div>
          <div><b>{obj.w}x{obj.h}</b></div>
        </div>
      ) : null}
    </div>
  );
}