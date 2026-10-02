# Editing a profile while DSH is running drops preset-scoped tools

**Severity:** high. The session cannot recover on its own, and the failure looks like a broken harness rather than a reload bug.

## What happens

Editing any file in the active profile directory while `dsh` is running makes the session lose every preset-scoped tool. Core tools go first: `bash`, `read`, `glob`, `grep`, `edit`, `write`. Top-level rows survive, so a plugin mounted as a top-level loader row keeps working.

The session keeps running. Tool calls against the missing names return `Error: unknown tool "bash"`. Nothing in the transcript explains why.

Restarting restores everything, which is what makes this expensive to diagnose: it looks like the profile is broken, so the natural move is to revert config changes rather than restart.

## Reproduction

1. Start `dsh` with any profile.
2. Confirm `bash` and `read` work.
3. In another terminal, touch or edit a file under `~/.dsh/profiles/<name>/`. Appending a line to `cordis.patch.yml`, or rewriting `package.json`, both do it.
4. Call `bash` in the running session.

Expected: either the edit has no effect until restart, or the reload completes and tools remain.

Actual: tools are gone for the rest of the session.

## Evidence

Reproduced twice today on the same profile.

The first time, I had just installed three plugins and rewrote `package.json` plus appended a row to `cordis.patch.yml`. The session lost `bash`, `read`, `glob`, `grep`. `apply_patch`, mounted as a top-level loader row, still worked. I assumed my install was broken and had the user revert it, then restart. With the revert applied, tools came back.

That conclusion was wrong. Later, the same profile with the same plugins installed survived a restart intact. The second time, I edited `cordis.patch.yml` on its own to change one value, and the same tools vanished again. No plugin install involved.

The asymmetry is the clue. Session tool registry before and after, from `request/header` in the session log:

- after a clean restart: 66 tools, including `bash`, `read`, `glob`, `grep`, `edit`, `write`
- after a live profile edit: those six absent, top-level rows still present

## Why I think this is the reconcile path

Whatever reacts to the profile mtime rebuilds agent scopes. Preset-scoped registrations are evidently not re-mounted, while loader rows that are not inside a preset are. A reload that cannot remount a preset should either keep the previous registration or say so, rather than leaving a session with a tool registry that silently lost half its entries.

I could not pin the exact call. `--dump-config` composes correctly in both cases, and a boot on a throwaway copy of the same profile activates every entry, so the composition is fine and the damage happens only in the live reconcile.

## Impact

Anyone iterating on a profile hits this. It is also exactly the workflow a plugin author uses, so the people most likely to hit it are the ones least likely to report it, since they will assume their own change broke something.

## Workaround

Restart after editing the profile. Do not edit profile files from inside a running session.

## Environment

- DSH `dsh-v0.2.0-rc.2`, commit `639ed0153`
- macOS, desktop profile
- Profile mounted `@deepseek-ai/dsh-base` and `@deepseek-ai/dsh-web-app` plus three local plugins
