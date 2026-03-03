#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
STAGE_TOOL_ZIP="$ROOT_DIR/stage-tool-v9_patched_src_fixed21.zip"
GAME_ZIP="$ROOT_DIR/game_fixed_spawner_chain_under_fix.zip"
REPORT_JSON="$ROOT_DIR/stagepack_v2_replay_solved_fixed21_report.json"
OUT_JSON="${1:-}"

need_cmd() { command -v "$1" >/dev/null 2>&1 || { echo "missing command: $1" >&2; exit 2; }; }
need_cmd unzip
need_cmd python
need_cmd diff

for f in "$STAGE_TOOL_ZIP" "$GAME_ZIP" "$REPORT_JSON"; do
  [ -f "$f" ] || { echo "missing required file: $f" >&2; exit 2; }
done

TMP_DIR="$(mktemp -d)"
cleanup() { rm -rf "$TMP_DIR"; }
trap cleanup EXIT

unzip -oq "$STAGE_TOOL_ZIP" -d "$TMP_DIR/st"
unzip -oq "$GAME_ZIP" -d "$TMP_DIR/gm"

APP_TSX="$TMP_DIR/st/stage-tool-v9/src/App.tsx"
TOOL_COMPILER="$TMP_DIR/st/stage-tool-v9/src/lib/runtime/stage/compileRuntimeFromV2.ts"
GAME_COMPILER="$TMP_DIR/gm/game/stage/compileRuntimeFromV2.ts"
RANDOM_GEN="$TMP_DIR/st/stage-tool-v9/src/lib/randomStageGenerator.ts"
REPLAY_REPAIR="$TMP_DIR/st/stage-tool-v9/src/lib/replay_repair.ts"

issue1="PASS"
issue1_msg="compiler matched"
if ! diff -q "$GAME_COMPILER" "$TOOL_COMPILER" >/dev/null 2>&1; then
  issue1="FAIL"
  issue1_msg="game compiler and stage-tool compiler differ"
fi

issue2="PASS"
issue2_msg="replay UI/gate removed"
if rg -q "replayOpen|simulateStageReplay|repairStageUntilReplaySolved|replay modal" "$APP_TSX"; then
  issue2="FAIL"
  issue2_msg="replay flow still exists in App.tsx"
fi

issue3="PASS"
issue3_msg="supply board excludes spawner/chain/pillar"
if rg -q "\{ type: 'CHAIN_BARRIER'|\{ type: 'PILLAR'|\{ type: 'SPAWNER_BOX'" "$APP_TSX"; then
  issue3="FAIL"
  issue3_msg="non-block object brushes still exposed (including supply mode)"
fi

issue4="PASS"
issue4_msg="matrix generation/validation pipeline exists"
if ! rg -q "(500|1000|1500|2000).*(easy|normal|hard)|(easy|normal|hard).*(500|1000|1500|2000)|test.*stage|matrix" "$RANDOM_GEN"; then
  issue4="FAIL"
  issue4_msg="no evidence of requested 500/1000/1500/2000 x easy/normal/hard x10 matrix pipeline"
fi

issue5="PASS"
issue5_msg="solver constrained to deck reorder + ammo redistribution only"
if rg -q "forceGenerate|bakeAuthoredDeckFromGenerate|gaSearchReplaySolvedDeck|gaSearchReplaySolvedHints" "$REPLAY_REPAIR"; then
  issue5="FAIL"
  issue5_msg="solver still includes non-policy operations (generate bake / GA rewrites)"
fi

report_ok="UNKNOWN"
report_fail="UNKNOWN"
if python - <<'PY' "$REPORT_JSON" >/tmp/issue5_report_vals.txt
import json,sys
p=sys.argv[1]
d=json.load(open(p))
print(d.get('ok',''))
print(d.get('fail',''))
PY
then
  report_ok="$(sed -n '1p' /tmp/issue5_report_vals.txt)"
  report_fail="$(sed -n '2p' /tmp/issue5_report_vals.txt)"
fi
rm -f /tmp/issue5_report_vals.txt

overall="PASS"
for s in "$issue1" "$issue2" "$issue3" "$issue4" "$issue5"; do
  if [ "$s" != "PASS" ]; then overall="FAIL"; fi
done

json_payload=$(python - <<'PY' \
  "$issue1" "$issue1_msg" \
  "$issue2" "$issue2_msg" \
  "$issue3" "$issue3_msg" \
  "$issue4" "$issue4_msg" \
  "$issue5" "$issue5_msg" \
  "$report_ok" "$report_fail" "$overall"
import json,sys
it=iter(sys.argv[1:])
obj={
  "issue1": {"status":next(it), "message":next(it)},
  "issue2": {"status":next(it), "message":next(it)},
  "issue3": {"status":next(it), "message":next(it)},
  "issue4": {"status":next(it), "message":next(it)},
  "issue5": {"status":next(it), "message":next(it)},
  "existingReplayReport": {"ok":next(it), "fail":next(it)},
  "overall": next(it),
}
print(json.dumps(obj, ensure_ascii=False, indent=2))
PY
)

printf '%s\n' "$json_payload"

if [ -n "$OUT_JSON" ]; then
  printf '%s\n' "$json_payload" > "$OUT_JSON"
fi

if [ "$overall" = "PASS" ]; then
  exit 0
fi
exit 1
