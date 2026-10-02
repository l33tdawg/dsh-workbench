#!/bin/sh
# Mount the check-claims plugin in a DSH profile.
#
# Idempotent: re-running adds nothing that is already present. Backs up both
# files before touching them, because a profile patch that fails to apply is a
# profile that does not boot.
#
# Usage: sh install-check-claims.sh [profile-dir]
set -eu

PROFILE="${1:-$HOME/.dsh/profiles/desktop}"
PKG="$PROFILE/package.json"
PATCH="$PROFILE/cordis.patch.yml"
LINK_DIR="$PROFILE/node_modules/@l33tdawg"
PLUGIN="dsh-check-claims"
SOURCE="/Users/l33tdawg/nodejs-projects/dsh-workspace-mcp/packages/dsh-check-claims"
STAMP="$(date +%Y%m%d-%H%M%S)"

[ -f "$PKG" ] || { echo "no package.json at $PROFILE" >&2; exit 1; }
[ -d "$SOURCE" ] || { echo "no plugin source at $SOURCE" >&2; exit 1; }

# Verify the manifest parses before editing anything.
node -e "JSON.parse(require('fs').readFileSync('$PKG','utf8'))" \
  || { echo "$PKG is not valid JSON; refusing to edit" >&2; exit 1; }

cp "$PKG" "$PKG.bak-checkclaims-$STAMP"
[ -f "$PATCH" ] && cp "$PATCH" "$PATCH.bak-checkclaims-$STAMP"
echo "backed up with stamp $STAMP"

# 1. dependency + bundle entry
node - "$PKG" "$PLUGIN" "$SOURCE" <<'NODE'
const fs = require('node:fs')
const [file, plugin, source] = process.argv.slice(2)
const manifest = JSON.parse(fs.readFileSync(file, 'utf8'))
const name = `@l33tdawg/${plugin}`
manifest.dependencies ??= {}
manifest.dependencies[name] = `link:${source}`
const profile = manifest.dsh ??= { profile: {} }
const bundles = profile.profile.bundles ??= []
if (!bundles.includes(name)) bundles.push(name)
fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`)
console.log(`manifest: ${name} added`)
NODE

# 2. the workspace link the loader resolves through
mkdir -p "$LINK_DIR"
[ -e "$LINK_DIR/$PLUGIN" ] || ln -s "$SOURCE" "$LINK_DIR/$PLUGIN"
echo "link: $LINK_DIR/$PLUGIN"

# Mounting is via the bundle list alone. The profile's patch layer carries no
# plugin rows, and adding one here would mount the plugin a second time.

echo
echo "verify before restarting:"
node -e "
const m = JSON.parse(require('fs').readFileSync('$PKG','utf8'));
console.log('  deps   :', Object.keys(m.dependencies).filter(d => d.includes('l33tdawg')).join(', '));
console.log('  bundles:', (m.dsh?.profile?.bundles ?? []).filter(b => b.includes('l33tdawg')).join(', '));
"
[ -f "$PATCH" ] && tail -4 "$PATCH"
