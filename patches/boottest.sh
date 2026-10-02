#!/usr/bin/env bash
# Boot a scratch profile, confirm every plugin in the reliability pack mounted,
# then shut it down. The desktop profile is never touched.
#
# A composed tree (`--dump-config`) proves the configuration is sound. It does
# not prove the plugins load, because composing does not import them. This does.
#
#   ./boottest.sh <scratch-profile> <log-path> [port]
set -uo pipefail

PROFILE="${1:?usage: boottest.sh <profile> <log> [port]}"
LOG="${2:?usage: boottest.sh <profile> <log> [port]}"
PORT="${3:-3099}"
WAIT_SECONDS=25

echo "== booting profile '$PROFILE' on port $PORT"
echo "   log: $LOG"

# A fresh log each run, or a stale success would read as a new one.
: > "$LOG"

dsh --profile "$PROFILE" --no-open --port "$PORT" >>"$LOG" 2>&1 &
PID=$!
echo "   pid: $PID"

for i in $(seq 1 "$WAIT_SECONDS"); do
  sleep 1
  if ! kill -0 "$PID" 2>/dev/null; then
    echo "   process exited after ${i}s"
    break
  fi
done

ALIVE=no
kill -0 "$PID" 2>/dev/null && ALIVE=yes

echo
echo "== shutdown"
if [ "$ALIVE" = yes ]; then
  kill -TERM "$PID" 2>/dev/null
  for i in $(seq 1 10); do
    kill -0 "$PID" 2>/dev/null || break
    sleep 1
  done
  kill -KILL "$PID" 2>/dev/null
  echo "   stopped"
else
  echo "   already exited"
fi

echo
echo "== verifying from the log"
fail=0

# The activation count is the most important line in the log. A plugin that
# fails to activate does not stop the boot: it prints a warning and the harness
# runs without it. So a boot that looks healthy can be a completely dead
# install. My first version of this script grepped for ERR_MODULE_NOT_FOUND and
# similar, reported PASSED, and both plugins were in fact dead.
INACTIVE="$(grep -oE '[0-9]+ entries? did not activate' "$LOG" | grep -oE '^[0-9]+' | head -1)"
if [ -n "$INACTIVE" ]; then
  echo "  FAIL  $INACTIVE plugin(s) did not activate"
  grep -E "did not activate|without inject|Error:" "$LOG" | head -8 | sed 's/^/          /'
  fail=1
else
  echo "  ok    every entry activated"
fi

for p in guidance-pack apply-patch verify-on-edit; do
  if grep -q "@l33tdawg/dsh-$p" "$LOG"; then
    echo "  FAIL  @l33tdawg/dsh-$p is named in the log, which means it complained"
    grep -A1 "@l33tdawg/dsh-$p)" "$LOG" | head -2 | sed 's/^/          /'
    fail=1
  else
    echo "  ok    @l33tdawg/dsh-$p activated without complaint"
  fi
done

for pattern in "ERR_MODULE_NOT_FOUND" "Cannot find module" "already registered" "failed to load" "loader error" "without inject" "Error:"; do
  if grep -qi -- "$pattern" "$LOG"; then
    echo "  FAIL  log contains: $pattern"
    grep -i -- "$pattern" "$LOG" | head -3 | sed 's/^/          /'
    fail=1
  fi
done

if [ "$ALIVE" = yes ]; then
  echo "  ok    the process stayed up for ${WAIT_SECONDS}s rather than crashing"
else
  echo "  FAIL  the process exited early; see the log"
  fail=1
fi

echo
if [ "$fail" -eq 0 ]; then
  echo "BOOT TEST PASSED"
else
  echo "BOOT TEST FAILED — do not install into desktop"
fi
echo "(full log: $LOG)"
exit "$fail"
