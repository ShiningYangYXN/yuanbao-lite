#!/bin/bash
# Run all unit tests and report results
set -e

CORE_DIR="/home/z/my-project/yuanbao-lite/packages/core"
TOTAL_PASS=0
TOTAL_FAIL=0
FAILED_FILES=()

for f in "$CORE_DIR"/test/unit/*.test.ts; do
  echo "=== $(basename "$f") ==="
  RESULT=$(npx tsx --test "$f" 2>&1 || true)
  PASS=$(echo "$RESULT" | grep -E "^ℹ pass" | head -1 | awk '{print $3}')
  FAIL=$(echo "$RESULT" | grep -E "^ℹ fail" | head -1 | awk '{print $3}')
  echo "  pass: $PASS  fail: $FAIL"
  TOTAL_PASS=$((TOTAL_PASS + ${PASS:-0}))
  TOTAL_FAIL=$((TOTAL_FAIL + ${FAIL:-0}))
  if [ "${FAIL:-0}" -gt 0 ]; then
    FAILED_FILES+=("$(basename "$f")")
  fi
done

echo ""
echo "=== SUMMARY ==="
echo "Total pass: $TOTAL_PASS"
echo "Total fail: $TOTAL_FAIL"
if [ ${#FAILED_FILES[@]} -gt 0 ]; then
  echo "Failed files: ${FAILED_FILES[*]}"
fi
