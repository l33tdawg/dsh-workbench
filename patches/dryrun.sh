#!/usr/bin/env bash
# Dry-run the reliability-pack install against a throwaway copy of a profile.
#
# The desktop profile is app-managed, and the CLI refuses to touch it, so the
# only way to compose a change before committing to it is to test an identical
# copy under another name. This does exactly that: copy, install, compose,
# inspect, and report. Nothing here touches the real profile.
#
#   ./dryrun.sh <source-profile> <scratch-name> <packages-dir>
#
# Exits non-zero if the composed tree does not contain all three rows.
set -euo pipefail

SOURCE_NAME="${1:?usage: dryrun.sh <source-profile> <scratch-name> <packages-dir>}"
SCRATCH="${2:?usage: dryrun.sh <source-profile> <scratch-name> <packages-dir>}"
PACKAGES="${3:?usage: dryrun.sh <source-profile> <scratch-name> <packages-dir>}"

HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
SOURCE="$HOME_DIR/profiles/$SOURCE_NAME"
TARGET="$HOME_DIR/profiles/$SCRATCH"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKGS=(dsh-guidance-pack dsh-apply-patch dsh-verify-on-edit)

[ -d "$SOURCE" ] || { echo "FAIL: no profile at $SOURCE" >&2; exit 1; }
[ "$SCRATCH" = "desktop" ] && { echo "FAIL: refusing to build a scratch profile named desktop" >&2; exit 1; }

echo "== copying $SOURCE_NAME -> $SCRATCH"
rm -rf "$TARGET"
cp -R "$SOURCE" "$TARGET"
# The copy carries the source's generated config; remove it so composition is
# rebuilt from the patch layers rather than read back stale.
rm -f "$TARGET/cordis.yml"

echo
echo "== installing into the copy"
"$HERE/install-reliability-pack.sh" "$TARGET" "$PACKAGES" --with-preset

echo
echo "== composing the copy (this is the real test)"
DUMP="$(dsh --profile "$SCRATCH" --dump-config 2>&1)" || {
  echo "COMPOSE FAILED:"
  printf '%s\n' "$DUMP" | tail -30
  exit 1
}

echo "  composed $(printf '%s' "$DUMP" | wc -l | tr -d ' ') lines"

echo
echo "== checking the composed tree"
fail=0
for p in "${PKGS[@]}"; do
  if printf '%s' "$DUMP" | grep -q "@l33tdawg/$p"; then
    echo "  ok    @l33tdawg/$p present"
  else
    echo "  FAIL  @l33tdawg/$p MISSING from the composed tree"
    fail=1
  fi
done
if printf '%s' "$DUMP" | grep -q "agent-preset-registry"; then
  echo "  ok    agent-preset-registry patched"
  printf '%s' "$DUMP" | grep -A3 "agent-preset-registry" | grep -E "default" | sed 's/^/        /' || true
else
  echo "  FAIL  agent-preset-registry not found"
  fail=1
fi

# A duplicate top-level loader id is the failure that aborts a boot. Ids nested
# inside a preset's `config.plugins` are local to that preset and repeat across
# presets by design, so only depth-zero entries are checked. Flattening the whole
# file instead reports 32 false duplicates and hides whether the change is sound.
DUPLICATES="$(printf '%s' "$DUMP" | awk '
  /^[[:space:]]*-[[:space:]]*id:[[:space:]]*/ {
    line = $0
    sub(/^[[:space:]]*/, "", line)
    if (substr(line, 1, 1) != "-") next
    indent = length($0) - length(line)
    if (indent != 0) next
    sub(/^-[[:space:]]*id:[[:space:]]*/, "", line)
    sub(/[[:space:]]*$/, "", line)
    gsub(/["'"'"']/, "", line)
    print line
  }
' | sort | uniq -d || true)"
if [ -n "$DUPLICATES" ]; then
  echo "  FAIL  duplicate top-level loader ids: $(printf '%s' "$DUPLICATES" | tr '\n' ' ')"
  fail=1
else
  echo "  ok    no duplicate top-level loader ids"
fi

# Each row the pack declares must be a top-level loader entry rather than buried
# inside a preset, which would scope it to one preset instead of the profile.
for p in guidance-pack apply-patch verify-on-edit; do
  if printf '%s' "$DUMP" | grep -qE "^- id: ${p}$"; then
    echo "  ok    ${p} is a top-level row"
  else
    echo "  FAIL  ${p} is not a top-level row"
    fail=1
  fi
done

echo
if [ "$fail" -eq 0 ]; then
  echo "DRY RUN PASSED. The copy at $TARGET composes cleanly."
  echo "Nothing was changed in the $SOURCE_NAME profile."
  echo "Inspect it with:  dsh --profile $SCRATCH --dump-config | less"
  echo "Remove it with:   rm -rf $TARGET"
else
  echo "DRY RUN FAILED. Do not install into $SOURCE_NAME."
  exit 1
fi
