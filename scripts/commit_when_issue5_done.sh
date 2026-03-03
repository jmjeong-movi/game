#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
STATUS_FILE="$ROOT_DIR/.issue5_status.json"
CHECK_SCRIPT="$ROOT_DIR/scripts/check_issue5_patches.sh"
CHECK_OUT="$ROOT_DIR/.issue5_check_result.json"

need_cmd() { command -v "$1" >/dev/null 2>&1 || { echo "missing command: $1" >&2; exit 2; }; }
need_cmd jq
need_cmd git

[ -x "$CHECK_SCRIPT" ] || { echo "missing executable check script: $CHECK_SCRIPT" >&2; exit 2; }

if [ ! -f "$STATUS_FILE" ]; then
  cat > "$STATUS_FILE" <<'JSON'
{
  "issue1": false,
  "issue2": false,
  "issue3": false,
  "issue4": false,
  "issue5": false
}
JSON
  echo "created template: $STATUS_FILE"
  echo "각 항목을 true로 바꾼 뒤 다시 실행하세요."
  exit 1
fi

all_done=$(jq -r '.issue1 and .issue2 and .issue3 and .issue4 and .issue5' "$STATUS_FILE")
if [ "$all_done" != "true" ]; then
  echo "핵심 이슈 5개 완료 플래그가 아직 모두 true가 아닙니다: $STATUS_FILE"
  exit 1
fi

if ! "$CHECK_SCRIPT" "$CHECK_OUT"; then
  echo "패치 검증 실패: $CHECK_OUT"
  exit 1
fi

report_fail=$(jq -r '.existingReplayReport.fail // "UNKNOWN"' "$CHECK_OUT")
if [ "$report_fail" != "0" ]; then
  echo "리플레이 리포트 fail 값이 0이 아님: $report_fail"
  exit 1
fi

if git diff --quiet && git diff --cached --quiet; then
  echo "커밋할 변경사항이 없습니다."
  exit 0
fi

msg="feat: 핵심 이슈 5개 완료 + 패치검증/리포트 통과 자동커밋"
git add -A
git commit -m "$msg"
echo "자동 커밋 완료: $msg"
