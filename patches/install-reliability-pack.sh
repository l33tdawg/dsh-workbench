#!/usr/bin/env bash
# Install the DSH reliability pack into a profile, with backups and verification.
#
# Run once. Every step verifies before moving on, and the profile files are
# backed up first, because a bad profile edit aborts the harness boot rather
# than degrading it.
#
#   ./install.sh <profile-dir> <packages-dir> [--with-preset]
#
# <profile-dir>   e.g. ~/.dsh/profiles/desktop
# <packages-dir>  e.g. ~/nodejs-projects/dsh-workspace-mcp/packages
# --with-preset   also switch the default agent preset to `cordis`
set -euo pipefail

PROFILE="${1:?usage: install.sh <profile-dir> <packages-dir> [--with-preset]}"
PACKAGES="${2:?usage: install.sh <profile-dir> <packages-dir> [--with-preset]}"
WITH_PRESET="${3:-}"

PKGS=(dsh-guidance-pack dsh-apply-patch dsh-verify-on-edit)
STAMP="$(date +%Y%m%d-%H%M%S)"
say() { printf '%s\n' "$*"; }
die() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

[ -f "$PROFILE/package.json" ] || die "no package.json in $PROFILE"
for p in "${PKGS[@]}"; do
  [ -f "$PACKAGES/$p/package.json" ] || die "missing package $p under $PACKAGES"
done

# ── 1. Back up before touching anything ────────────────────────────────────
say "backing up profile files"
cp "$PROFILE/package.json" "$PROFILE/package.json.bak-uplift-$STAMP"
[ -f "$PROFILE/cordis.patch.yml" ] && cp "$PROFILE/cordis.patch.yml" "$PROFILE/cordis.patch.yml.bak-uplift-$STAMP"
say "  -> *.bak-uplift-$STAMP"

# ── 2. Link each package into the profile's node_modules ───────────────────
# A `link:` dependency is a symlink and nothing more, so this is what an install
# would produce. Doing it directly avoids a resolver run against a profile that
# is currently serving a live session.
say "linking packages into $PROFILE/node_modules/@l33tdawg"
mkdir -p "$PROFILE/node_modules/@l33tdawg"
for p in "${PKGS[@]}"; do
  target="$PROFILE/node_modules/@l33tdawg/$p"
  rm -f "$target"
  ln -s "$PACKAGES/$p" "$target"
  [ -f "$target/package.json" ] || die "link for $p does not resolve"
  say "  -> $p"
done

# ── 3. Declare them and add them to the bundle list ────────────────────────
say "updating profile package.json"
node - "$PROFILE/package.json" "$PACKAGES" "${PKGS[@]}" <<'NODE'
const fs = require('node:fs')
const [file, packagesDir, ...names] = process.argv.slice(2)
const pkg = JSON.parse(fs.readFileSync(file, 'utf8'))
pkg.dependencies ??= {}
pkg.dsh ??= {}
pkg.dsh.profile ??= {}
pkg.dsh.profile.bundles ??= []

for (const name of names) {
  pkg.dependencies[`@l33tdawg/${name}`] = `link:${packagesDir}/${name}`
  const id = `@l33tdawg/${name}`
  if (!pkg.dsh.profile.bundles.includes(id)) pkg.dsh.profile.bundles.push(id)
}
// Write then rename. The running app may be watching this file, and a reader
// that lands between the truncate and the write sees an empty profile, which
// fails the boot. A rename is atomic, so a reader sees one version or the other.
const temp = `${file}.tmp-${process.pid}`
fs.writeFileSync(temp, `${JSON.stringify(pkg, null, 2)}\n`)
fs.renameSync(temp, file)
console.log('  dependencies:', Object.keys(pkg.dependencies).join(', '))
console.log('  bundles     :', pkg.dsh.profile.bundles.join(', '))
NODE

# ── 4. Optionally switch the default preset to cordis ──────────────────────
if [ "$WITH_PRESET" = "--with-preset" ]; then
  say "switching the default agent preset to cordis"
  PATCH="$PROFILE/cordis.patch.yml"
  [ -f "$PATCH" ] || printf '[]\n' > "$PATCH"
  if grep -q 'id: agent-preset-registry' "$PATCH"; then
    say "  -> already patched, leaving it alone"
  else
    cat >> "$PATCH" <<'YAML'

# The default agent preset for sessions created later. `cordis` is `standard`
# plus the harness's own documentation: the cordis_inspect tools and the bundled
# plugin-development skills. Without it a session asked to modify DSH works
# blind. It also enables the profile plugin manager, which is more authority
# than `standard` grants; remove this block to go back.
- id: agent-preset-registry
  name: '@deepseek-ai/dsh-agent-preset-registry'
  config:
    default: cordis
YAML
    say "  -> appended to cordis.patch.yml"
  fi
fi

# ── 5. Verify what is actually on disk ─────────────────────────────────────
say ""
say "verifying"
fail=0
for p in "${PKGS[@]}"; do
  if node -e "require.resolve('@l33tdawg/$p/package.json', { paths: ['$PROFILE'] })" 2>/dev/null; then
    say "  ok    @l33tdawg/$p resolves"
  else
    say "  FAIL  @l33tdawg/$p does not resolve from the profile"
    fail=1
  fi
done

node - "$PROFILE/package.json" <<'NODE' || fail=1
const fs = require('node:fs')
const pkg = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
const bundles = pkg.dsh?.profile?.bundles ?? []
const missing = ['dsh-base', 'dsh-web-app'].filter(base => !bundles.some(b => b.endsWith(base)))
if (missing.length) { console.error('  FAIL  base bundles missing:', missing.join(', ')); process.exit(1) }
const dupes = bundles.filter((b, i) => bundles.indexOf(b) !== i)
if (dupes.length) { console.error('  FAIL  duplicate bundle rows:', dupes.join(', ')); process.exit(1) }
console.log(`  ok    ${bundles.length} bundle rows, no duplicates`)
NODE

say ""
if [ "$fail" -eq 0 ]; then
  say "installed. Restart DSH so new sessions pick it up."
  say "revert:  cp $PROFILE/package.json.bak-uplift-$STAMP $PROFILE/package.json"
  [ "$WITH_PRESET" = "--with-preset" ] && say "         cp $PROFILE/cordis.patch.yml.bak-uplift-$STAMP $PROFILE/cordis.patch.yml"
else
  die "verification failed; restore the backups listed above"
fi
