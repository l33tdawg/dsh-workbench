#!/usr/bin/env bash
# Verify the network fence against a DSH checkout, patched or not.
#
# `profiles.ts` is the only file under test. It imports two workspace packages,
# so this stages a copy with those imports pointed at stubs and runs the real
# module. Nothing in the checkout is modified.
#
#   ./run.sh <dsh-checkout>          run against its current state
#   ./run.sh <dsh-checkout> HEAD     run against the committed (unpatched) state
#
# The second form is the control. It must FAIL, with the profile arguments
# printed so you can see the missing fence. If it passes, the test is not
# testing anything.
set -euo pipefail

ROOT="${1:?usage: run.sh <dsh-checkout> [HEAD]}"
REV="${2:-}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

mkdir -p "$WORK/stub"
cat > "$WORK/stub/landlock.mjs" <<'EOF'
export function grantArgs({ readOnly = [], readWrite = [] }) {
  return [...readOnly.flatMap(p => ['--ro', p]), ...readWrite.flatMap(p => ['--rw', p])]
}
EOF
cat > "$WORK/stub/sandbox.mjs" <<'EOF'
export function writableRoots(policy) {
  return policy.mode === 'workspace-write' ? ['/tmp', policy.workspaceRoot] : []
}
EOF

SRC="$ROOT/packages/sandbox/sandbox-local/src/profiles.ts"
if [ -n "$REV" ]; then
  git -C "$ROOT" show "$REV:packages/sandbox/sandbox-local/src/profiles.ts" > "$WORK/profiles.ts"
  echo "source: $REV (committed)"
else
  cp "$SRC" "$WORK/profiles.ts"
  echo "source: working tree"
fi

sed -i.bak "s#from '@deepseek-ai/node-addon-system/landlock-run'#from './stub/landlock.mjs'#" "$WORK/profiles.ts"
sed -i.bak "s#from '@deepseek-ai/dsh-sandbox'#from './stub/sandbox.mjs'#" "$WORK/profiles.ts"
rm -f "$WORK/profiles.ts.bak"
cp "$HERE/control.test.ts" "$HERE/verify.test.ts" "$WORK/"

echo
node --experimental-strip-types "$WORK/control.test.ts"
echo
node --experimental-strip-types "$WORK/verify.test.ts"
