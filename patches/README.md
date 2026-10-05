# Network fence: fix applied and reported

## Status

| | |
|---|---|
| **Applied** | 7 files in `/Users/l33tdawg/nodejs-projects/levelup/.scratch/dsh-src` (uncommitted) |
| **Reported** | [discussion #8630](https://github.com/deepseek-ai/deepseek-harness/discussions/8630), category General |
| **Patch** | [`network-fence.patch`](network-fence.patch): 275 lines, reviewable |
| **Applier** | [`network-fence.mjs`](network-fence.mjs): anchor-asserting, idempotent, `--check` mode |
| **Verified** | 11 assertions against the patched `profiles.ts`; end-to-end tests added but not run here |

## What changed

A `network` axis on the sandbox policy, defaulting to **deny** in every confining mode.

| File | Change |
|---|---|
| `sandbox/src/index.ts` | `network?: 'deny' \| 'allow'` on `SandboxExecutionPolicy`; `networkEnforcement?: SandboxEnforcement` on `ConfinedArgv` |
| `sandbox-local/src/profiles.ts` | bwrap: `--unshare-net`. Seatbelt: `(deny network*)` |
| `sandbox-local/src/index.ts` | Per-runner `networkEnforcement`; `confine()` warns when the selected rung cannot enforce the deny |
| `ssh/sandbox-ssh/src/index.ts` | Relays the new field through the remote facts schema |
| `sandbox-local/tests/local.spec.ts` | Updated pinned fixtures; deny-default and `'allow'` opt-out tests |
| `sandbox-local/tests/seatbelt.e2e.ts` | Real kernel denial + opt-out restores it |
| `sandbox-local/tests/bwrap.e2e.ts` | Real namespace denial |

## Why this design

The maintainers had already framed the decision, which is why the report leans on their words
rather than arguing the point.

`.agents/notes/implemented/feature/2026-07-06-sandbox.md:196` asks whether network restriction
becomes **its own knob**, and § The seam leaves it open "once a runner enforces both". This takes
the separate-knob option, because the two axes have different enforceability per backend and merging
them would force one completeness verdict onto both.

`.agents/notes/implemented/feature/2026-07-14-cross-family-fs-sandbox.md:56` rejects the cheap
version. "a web-only network knob while bash `curl` runs free would be a **false boundary**". The
fence here goes on the confined process, so it covers `curl`, any language runtime, and every
descendant.

Three properties matter more than the flag itself:

- **Absence means deny.** Every existing call site gets the restriction without being edited.
- **`networkEnforcement` is separate from `enforcement`.** Landlock governs every file effect while
 being unable to touch the network, so reusing the field would make it report `full` for a fence it
 does not have.
- **A rejected profile fails loudly.** `sandbox-exec: ` is a registered runner-failure signature, so
 a profile the kernel refuses is classified as runner failure, so the command never runs. It does
 not fall through to an unfenced path.

## Operating it

Revert:

```sh
git -C /Users/l33tdawg/nodejs-projects/levelup/.scratch/dsh-src checkout -- packages/
```

Reapply:

```sh
node patches/network-fence.mjs /Users/l33tdawg/nodejs-projects/levelup/.scratch/dsh-src
```

Preview without writing:

```sh
node patches/network-fence.mjs /Users/l33tdawg/nodejs-projects/levelup/.scratch/dsh-src --check
```

The applier asserts every anchor before writing, so a checkout that has moved on fails loudly
instead of being corrupted.

**Expect `npm install`, `git fetch`, and `curl` inside a confined command to fail.** That is the
fence working. `network: 'allow'` on a policy restores the old behaviour; wiring that to the
escalation approval is not part of this patch.

## Verification

[`verify/run.sh`](verify/run.sh) stages a copy of `profiles.ts` with its two workspace imports
stubbed, then runs the real module. Nothing in the checkout is touched.

```sh
# patched working tree: expect 11 checks passed, exit 0
./verify/run.sh /Users/l33tdawg/nodejs-projects/levelup/.scratch/dsh-src

# control against the committed state: expect "NO FENCE", exit 1
./verify/run.sh /Users/l33tdawg/nodejs-projects/levelup/.scratch/dsh-src HEAD
```

Both directions matter. The control prints the real profile arguments and fails, which is what
proves the test detects the bug:

```
bwrap args : --ro-bind / / --dev /dev --unshare-pid --proc /proc --die-with-parent
seatbelt   : (version 1) (allow default) (deny file-write*) (allow file-write* (literal "/dev/null"))
RESULT: NO FENCE - bwrap must isolate the network namespace
```

Patched, those two lines gain `--unshare-net` and `(deny network*)`. A test that passed on both
would be worthless, and my first attempt at this control did pass on unpatched code, because it read
from a directory I had already patched. Keep that in mind if you extend it.

The applier round-trips too. Applying it to files taken from `git show HEAD:<path>` reproduces the
live checkout byte for byte, and re-running it against an already-patched tree is a clean no-op at
exit 0.

## What is not verified

Stated plainly, because an assumed fence is worse than none.

- **Not typechecked.** The checkout has no installed dependencies, and this workspace has no `tsc`.
 Run `pnpm install && pnpm run typecheck` before trusting the build.
- **The kernel behaviour is untested here.** `sandbox-exec` cannot apply a nested profile, so the
 Seatbelt deny and `--unshare-net` were not executed. This is what the added e2e tests are for;
 they skip automatically off-platform or when the probe fails.
- **`--unshare-net` is untested on Linux** entirely, no Linux host was available.
- **Two known follow-ups** are recorded in the report: telling the user in the permission-picker copy
 that reads and egress were unrestricted, and threading `networkEnforcement` through to the tool
 result so the model learns when its confinement is weaker than the mode implies.

## Files here

| File | Purpose |
|---|---|
| `network-fence.patch` | The applied diff, for review or for posting elsewhere |
| `network-fence.mjs` | Anchor-asserting applier with `--check` |
| `BUG-REPORT-network-egress.md` | The report as filed (with the patch inlined at submission time) |
| `build-submission.mjs` | Builds the GraphQL payload; keeps the body out of shell quoting |
| `enable-auto-review.md` | Separate, unrelated: switching on DSH's guardian equivalent |
| `UPSTREAM-REPORTS.md` | The index of everything filed upstream; the documents below are catalogued there |

## Other patches in this directory

| Patch | Status |
|---|---|
| [`mcp-catalog-reuse.patch`](mcp-catalog-reuse.patch), [applier](mcp-catalog-reuse.mjs), [probe](mcp-catalog-reuse-probe.mjs) | Applied and tested in the checkout at `3e6ed5f11f`; filed as [discussion 8720](https://github.com/deepseek-ai/deepseek-harness/discussions/8720). See [`FINDING-mcp-catalog-reuse.md`](FINDING-mcp-catalog-reuse.md). |
| [`enable-cordis-skill-root.mjs`](enable-cordis-skill-root.mjs) | Applied to the desktop profile 2026-10-03: restates the `cordis` preset with its unreadable `customSkillDirs` root replaced, and retires the row [`enable-cordis-skills.mjs`](enable-cordis-skills.mjs) inserts. Reasoning in [`FINDING-cordis-skill-catalog.md`](FINDING-cordis-skill-catalog.md). |

### Documents in this directory

| Document | What it is |
|---|---|
| [`UPSTREAM-REPORTS.md`](UPSTREAM-REPORTS.md) | The index: six reports, one proposal and ten comments filed, with the corrections made after filing. |
| `BUG-REPORT-*.md` | Three report bodies as posted, including the 8649 addendum; the other report copies live in [`../research/upstream/`](../research/upstream). |
| [`FINDING-profile-reload-boundary.md`](FINDING-profile-reload-boundary.md) | What a profile edit does and does not reach in a running session, measured from `dsh-hmr` and the session logs. |
| [`FINDING-cordis-skill-catalog.md`](FINDING-cordis-skill-catalog.md) | Which gate loses the `cordis` skill catalog, why the watcher is not the cause, and what the repair does. |
| [`FINDING-mcp-catalog-reuse.md`](FINDING-mcp-catalog-reuse.md) | The MCP catalog reuse change: what was built, the protocol detail that decided it, and what it does not fix. |
| `COMMENT-*.md` | Nine comment bodies as posted: one on 8630, one on 8635, four on 8649 and three on 8720. |
| [`enable-cordis-skills.md`](enable-cordis-skills.md), [`enable-auto-review.md`](enable-auto-review.md), [`enable-harness-introspection.md`](enable-harness-introspection.md) | Opt-in profile changes, each with the script that applies it. |
