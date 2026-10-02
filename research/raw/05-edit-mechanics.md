# 05 — Code-Editing Mechanics: DSH vs Codex

**Axis:** how the model actually writes files — mechanism, robustness, speed, cost.

**Sources (read-only; SHAs verified with `git log -1`):**

| | Path | SHA | Version |
|---|---|---|---|
| DSH | `/Users/l33tdawg/nodejs-projects/levelup/.scratch/dsh-src` | `639ed015397290b3745d163aafe02ffee4aa3f84` | `v0.2.0-rc.2` |
| Codex | `/Users/l33tdawg/nodejs-projects/codex` | `2abb02bc004fe2847d1f99f47610c92d1744b22d` | — |

All `path:line` citations are relative to those roots. Markers: **[V]** = verified by reading the code/test cited; **[I]** = inferred from cited code, not directly executed.

---

## 0. The single most important framing fact

**DSH's default editing surface is NOT `str_replace_editor`.** It is `read` + `write` + `edit`, three separate tools.

- **[V]** `packages/bundle/base/cordis.patch.yml:282` mounts `@deepseek-ai/dsh-tool-fs` and mounts `@deepseek-ai/dsh-fs-observation-policy` at `:278`; `tool-str-replace-editor` appears nowhere in any bundle or preset.
- **[V]** `packages/bundle/base/README.md:65`: *"Default file editing uses `read`, `write`, and `edit`. The `str_replace_editor` tool remains available as an explicit opt-in."* The README then shows the `- insert:` patch to add it (`:67-75`).
- **[V]** `str_replace_editor` ships as a package and is used in `snapshots/sdk/persistent-tools/cordis.yml:6`, `python/sdk-runtime/package.json:135`, and `benchmarks/agent-continuation/profile-continuation.worker.ts:32` — i.e. SDK/test fixtures, not the shipped agent.

Consequence: the honest Codex-vs-DSH comparison is **`apply_patch` versus DSH's `edit`**, with `str_replace_editor` as a secondary data point (it is a near-clone of Claude's `str_replace_editor` and is instructive precisely because DSH chose *not* to ship it).

---

## 1. Core mechanism comparison

### 1.1 DSH `edit` — literal unique-match replacement, CAS-guarded

**[V]** Tool registration: `packages/fs/tool-fs/src/edit.ts:84-167`.

Schema (`edit.ts:87-93`):

```jsonc
{
  "file_path":   { "type": "string", "required": true },
  "old_string":  { "type": "string", "required": true, "description": "Literal text to replace." },
  "new_string":  { "type": "string", "required": true, "description": "Literal replacement text. Use an empty string to delete the match." },
  "replace_all": { "type": "boolean", "description": "Replace all matches. Defaults to false; when false, old_string must appear exactly once." }
}
```

Argument validation (`edit.ts:46-56`): blank `file_path` rejected; **empty `old_string` rejected**; **`old_string === new_string` rejected** (`edit.ts:49` — "would be a guaranteed no-op edit").

Execution (`edit.ts:113-147`):
1. `sandbox.resolvePolicy` → `ctx.fs.resolve` (session cwd).
2. `ctx.waterfall('fs/edit-intent', …)` — the prior-read gate (§3.1).
3. `ctx.fs.editText(target, {oldString, newString, replaceAll}, intent, signal, sandboxPolicy)` — **no stat in the tool**; the provider does everything under a lock.
4. `ctx.emit('fs/observed', …)` with the new version.

Model-facing success text (`edit.ts:64-68`), verbatim:
- single: `The file <path> has been updated successfully.`
- replace-all: `The file <path> has been updated. All occurrences were successfully replaced.`

**The model never sees a diff.** `output.schema` carries `{path, before, after}` and `render` (`edit.ts:104-107`) discards `before`/`after`, emitting only the one-line confirmation. `before`/`after` are routed to `presentationMeta` as UI hunks (`edit.ts:108-111` → `diff.ts:35-59`, 3 lines of context).

Provider matching (`packages/fs/fs-local/src/fsio.ts:814-834`) — **pure literal `indexOf`, no fuzziness at all**:

```ts
const oldNorm = normalizeLineEndings(oldString)          // \r\n → \n
if (oldNorm.length === 0) throw FS_EDIT_NOT_FOUND
const replacements = countOccurrences(content, oldNorm)
if (replacements === 0) throw FS_EDIT_NOT_FOUND          // "old_string was not found in <path>"
if (!replaceAll && replacements > 1) throw FS_AMBIGUOUS_EDIT
  // "old_string matched N times in <path>; provide a more specific old_string or set replace_all to true"
return { content: content.split(oldNorm).join(newNorm), replacements }
```

CRLF handling is **normalize-on-read, restore-on-write** (`fsio.ts:683-704`): the file is LF-normalized for matching, the style is detected from the first 4 KiB (`fsio.ts:687-692`), and restored on write. So `old_string` may be written with either line ending and still match. Binary files (`\0` in first 8 KiB, `fsio.ts:17,396`) and invalid UTF-8 are rejected with `FS_NOT_TEXT` (`fsio.ts:733-735`).

### 1.2 Codex `apply_patch` — freeform multi-hunk patch with fuzzy context matching

**[V]** Exposed as a **custom freeform** tool, not a JSON function: `core/src/tools/handlers/apply_patch_spec.rs:18-27`

```rust
ToolSpec::Freeform(FreeformTool {
    name: "apply_patch",
    description: "The `apply_patch` tool can be used to edit files. This is a FREEFORM tool, so do not wrap the patch in JSON.",
    format: FreeformToolFormat { r#type: "grammar", syntax: "lark", definition /* apply_patch.lark */ },
})
```

The grammar is also advertised as a constrained-decoding grammar (`core/src/tools/handlers/apply_patch.lark:1-19`, copied into the parser doc comment at `apply-patch/src/parser.rs:4-25`). Gated on model support: `core/src/tools/spec_plan.rs:1247` (`model_info.apply_patch_tool_type.is_some()`), and the only variant is `ApplyPatchToolType::Freeform` (`protocol/src/openai_models.rs:310-312`).

Grammar markers (`apply-patch/src/parser.rs:37-45`): `*** Begin Patch`, `*** End Patch`, `*** Add File: `, `*** Delete File: `, `*** Update File: `, `*** Move to: `, `*** End of File`, `@@` / `@@ `.

**Worked example — the same one-line edit in each format:**

DSH `edit` call (131 chars, ~32 tok):
```json
{"file_path":"/repo/packages/fs/tool-fs/src/read.ts","old_string":"const READ_LIMIT = 2000","new_string":"const READ_LIMIT = 4000"}
```

Codex minimal patch (131 chars, ~32 tok — identical cost, so the 3-context-line convention is what actually costs):
```
*** Begin Patch
*** Update File: packages/fs/tool-fs/src/read.ts
@@
-const READ_LIMIT = 2000
+const READ_LIMIT = 4000
*** End Patch
```

Codex with the prompt-mandated 3+3 context (`core/prompt_with_apply_patch_instructions.md:299`: *"By default, show 3 lines of code immediately above and 3 lines immediately below each change"*) — **368 chars, ~92 tok, 2.8× the DSH call**.

Codex also accepts the patch through the **shell** tool: `intercept_apply_patch` (`core/src/tools/handlers/apply_patch.rs:510-556`) intercepts `shell {"command":["apply_patch","…"]}`, and the system prompt instructs exactly that invocation (`core/prompt_with_apply_patch_instructions.md:347-351`). A bare patch body is rejected: `ApplyPatchError::ImplicitInvocation` = "patch detected without explicit call to apply_patch. Rerun as [\"apply_patch\", \"<patch>\"]" (`apply-patch/src/lib.rs:111-114`, enforced `apply-patch/src/invocation.rs:167-178`). **[V]**

### 1.3 DSH `write` / `str_replace_editor` (secondary)

- **[V]** `write`: full-file replace, `{file_path, content}`, model sees only `<path>…</path>\n<type>file</type>\n<content>\nCreated file\n</content>` or `Updated file` (`packages/fs/tool-fs/src/write.ts:35-42`). Guarded by the same prior-read gate (§3.1) via `fs/write-intent` (`write.ts:115`).
- **[V]** `str_replace_editor`: Claude-style 4-command tool (`view`/`create`/`str_replace`/`insert`), `packages/fs/tool-str-replace-editor/src/index.ts:429-499`. **Critically, it does not use `ctx.fs.editText`.** `replaceInFile` (`index.ts:276-328`) reads raw text via `ctx.fs.readText`, does its own `indexOf` scan (`matchOffsets`, `index.ts:44-53`), and writes the spliced result with a `replaceIfVersion` CAS (`index.ts:314-322`). `view` returns `cat -n`-style `"%6d  %s"` numbering (`index.ts:182`) capped at 16 000 **chars** with `<response clipped>` (`index.ts:18,34-38,515`).
- **[V]** `create` refuses to overwrite (`index.ts:251-253`: `File already exists at: <path>. Cannot overwrite files using command 'create'.`), matching DSH's read-before-overwrite stance.

---

## 2. Failure modes

### 2.1 Whitespace and indentation

| Harness | Behavior | Evidence |
|---|---|---|
| DSH `edit` / `str_replace_editor` | **Zero tolerance.** Any leading/trailing/indent mismatch → `FS_EDIT_NOT_FOUND` / `did not appear verbatim` | `fsio.ts:826-829`; `tool-str-replace-editor/src/index.ts:299-304` **[V]** |
| DSH | Tabs outside the edited region are byte-preserved (test) | `tool-str-replace-editor/tests/tools.spec.ts:586` **[V]** |
| Codex `apply_patch` | **4-pass descending strictness**: exact → `trim_end` → `trim` both → Unicode-punctuation-normalized | `apply-patch/src/seek_sequence.rs:39-112` **[V]** |
| Codex | Test names literally encode the passes | `seek_sequence.rs:144` `test_rstrip_match_ignores_trailing_whitespace`; `:161` `test_trim_match_ignores_leading_and_trailing_whitespace` **[V]** |
| Codex | ASCII dash in a patch matches an EN DASH (U+2013) / NON-BREAKING HYPHEN (U+2011) in the file | `apply-patch/src/lib.rs:1313-1358` (`test_update_line_with_unicode_dash`) **[V]** |

**Verdict:** Codex is materially more robust to whitespace drift, and this is deliberate — `seek_sequence.rs:72-79` cites `git apply`'s fuzzy behavior as the model.

**But the whitespace leniency has a sharp edge.** Because `seek_sequence` is tried in descending strictness *and picks the first index that matches at any level*, a `trim`-level match can land on a **different line than the model intended** when indentation is the only distinguishing feature. There is no test covering "trim-match lands on the wrong line", so this is **[I]**: e.g. a file containing `  if x:` at line 10 and `if x:` at line 40, with a patch context `- if x:` — the exact pass fails, the rstrip pass fails, the trim pass matches line 10 first. DSH would instead reject the edit and force the model to supply more context. This is a real correctness-vs-availability tradeoff, not a strict win for either side.

### 2.2 Duplicate anchors / ambiguity — the sharpest divergence

- **DSH: ambiguity is a hard error with line numbers.** **[V]** `fsio.ts:830-832` (`FS_AMBIGUOUS_EDIT`); `tool-str-replace-editor/src/index.ts:305-311` (`Multiple occurrences of old_str \`…\` in lines [1, 4]. Please ensure it is unique`). Tests: `fs-local/tests/filesystem.spec.ts:724-732`; `tool-str-replace-editor/tests/tools.spec.ts:428-446` (both single-line and multi-line anchors); `tool-fs/tests/integration.spec.ts:200-207` (asserts the file is untouched).
- **Codex: ambiguity is silently resolved to the first match at or after a monotonically advancing cursor.** **[V]** `apply-patch/src/file_update.rs:87-113`, `:208` — `line_index = start_idx + pattern.len()` after each chunk, and `seek_sequence` scans `search_start..=` returning the first hit (`seek_sequence.rs:40-44`). There is **no uniqueness check anywhere in the crate** (grep for ambiguity/uniqueness finds nothing).
- **[V]** Direct test evidence: `apply-patch/tests/suite/tool.rs:193-198` `test_apply_patch_cli_preserves_repeated_context_line_ending` — file `same\r\nsame\n`, patch `@@\n-same\n same\n` → result `same\n`. Two candidate lines, no error; the first is replaced.

**Verdict:** Codex's monotonic cursor + first-match **prevents double-application within one patch** (chunks must be in file order — `parser.rs:78-80`) but **removes the model's safety net for a wrong-site edit**. DSH trades a round trip for a guarantee. On real code with repeated idioms (`return null;`, `});`, `import {`, `});` blocks), DSH users get an actionable error; Codex users get a plausible-looking wrong edit that only a later test/compile catches.

### 2.3 Stale reads

This is DSH's strongest axis and Codex's weakest.

**DSH — a real compare-and-swap with a two-layer guard. [V]**
1. *Prior-read requirement* (`fs-observation-policy/src/index.ts:78-88`): unseen target → `FsError('edit requires reading "<path>" first', 'FS_NOT_OBSERVED')`; observed-absent → `FS_NOT_FOUND`. Observed under a `WeakMap<session, Map<targetKey, FsObservation>>` (`index.ts:28`), so **per-session isolation** — owner A reading does not authorize owner B (`fs-observation-policy/tests/policy.spec.ts:158-166`).
2. *Version CAS*: the observed version is passed as the guard, and the provider re-checks **inside the per-target lock, before matching** — `fs-local/src/index.ts:263-275`:
   ```ts
   return this.withLock(target.targetKey, async () => {
     const existing = await probe(target.targetKey)
     if (!existing) throw new FsError(`cannot edit "${…}": file changed since it was read`, 'FS_STALE_VERSION')
     if (expected && existing.version !== expected.version) throw … 'FS_STALE_VERSION'
     const original = await readForEdit(…)   // read→match→write all inside the lock
   ```
   Stale is deliberately checked **before** literal matching so the model gets the right diagnosis (`fs-local/src/index.ts:265-267`; test `fs-local/tests/filesystem.spec.ts:677-685`).
3. *Version strength*: `dev:ino:size:mtimeNs:ctimeNs` (`fsio.ts:76`) — catches same-size same-mtime swaps via inode/ctime. **[V]**
4. *Model-facing remedy is actionable*, not just a condition (`tool-fs/src/error.ts:30-32`): `… — re-read the file, then retry`. Round-trip-proven: `tool-fs/tests/integration.spec.ts:186-198` re-reads and the retried edit succeeds.
5. *Concurrency tests*: two concurrent edits → exactly one wins, the other `FS_STALE_VERSION`, lock count returns to 0 (`filesystem.spec.ts:753-766`); write-vs-edit at the same version → one wins (`:788-794`).

**Codex — verify is a pre-flight recomputation, not a CAS. [V]**
- `verify_apply_patch_args_with_mode` (`apply-patch/src/invocation.rs:201-212, 214-295`) reads each Update target, computes `unified_diff` + `new_content`, and returns an `ApplyPatchAction`. Correctness failures abort here as `apply_patch verification failed: <err>` (`core/src/tools/handlers/apply_patch.rs:390-396, 440-444`).
- **But the apply pass discards that work and re-derives from the live file**: `apply-patch/src/lib.rs:609-616` calls `derive_new_contents_from_chunks` again (`new_content` at `lib.rs:170-171` is never consumed by the applier). There is **no version/hash check between verify and apply**.
- Consequence **[I]**: between verify and apply the file can change in two ways — (a) the context no longer matches → clean failure; (b) the context still matches but at a *shifted* line → the patch applies silently to a location the verification never saw. DSH's CAS fails closed in both cases.

### 2.4 Large files

- **DSH `edit`**: reads the whole file into a `String`, LF-normalizes (`replaceAll` = full copy), counts occurrences, then `split().join()` (full copy), then atomic rewrite. Memory ≈ 3× file size. No size ceiling. **[V]** `fsio.ts:725-735, 814-834`.
- **DSH `str_replace_editor` `str_replace`**: whole-file `readText` + `slice` splice (`tool-str-replace-editor/src/index.ts:296, 316`) — same shape. Its `view` `.split('\n')`s the entire file before applying the 16 000-char cap (`index.ts:144`, `:184`), so **`view` on a huge file buffers it entirely and then throws most away**. **[V]**
- **Codex `apply_patch`**: `apply_replacements` (`file_update.rs:225-246`) does `lines.remove(start_idx)` / `lines.insert(...)` in a loop over `Vec<String>`. Each is O(n) memmove, so a k-line replacement in an n-line file is **O(k·n)** — a whole-file `*** Delete`+re-add style hunk in a 50 k-line file is quadratic. **[V]** for the code, **[I]** for the practical cost (no benchmark in-repo).
- Codex does bound a *different* thing: shell stdout is capped at 1 MiB (`core/src/exec.rs:79` → `utils/pty/src/lib.rs:14` `DEFAULT_OUTPUT_BYTES_CAP = 1024 * 1024`), and unified-exec output at 10 000 tokens / 1 MiB (`core/src/unified_exec/mod.rs:79-81`). So a `cat`-based read of a large file is truncated at 1 MiB.
- **[I]** Sharp edge: `core/src/exec.rs:715-719` calls `stdout_text.truncate(max_bytes)` directly on a `String`. `String::truncate` panics when the index is not a UTF-8 char boundary. A 1 MiB cap landing mid-multibyte-character panics the truncation path. No boundary-safe wrapper is visible at that call site.

### 2.5 Silent destruction — a Codex-only class of failure

- **[V]** `*** Add File:` **silently overwrites an existing file.** `apply-patch/tests/suite/tool.rs:348-364` `test_apply_patch_cli_add_overwrites_existing_file`: pre-existing `duplicate.txt` = `"old content\n"`, patch adds `+new content`, result is `.success().stdout("Success. Updated the following files:\nA duplicate.txt\n")` and the file now reads `new content\n`. The overwritten content is only *captured* for the delta (`lib.rs:509-516`), never surfaced as a refusal.
- **[V]** `*** Move to:` **silently overwrites an existing destination.** `tool.rs:325-346` `test_apply_patch_cli_move_overwrites_existing_destination`: destination pre-exists with `"existing\n"`, patch reports success `M renamed/dir/name.txt`, destination becomes `"new\n"`.
- Compare DSH: `write` onto an unread existing file → `FS_NOT_OBSERVED` "cannot overwrite existing … without reading it first" (`fs-local/src/index.ts:220-223`; test `tool-fs/tests/integration.spec.ts:73`); `str_replace_editor create` → hard refusal (`index.ts:251-253`). DSH's `write` is *only* unguarded when the policy plugin is not mounted, which is a documented bare-provider mode with its own tests (`tool-fs/tests/integration.spec.ts:336` `write unconditionally OVERWRITES an existing unread file`).

### 2.6 Partial failure / non-atomicity — Codex is explicitly non-transactional

- **[V]** `apply_hunks_to_files` (`apply-patch/src/lib.rs:504-…`) iterates hunks and `return`s on the first error. No rollback, no undo log.
- **[V]** **This is pinned by a dedicated scenario fixture**: `apply-patch/tests/fixtures/scenarios/015_failure_after_partial_success_leaves_changes/patch.txt` adds `created.txt` then updates missing `missing.txt`; `expected/` contains **only `created.txt`** — the committed half is the asserted outcome. The scenario runner deliberately does not assert exit status, only final filesystem state (`tests/suite/scenarios.rs:47-67`).
- **[V]** Same test at the integration level: `tool.rs:418-437` `test_apply_patch_cli_failure_after_partial_success_leaves_changes` asserts `.failure().stdout("")` and that `created.txt == "hello\n"` **exists**.
- **[V]** The handler *reports* the partial footprint rather than hiding it: `AppliedPatchDelta` with an `exact: bool` (`lib.rs:245-275`), flipped to `false` when a write may have half-succeeded (`lib.rs:489-502` "A failed write can still have modified the target before surfacing an error (for example by truncating before ENOSPC)"), threaded out via `runtime.committed_delta()` (`core/src/tools/handlers/apply_patch.rs:604-614`, `core/src/tools/runtimes/apply_patch.rs:203-235`). Deltas are surfaced on failure, not just success. **This is genuinely good design — it just isn't atomicity.**
- **DSH's analogue is per-file, not per-call.** DSH has **no multi-file transaction either**, but every individual write is atomic: staging dir (0700) + temp file (0600) + `handle.sync()` + `rename` (POSIX) or DACL-preserving `ReplaceFile` (Windows), with `createIfAbsent` published via hard-link no-replace so a concurrent creator wins and this write fails `FS_NOT_OBSERVED` (`fs-local/src/fsio.ts:588-670`). A DSH `write`/`edit` either fully lands or does not. **[V]**
- **[V] Codex's per-file write is destructive in place, with no fsync.** The `AddFile`/`UpdateFile` arms reach `write_file_with_missing_parent_retry` (`apply-patch/src/lib.rs:801-858`) — which is a plain `fs.write_file` with a `create_directory` retry on `NotFound`, no temp file and no rename. That lands in `exec-server/src/no_follow/unix.rs:122-142`:
  ```rust
  let file = openat(&parent, leaf, WRONLY|CREATE|NOFOLLOW|NONBLOCK|CLOEXEC, 0o666)?;
  if !file.metadata()?.is_file() { return Err(…"path is not a regular file") }
  file.set_len(0)?;              // ← destroys the original here
  file.write_all(&contents)      // ← no sync_all(), no fsync
  ```
  So a crash, `ENOSPC`, or a short write between `set_len(0)` and the end of `write_all` leaves the target **truncated or partly written** — strictly worse than "not updated". The crate knows this and says so at `apply-patch/src/lib.rs:489-491`: *"A failed write can still have modified the target before surfacing an error (for example by truncating before ENOSPC), so the accumulated delta is no longer exact when a write fails"* (which is what flips `delta.exact = false`). The one write-failure test (`lib.rs:1360-1390` `test_apply_patch_fails_on_write_error`) writes into a `0o555` directory, so it fails at `openat` **before** truncation — the truncating failure path is acknowledged in a comment and **untested**.
- **[V]** Net: **Codex can leave a half-applied patch *and* a half-written file; DSH cannot leave a half-written file, but can leave a half-done multi-file change across N calls.** Neither has a cross-file transaction. See §7.

### 2.7 Line endings

- **DSH**: normalize-to-LF on read, restore original style on write, style detected from the first 4 KiB (`fsio.ts:683-704`). Mixed-EOL files collapse to the *majority* style on write. **[V]** A `write` overwrite returns LF-normalized `before` **and** `after` so a CRLF rewrite does not read as every-line-changed (`fs-local/src/index.ts:249-252`; test `filesystem.spec.ts:535`).
- **Codex**: two modes selected by a feature flag — `NormalizeToLf` (legacy) vs `PreserveLineEndings` (`apply-patch/src/lib.rs:91-95`; `core/src/tools/handlers/apply_patch.rs:61-71`). `PreserveLineEndings` uses a `SourceFile` that keeps per-line terminators, including mixed CR/CRLF/LF (`apply-patch/src/text_file.rs`). **[V]**
- **[V] Mode divergence is real and tested.** `test_apply_patch_cli_rejects_overlapping_end_of_file_chunks` (`tool.rs:90-108`) expects `.failure()` with `Failed to find expected lines in …`, while `test_apply_patch_cli_allows_overlapping_eof_chunks_in_legacy_mode` (`tool.rs:110-128`) runs the **identical patch** and expects `.success()` producing `first\n` (the second chunk silently does nothing). Same input, different mode, opposite outcome — the `PreserveLineEndings` path is stricter because of the context-line-splicing logic at `file_update.rs:177-206`.
- **[V]** Codex explicitly tests CR-only files (`tool.rs:172-182`), mixed endings (`:200-210`), CRLF-appended blank lines (`:142-152`), and CRLF-for-new-trailing-newline (`:212-223`) — deeper line-ending coverage than DSH.

### 2.8 Mixed-EOL inconsistency **inside** DSH

**[V]** The two DSH editors disagree on mixed-line-ending files, and there is a test proving it.

`tool-str-replace-editor/tests/tools.spec.ts:448-456`: file = `alpha\r\nbeta\nmiddle\nalpha\nbeta`; `old_str` = `alpha\r\nbeta` → **succeeds**, result `replaced\nmiddle\nalpha\nbeta`.
Why: `replaceInFile` matches against the **raw, un-normalized** text from `ctx.fs.readText` (`index.ts:296-297`), so `alpha\r\nbeta` occurs once.

The `edit` tool on the same file: `oldNorm = normalizeLineEndings("alpha\r\nbeta") = "alpha\nbeta"`, which occurs **twice** → `FS_AMBIGUOUS_EDIT`. **[V]** by `fsio.ts:821-832` trace; **[I]** as an end-to-end run (no test does exactly this).

Not a live bug (the two tools never coexist in a default profile), but it is a **latent trap**: enabling the README-documented `str_replace_editor` insert patch on top of a profile that already has `edit` gives the model two tools with different matching semantics on the same file.

### 2.9 Parser strictness

- **[V]** Codex parses leniently by default: `const PARSE_IN_STRICT_MODE: bool = false` (`parser.rs:53`), with the comment that leniency is applied for all models because threading a strictness param was "a pain" (`parser.rs:47-52`). Markers tolerate leading/trailing whitespace (`parser.rs:24-25`; fixtures `017_whitespace_padded_hunk_header`, `018_whitespace_padded_patch_markers`, `020_whitespace_padded_patch_marker_lines`).
- **[V]** Codex dispatches two *different* parsers over the same input: the Lark grammar (constrained decoding), `parse_patch` in `parser.rs` (tool + handler path, `core/src/tools/handlers/apply_patch.rs:390`), and a third `StreamingPatchParser` for live UI progress events (`apply-patch/src/streaming_parser.rs`; `apply_patch.rs:87-155`). Three parsers agreeing is not guaranteed. **[I]** — no cross-parser equivalence test found.
- **[V]** Duplicate-path rejection is stricter than DSH: `try_verify_apply_patch_args` errors with `multiple operations target <path>` (`invocation.rs:235-241`). **This means a model cannot `*** Add File:` and then `*** Update File:` the same path in one patch** — a common real intent (create a file, then append to it) is impossible in one call.
- **[V]** Grammar detail: the advertised Lark allows `filename: /(.+)/` (`apply_patch.lark:10`) while `parser.rs:15` documents the same — but `add_line`/`change_line` are `/(.+)/` in the doc comment (`parser.rs:16,21`) vs `/(.*)/` in the actual grammar (`apply_patch.lark:11,16`). The doc-comment copy is stale; `/(.*)/` is what permits `+` for an empty line. **[V]**

---

## 3. Cost: tokens and round trips

### 3.1 Round-trip accounting

| Scenario | DSH | Codex |
|---|---|---|
| Edit a file never read this session | **2 turns**: `read` → `edit` (gate: `FS_NOT_OBSERVED`, `error.ts:23-29`) | **1 turn**: `apply_patch` verifies by reading internally |
| Edit an already-read file | **1 turn** | **1 turn** |
| Edit after an out-of-band change | **2 turns**: stale error is actionable, `read` then retry (`integration.spec.ts:186-198`) | **1 turn**, but **may apply at a wrong shifted site** (§2.3) |
| `write` a brand-new file | **1 turn** (unobserved → `createIfAbsent`, `fs-observation-policy/src/index.ts:65-71`) | **1 turn** |
| Overwrite an existing file | **2 turns minimum** (read first) | **1 turn**, silently (`tool.rs:348`) |
| N single-line edits in one file | **1 turn, N tool calls** — all emitted in one assistant step; each classifies `exclusive` and becomes a barrier, but barriers live *inside* one step (`core/agent-loop/src/tool-calls.ts:83-101`, `:199-213`) | **1 turn, 1 call** |
| N files, coherent change | **1 turn, N calls**, no transaction | **1 turn, 1 call**, no transaction |

**[V]** DSH's read-before-edit gate is **freshness-based, not coverage-based**: a `read` of `offset:1,limit:1` authorizes editing line 12 of a 20-line file, because the gate records a *version*, not a region. Test: `tool-fs/tests/integration.spec.ts:160-172` (*"lets a WINDOWED read authorize an edit when the file is unchanged (freshness, not full-view)"*). This is deliberately correct — the CAS makes region coverage unnecessary — but it means the "read first" cost is one call, not a full-file read.

So the round-trip delta is **exactly one extra turn on the first edit of each file**, and zero thereafter (a successful `write`/`edit` refreshes the observed version — `fs-observation-policy/tests/policy.spec.ts:123`, `fs-local/tests/filesystem.spec.ts:777-786`).

### 3.2 Token cost per edit

Measured character counts of representative payloads (estimated tokens = chars/4, a code-appropriate ratio):

| Operation | DSH | Codex |
|---|---|---|
| One-line edit, minimal | `edit` call **131 ch / ~32 tok** | patch, no context **131 ch / ~32 tok** |
| One-line edit, prompt-conformant | same **131 ch / ~32 tok** | 3+3 context **368 ch / ~92 tok** → **2.8×** |
| Create a 12-line file | `write` **791 ch / ~197 tok** | `*** Add File:` **814 ch / ~203 tok** → ~1.03× |
| Result text | `The file X has been updated successfully.` (~48 ch) | `Success. Updated the following files:\nM path\n` (~50 ch) |

**Where Codex's real cost is:** the 3-lines-each-side convention the prompt demands (`core/prompt_with_apply_patch_instructions.md:299`). On a 1-line change inside a long function that is **~60 extra tokens of pure context every edit**. Over a 200-edit task that is ~12 k tokens of context the model must re-emit from memory and the harness must re-read — and it is exactly the context that goes stale and causes the fuzzy-match-to-wrong-line failure in §2.1.

**Where DSH's real cost is:** the extra round trip (§3.1) and the *literalness tax*. Because matching is byte-exact, the model must reproduce the anchor perfectly; the usual remedy for a near-miss is to read a wider window and try again. `tool-fs/src/read.ts:74` pushes exactly this: *"Use offset and limit to continue reading large files."*

### 3.3 The asymmetry that matters most

DSH `edit` requires the model to know **the exact bytes**. Codex `apply_patch` requires the model to know **approximately the lines**. For a model that just read the file, both are cheap. For a model editing from memory of a partially-read or truncated file, Codex's fuzzy matcher converts a would-be failure into a success — sometimes into a *wrong* success. **[I]**

DSH partially compensates with a strong error vocabulary, all actionable:
- `old_string was not found in "<path>"` (`fsio.ts:828`)
- `old_string matched N times in "<path>"; provide a more specific old_string or set replace_all to true` (`fsio.ts:831`)
- `No replacement was performed, old_str \`…\` did not appear verbatim in <path>.` (`tool-str-replace-editor/src/index.ts:301`)
- `No replacement was performed. Multiple occurrences of old_str \`…\` in lines [1, 4]. Please ensure it is unique` (`index.ts:308`)
- `cannot modify "<path>": file has not been read — read the file, then retry` (`error.ts:25`)
- `… file changed since it was read — re-read the file, then retry` (`error.ts:31`)

Codex's failure vocabulary is thinner — `Failed to find expected lines in <path>:\n<old_lines>` (`file_update.rs:210-214`) and `Failed to find context '<ctx>' in <path>` (`file_update.rs:109-111`) — and, notably, **does not say where it looked or what the closest match was**.

---

## 4. Read-side comparison

### 4.1 DSH `read` — the model gets an explicit, well-labelled contract

**[V]** Schema (`tool-fs/src/read.ts:78-84`): `file_path` (required), `offset` (1-based, default 1), `limit` (default **2000**, and `limit > 2000` is rejected with `limit must be less than or equal to 2000`, `read.ts:59`).

Envelope, verbatim (`tool-fs/src/read-render.ts:152-170`):
```
<path>/abs/a.txt</path>
<type>file</type>
<content>
1: hello
2: world

(End of file - total 2 lines)
</content>
```
with exactly three footers:
- byte-capped: `(Output capped. Showing lines 1-37. Use offset=38 to continue.)`
- more remain: `(Showing lines 1-2000 of 4310. Use offset=2001 to continue.)`
- EOF: `(End of file - total 4310 lines)`

**Every read-side property the axis asks about is satisfied:**
- **Line numbers:** yes, `N: ` prefix, 1-based, contract-tested (`tool-fs/tests/tools.spec.ts:225-232`, `read-render.spec.ts`).
- **Exact bytes:** yes for lines ≤ 2000 chars. **No** for longer ones — truncation is explicit and self-describing: `... (line truncated to 2000 chars)` (`read-render.ts:69-71`; tests `read-render.spec.ts:51`, `:82-85`, `tools.spec.ts:727`).
- **Truncation warnings:** yes, three distinct, machine-checkable footers. The renderer even distinguishes byte-cap truncation from line-cap truncation (`read.ts:110` recomputes `truncatedByBytes` from the structured window).
- **Limits:** three independent caps — 2000 lines, 2000 chars/line, 50 KiB total (`read-render.ts:11-14`), all plugin-configurable (`tool-fs/src/index.ts:36-41`).
- **Offset past EOF:** clean error, not an empty page — `offset N is out of range for "<path>" (M lines)` (`read-render.ts:96-98`).
- **Large files:** streams at/above 10 MiB, and **also streams when the backend reports no size at all**, so a size-less backend can never buffer unboundedly (`read.ts:143-147`, comment at `:143-144`; tests `tools.spec.ts:311-333`). The chunk scanner caps the current line buffer at `maxLineLength + 1`, so **one newline-free giant line cannot grow memory** (`read-render.ts:4, 117-125`).
- **Binary / invalid UTF-8:** rejected with `FS_NOT_TEXT` (`fsio.ts:392-400`; test `tool-fs/tests/integration.spec.ts:126`).
- **Version tracking:** yes — `fs/observed` fires with the stat version (`read.ts:163`), which is what authorizes the later edit.
- **`read` is concurrency-safe** (`read.ts:136` `isConcurrencySafe: () => true`), so N reads overlap; `write`/`edit` do not declare it and therefore classify `exclusive` (`core/tools/src/index.ts:1303-1312`).

### 4.2 The one real read-side gap in DSH

**Truncated long lines cannot be used as `old_string`.** A 3 000-char minified line reads back as 2 000 chars + `... (line truncated to 2000 chars)`. Copying that as `old_string` cannot match. The model's only recourse is `grep` (which caps previews at 2 000 bytes with `(line truncated)`, `tool-fs-search/src/search-core.ts:328`) or bash. **[V]** for the truncation, **[I]** for the model actually hitting it — **no test covers the read-truncate-then-edit-fails round trip**, in either the `tool-fs` or `tool-fs-search` suites. This is the highest-value missing test on the DSH read side.

Secondary: **[V]** the grep output format is `Line <n>: <text>` grouped under a bare path line (`tool-fs-search/src/grep.ts:191-203`), i.e.
```
src/a.ts
Line 12: const x = 1

src/b.ts
Line 3: const x = 2
```
not `path:line:content`. It is 7 extra characters per match plus a blank line per file, and it diverges from the `rg`-native format the model has overwhelmingly seen in pretraining. `GREP_MAX_MATCHES = 250` (`grep.ts:29`), `GLOB_MAX_RESULTS = 100` (`glob.ts:25`), and over-cap results are **spilled to a readable file** with a recovery locator rather than silently dropped (`grep.ts:215-225`, `glob.ts:213-228`) — that part is better than most harnesses.

### 4.3 Codex has no read tool at all

**[V]** There is no `read_file`, `list_dir`, or `grep_files` tool in this SHA. The only `read_file` references are the MCP filesystem server (`core/src/tools/handlers/mcp.rs:695, 704, 711, 731`), the `notes` extension namespace (`core/src/tools/handlers/extension_tools.rs:86`), and internal `ExecutorFileSystem::read_file` calls (`core/src/agents_md.rs:146`, `core/src/tools/handlers/view_image.rs:175`). A full enumeration of `registry.add(...)` in `core/src/tools/spec_plan.rs` (lines 1020-1273) yields: exec_command/shell, write_stdin, apply_patch, view_image, update_plan, web_search, MCP + MCP resources, agents, sleep, current_time, get_context_remaining, request_permissions, plugin install.

**So Codex's read-side is `shell`.** The system prompt says so (`core/gpt_5_codex_prompt.md:5`): *"When searching for text or files, prefer using `rg` or `rg --files` respectively because `rg` is much faster than alternatives like `grep`."*

Consequences:

| Property | DSH `read` | Codex `shell` |
|---|---|---|
| Line numbers | guaranteed, structured | only if the model writes `cat -n` / `sed -n` / `rg -n` |
| Truncation warning | explicit footer | 1 MiB hard byte cut, **silent** (`exec.rs:79`, `:715-719`) |
| Structure | `<path>/<type>/<content>` envelope with persisted meta | opaque stdout/stderr text |
| Model sees stderr and exit code | n/a (typed errors) | yes |
| Extra round trip | no | the model must first decide the right command |
| Cost | fixed, bounded | unbounded until the 1 MiB cap; a stray `cat` of a large file burns ~250 k tokens and truncates |
| Output cap | 2000 lines / 50 KiB, pageable via `offset` | 1 MiB, no pagination — re-run with `sed -n` |

**Verdict:** DSH's read side is unambiguously better-specified. It gives a paginated, line-numbered, explicitly-truncated, byte-exact-for-normal-lines view, and it is the same primitive that authorizes the subsequent edit. Codex trades that for full shell expressiveness. On this axis DSH is stronger, and the gap is largest for exactly the case the axis asks about — **large files**: DSH pages deterministically to a known total line count; Codex silently cuts at 1 MiB and requires the model to notice and re-run with a different command.

**[I]** Worth noting the incentive effect: because Codex's read is unbounded-by-intent, a model that `cat`s a 500-line file pays for 500 lines it may not need; DSH's `limit` default of 2000 with an explicit "Use offset=N to continue" footer models the pagination decision for the model.

---

## 5. Post-edit verification, formatting, linting

**Neither harness verifies that an edit produced syntactically valid code, and neither runs a formatter or linter automatically.** **[V]** for both.

- **DSH:** no post-write hook exists on the edit path. `tool-fs/src/edit.ts:113-147` ends at `ctx.emit('fs/observed', …)`. The only related guidance is a prompt section telling the model to read before editing (`edit.ts:76-82`) and the `tool:write` section (`write.ts:62-70`). Separately, `packages/experimental/tool-agent-team/src/index.ts:35` warns that *"Bash, formatters, code generators, and scripts are not fully protected by the filesystem version guard"* — i.e. DSH is explicitly aware that a formatter would break the CAS chain, and chose not to wire one in. **[V]**
- **Codex:** the prompt tells the *model* to do it, not the harness (`core/prompt_with_apply_patch_instructions.md:155`): *"you can suggest or use formatting commands to ensure that your code is well formatted. If there are issues you can iterate up to 3 times to get formatting right… If the codebase does not have a formatter configured, do not add one."* Approval-mode-dependent (`:161-162`): in `never` mode run tests/lint proactively; in `untrusted`/`on-request` hold off until the user is ready. **[V]** No formatter invocation exists in the Rust edit path.

**Closest thing either has to verification:** Codex's pre-flight verify (§2.3) validates that the patch *matches*, not that the result *compiles*; DSH's CAS validates that the file hasn't *moved*. Both are structural, not semantic.

**[I]** This is the single largest shared gap on this axis, and it is cheap to close on DSH's side specifically because DSH already has the version-CAS machinery: a post-edit formatter could run inside the same per-target lock and re-derive the version, keeping the guard chain intact.

---

## 6. Concurrency and multi-file edits

| Question | DSH | Codex |
|---|---|---|
| Several edits in **one tool call**? | **No.** `edit` takes exactly one `old_string`/`new_string` pair (`edit.ts:87-93`). `replace_all` is the only multiplicity, and it is same-string. | **Yes.** One patch = N hunks across N files (`parser.rs:6` `hunk+`). |
| Several edits in **one model turn**? | **Yes** — the model emits N tool calls in one assistant step; `exclusive` ones serialize as barriers but all settle in that step (`core/agent-loop/src/tool-calls.ts:83-101, 199-213`) | **Yes**, and in one call |
| Same file twice in one call? | N/A (one file per call) | **Rejected**: `multiple operations target <path>` (`invocation.rs:235-241`) — so add-then-update or update-then-move-then-update is impossible in one patch |
| Multiple files, coherent rename + edit? | N calls: `write` new + `edit` old, or `bash` `git mv` + `edit` | **One call**: `*** Update File: a` + `*** Move to: b` + chunks (`parser.rs:14,18`) |
| Per-file atomicity | **Yes** — staging dir + temp + `handle.sync()` + `rename`, or hard-link no-replace for create (`fsio.ts:588-670`) | **No** — `write_file` does `set_len(0)` then `write_all` in place, **no fsync** (`exec-server/src/no_follow/unix.rs:122-142`); a mid-write failure truncates the original |
| Transaction across files | **No** | **No** — explicit, tested non-rollback (`scenarios/015`, `tool.rs:418-437`) |
| Concurrent-safety classification | `read` = parallel; `write`/`edit` = exclusive barrier (`core/tools/src/index.ts:1303-1312`) | apply_patch is one tool; the runtime supports sandbox escalation + retry (`runtimes/apply_patch.rs:116-123`) |
| Isolation between agents | **Per-session observed state** via `WeakMap<session, …>`; owner A cannot authorize owner B (`fs-observation-policy/src/index.ts:28, 36-41`; test `policy.spec.ts:158-176`) | No equivalent; two agents patching the same file is first-writer-wins with no detection |

**The isolation point deserves emphasis [V]:** DSH's `FS_NOT_OBSERVED` is keyed on `session`, so a subagent must read a file before editing it even if the parent already read it. That is a real cost for multi-agent workflows (each agent re-reads) and a real safety property (no agent acts on another's stale view).

**[V]** DSH's per-target lock is what actually makes one-file concurrency safe: `withLock(target.targetKey, …)` wraps probe → stale check → read → match → write (`fs-local/src/index.ts:263-291`). Note `str_replace_editor` does **not** use that lock — it does read-then-write with only the version CAS (`tool-str-replace-editor/src/index.ts:296-322`). It still fails closed (a racing writer bumps the version, the `replaceIfVersion` write rejects), but it can burn a read to do so, and it uses `intent.version` rather than the `info.version` it just stat'ed, widening that window to the whole read-modify-write. **[V]** for the code; **[I]** for the practical impact.

---

## 7. Is the absence of an `apply_patch` equivalent a real weakness for DSH?

**Short answer: it is a real but narrow weakness, and DSH already owns the two capabilities that mostly neutralize it.**

### 7.1 What DSH already has

1. **N calls in one turn.** **[V]** The agent loop dispatches every tool call the model emitted in a step; exclusivity is a *barrier within the step*, not a turn boundary (`core/agent-loop/src/tool-calls.ts:83-101`, `:199-213`; `runGroup` doc at `:113-121` states results "commit in model order"). So "one tool call for a multi-file coherent change" ≈ "N tool calls in one assistant message" for the model's purposes — one model round trip either way. The costs are (a) N× the per-call JSON envelope, (b) N× the confirmation line, (c) no atomicity guarantee *within* the batch.
2. **`run_code` / PTC mode.** **[V]** `ToolPresentationMode = 'native' | 'ptc' | 'both'` (`core/tools/src/index.ts:670-694`), shipped as a real preset: `packages/bundle/web-app/presets/ptc.patch.yml:8` declares preset `ptc`, `:147` sets `mode: ptc`, `:119-120` mounts `dsh-workflow-ptc`. In PTC mode the model writes one program that sub-dispatches `edit`/`write` any number of times, with real control flow — loops, conditionals, error handling. **This is strictly more expressive than `apply_patch`**: `apply_patch` is a fixed grammar with no branching, whereas a PTC script can read a result and decide the next edit.

### 7.2 Why it is still a weakness

1. **It is not the default.** The shipped `standard` and `base` compositions mount native `tool-fs`; the PTC preset is a separate opt-in. Most DSH sessions therefore pay N envelopes and get N confirmations where Codex pays one.
2. **No add-then-edit of a created file in one shot.** DSH `write` creates; a subsequent `edit` in the same batch needs the version from `write`'s `fs/observed` — which *does* work, since `write` refreshes the observed state (`fs-observation-policy/tests/policy.spec.ts:123`, `integration.spec.ts:217-221` "supports a full write→edit cycle without an intervening read"). So this is actually fine — **[V]**. (Codex is the one that *cannot* do it, because of the duplicate-path rejection at `invocation.rs:235-241`.)
3. **No rename.** `*** Move to:` (`parser.rs:18,42`) has no DSH tool equivalent. Renames require `bash git mv`. This is the clearest genuine gap.
4. **No partial-progress report.** A failed DSH batch reports which calls failed, but there is no `AppliedPatchDelta`-style "here is exactly what landed" object. The agent loop records per-call results, so the model *can* reconstruct it — at N× the tokens.
5. **The "one coherent change" semantic is missing.** A patch expresses intent ("this refactor touches 4 files"); N calls express 4 separate intents. When edit 3 of 4 fails, the model must decide on its own whether to roll back edits 1-2. Codex has the same problem (§2.6) but at least reports the delta explicitly.

### 7.3 Honest verdict

**[I]** The absence is a **moderate, not severe** weakness. It costs tokens and a rename primitive, not capability — and DSH's per-file atomicity plus version CAS are stronger guarantees than Codex's non-atomic multi-hunk apply over a destructive in-place write. DSH's `edit` is the *safer* primitive; `apply_patch` is the *more economical* one. Neither is dominant.

The sharpest way to state it: **Codex optimises for expressing a change; DSH optimises for guaranteeing one.**

---

## 8. Summary scorecard

| Dimension | Winner | Margin |
|---|---|---|
| Whitespace/indent robustness | **Codex** | Large — 4-pass fuzzy vs byte-exact |
| Duplicate-anchor safety | **DSH** | Large — hard error with line numbers vs silent first-match |
| Stale-read safety | **DSH** | Decisive — version CAS in-lock vs unchecked TOCTOU between verify and apply |
| Silent-destruction safety | **DSH** | Large — `FS_NOT_OBSERVED` vs silent `Add File`/`Move to` overwrite |
| Multi-file expression | **Codex** | Moderate — 1 hunk-set call vs N calls (PTC narrows it) |
| Rename | **Codex** | Clear — `*** Move to:` vs no equivalent |
| Tokens per single-line edit | **DSH** | 2.8× on prompt-conformant patches |
| Round trips (first edit of a file) | **Codex** | 1 vs 2 |
| Read-side quality | **DSH** | Large — structured, paginated, explicit truncation vs `shell` + silent 1 MiB cut |
| Per-file atomicity | **DSH** | Decisive — temp+fsync+rename vs in-place `set_len(0)` + write, no fsync |
| Whole-patch atomicity | **Tie (both fail)** | Codex's non-atomicity is explicitly tested |
| Partial-failure reporting | **Codex** | `AppliedPatchDelta` with `is_exact()` |
| Post-edit verification/formatting | **Tie (both absent)** | Both delegate to the model |
| Error message actionability | **DSH** | Every guarded failure names the remedy |
| Large-file performance | **DSH** | Codex's `apply_replacements` is O(k·n) |
| Line-ending preservation | **Codex** | Mixed CR/CRLF/LF preserved per line; DSH collapses to majority style |

---

## 9. Prioritized Recommendations

Effort/impact are relative to a DSH-side change of this size. Every recommendation is DSH-side unless noted; none require touching Codex.

---

### R1. Anchor-drift recovery: report the closest match on `FS_EDIT_NOT_FOUND`

**Impact: H · Effort: M**
**Files:** `packages/fs/fs-local/src/fsio.ts` (`applyLiteralEdit`, ~:814-834), `packages/fs/tool-fs/src/error.ts`, `packages/fs/tool-str-replace-editor/src/index.ts` (`replaceInFile`, ~:276-328)

**Problem.** DSH's exact-match rule is right, but the *diagnostic* is a dead end: `old_string was not found in "<path>"` tells the model nothing about *why*. The observed recovery path is "read more, guess again" — often several turns. Codex recovers from the analogous situation automatically (fuzzy match in `seek_sequence.rs:39-70`).

**Design.** Keep exact-only matching (do **not** adopt fuzzy application — §2.2 shows why). Add a *diagnostic-only* nearest-match computation, run solely on the failure path:

```ts
// fsio.ts — new, called only when replacements === 0
interface AnchorHint { line: number; text: string; kind: 'rstrip' | 'trim' | 'similar' }
function nearestAnchor(content: string, needle: string, maxHints = 3): AnchorHint[]
```
Semantics:
1. Split `content` and `needle` into lines; slide a `needle.length`-line window over the file.
2. Score each window: pass 1 `trim_end` equality (kind `rstrip`), pass 2 `trim` equality (kind `trim`), pass 3 normalized edit distance ≥ 0.8 on the joined window (kind `similar`).
3. Return the best `maxHints` windows in file order.

Then extend the error text (compose in `error.ts`, keeping `FS_EDIT_NOT_FOUND` as the code):

```
old_string was not found in "/repo/src/a.ts".
Closest matches (whitespace-insensitive):
  line 42:   if (ready) {          [indentation differs]
  line 118: if (ready) {           [exact after trim]
Include the exact file text in old_string, or use read with offset to inspect around line 42.
```

For `str_replace_editor`, the same hint appends to `did not appear verbatim in <path>.` (`index.ts:301`).

**Why this is the right shape:** it converts the most common DSH edit failure from "read and guess" into "fix the two characters". It never changes what gets applied, so it cannot introduce a wrong-site edit — unlike adopting Codex's fuzzy matcher. Bounded to 3 hints × ~120 chars ≈ 100 tokens on a failure path only.

**Tests:** assert hints for (a) trailing-whitespace drift, (b) indentation drift, (c) no-hint case on unrelated content, (d) hint never appears on success, (e) `/tmp`-style CRLF drift reports the right line.

---

### R2. Optional multi-hunk `edit` with all-or-nothing semantics per file

**Impact: H · Effort: L** (the provider already supports everything needed)
**Files:** new hunks in `packages/fs/tool-fs/src/edit.ts` (schema + execute), `packages/fs/fs-local/src/fsio.ts` (a `applyLiteralEdits` batch fn next to `applyLiteralEdit` ~:814)

**Problem.** N single-line edits in one file need N calls and N confirmations (§3.1). Codex does this in one call. DSH's own §6 answer ("emit N calls") works but is token-inefficient and, worse, **not all-or-nothing**: if edit 3 of 5 fails, edits 1-2 are already on disk, and each intermediate state passed through the CAS — so the model must reason about a partially-applied sequence.

**Design.** Add an optional `edits` array; `old_string`/`new_string` become optional and mutually exclusive with it:

```jsonc
{
  "file_path": { "type": "string", "required": true },
  "old_string": { "type": "string", "description": "Literal text to replace. Mutually exclusive with `edits`." },
  "new_string": { "type": "string", "description": "Literal replacement text." },
  "replace_all": { "type": "boolean" },
  "edits": {
    "type": "array",
    "description": "Apply several replacements to this file in one atomic call. All hunks are matched against the file as it was at the start; if any hunk fails to match exactly once, nothing is written.",
    "items": {
      "type": "object",
      "required": true,
      "additionalProperties": false,
      "properties": {
        "old_string": { "type": "string", "required": true },
        "new_string": { "type": "string", "required": true }
      }
    }
  }
}
```

Semantics (all inside the existing `withLock`, one version CAS, one atomic write):
1. Reject `edits` combined with `old_string`/`new_string`/`replace_all`; reject `edits.length === 0`; reject `edits.length > 50` (guards a runaway array).
2. Match **every** hunk against the *original* content. Each must match exactly once (`replace_all` is not offered per-hunk — ambiguity should be fixed by better anchors, not silently widened).
3. Reject **overlapping** hunk spans with a clear message naming the two indices — otherwise hunk 2's match offsets are invalidated by hunk 1.
4. If all hunks match: apply them in **descending offset order** (so earlier splices cannot shift later ones), write once, return one version.
5. If any hunk fails: write nothing, return `FS_EDIT_NOT_FOUND` / `FS_AMBIGUOUS_EDIT` **plus the failing hunk's index and the R1 hint**.

Success text: `The file <path> has been updated with N replacements successfully.`

**Why not full-patch semantics:** this deliberately stays *per-file*, so it composes with DSH's per-file atomicity. It adds expressiveness without adding a cross-file transaction DSH cannot honour.

**Tests:** all hunks applied atomically; a mid-list failure leaves the file byte-identical; overlapping hunks rejected; descending-offset correctness when hunk 1 is above hunk 2 and both change length; CRLF file round-trip; the batch takes exactly one `fs/observed` emission.

---

### R3. Warn when `old_string` could not have come from the read window

**Impact: M · Effort: M**
**Files:** `packages/fs/fs-observation-policy/src/index.ts` (record window metadata), `packages/fs/tool-fs/src/edit.ts` (`parseEditArgs`/execute)

**Problem.** §4.2: `read` truncates lines > 2000 chars with `... (line truncated to 2000 chars)`, and `str_replace_editor view` clips at 16 000 chars. A model that copies that text as `old_string` cannot match, and nothing tells it why. No test covers this in either suite. **[V]**

**Design.** Extend the observation record from a bare version to a window descriptor:

```ts
type FsObservation =
  | { kind: 'absent' }
  | { kind: 'present'; version: FsVersion; window?: { offset: number; throughLine: number; truncatedByBytes: boolean; truncatedLines: number[] } }
```
Populate it in `read.ts:163` from `window.lines` (line numbers whose `text` ends with the truncation suffix — detectable at `read-render.ts:70`) and the footer state. Then in `edit`'s failure path, if `old_string` contains `... (line truncated to` or is longer than `maxLineLength`, append:

```
Note: line 42 was truncated when you read it (2000-char limit). old_string cannot
match truncated text — use grep with a shorter pattern, or bash to inspect the full line.
```

Also emit a **pre-emptive warning on the success path** is tempting but wrong (it would fire on legitimate edits of short lines); keep it failure-path-only.

**Tests:** a 3 000-char line, read (truncated), then edit with the truncated text as `old_string` → error carries the note; edit with a short substring of the same line → succeeds with no note.

---

### R4. Surface the applied diff to the model on failure paths

**Impact: M · Effort: S**
**Files:** `packages/fs/tool-fs/src/edit.ts` (`render`, ~:104-107), `packages/fs/tool-fs/src/write.ts` (`render`, ~:97), `packages/fs/tool-fs/src/diff.ts`

**Problem.** DSH already computes the exact applied hunks with 3 lines of context (`diff.ts:35-59`) and then **throws them away for the model**, routing them only to `presentationMeta` for the UI (`edit.ts:108-111`). The model's only feedback is `The file X has been updated successfully.` — a 48-char string carrying zero information. Codex's `Success. Updated the following files:\nM path` is comparably thin, but for a *batch* it at least enumerates the files.

**Design.** Keep the success text as-is for the common single-line case (adding a diff to every successful edit would be a large token regression — measured at ~368 chars for one hunk). Instead:
1. When `replaceAll` replaced **`N > 1`** occurrences, append the count: `The file <path> has been updated. 7 occurrences were replaced.` (currently `edit.ts:66` says "All occurrences" without a number — the provider already returns `replacements` at `fsio.ts:813` but `edit.ts:141-146` drops it).
2. When a **batch** edit (R2) partially matched before failing, include the per-hunk outcome list.
3. When the applied diff exceeds a configurable threshold (say > 20 changed lines), append a truncated unified hunk so the model can self-check without a re-read.

**Tests:** `replacements` count surfaced; threshold behaviour; success text unchanged for the 1-line case.

---

### R5. Make the read-before-edit gate region-aware, or say plainly that it is not

**Impact: M · Effort: M**
**Files:** `packages/fs/fs-observation-policy/src/index.ts` (`editIntent`, :78-88), `packages/fs/tool-fs/src/error.ts`

**Problem.** §3.1: a 1-line windowed read authorizes editing line 12 of 20 — and a test asserts this is intended (`integration.spec.ts:160-172`). It is defensible (the CAS makes coverage moot *for staleness*), but it is **not** protection against editing a region the model never actually saw. The model can hold a stale mental model of lines 6-20 while the file is unchanged, and the CAS will happily let it edit them.

**Design.** Two options; prefer (b).
- (a) Require the edit's `old_string` to fall inside a read window. Rejected: legitimately over-strict, forces a full-file read for a one-line change, and breaks the "full write→edit cycle without an intervening read" path (`integration.spec.ts:217`).
- (b) **Keep the gate as-is; fix the prompt.** Make the guidance explicit that the gate proves *freshness*, not *coverage*: change `edit.ts:81` to read `Read a file before editing it (the default fs-observation-policy requires it, and the guard proves the file is unchanged — not that you have seen the region you are editing).` **[V]** `edit.ts:81` currently says only "Read a file before editing it (the default fs-observation-policy requires it), unless you just created or edited it in this session."

Option (b) costs ~25 tokens of system prompt and removes a false sense of safety.

**Tests:** prompt-section snapshot updated; existing freshness tests unchanged.

---

### R6. A `move` / rename tool

**Impact: M · Effort: S**
**Files:** new `packages/fs/tool-fs/src/move.ts`, registered in `packages/fs/tool-fs/src/index.ts` alongside `applyWriteTool`/`applyEditTool`; `ctx.fs` needs a `rename` primitive

**Problem.** §7.2 item 3: the only genuine capability gap versus `apply_patch` is `*** Move to:` (`parser.rs:18,42`). Today the model must shell out to `git mv`, which **bypasses the version guard entirely** — the very hazard `packages/experimental/tool-agent-team/src/index.ts:35` warns about.

**Design.**

```jsonc
{
  "from_path": { "type": "string", "required": true, "description": "Existing path to move." },
  "to_path":   { "type": "string", "required": true, "description": "Destination path. Parent directories are created." },
  "overwrite": { "type": "boolean", "description": "Allow replacing an existing destination file. Defaults to false." }
}
```

Semantics, mirroring DSH's existing safety posture:
- `fs/edit-intent` on `from_path` → requires a prior read (`FS_NOT_OBSERVED`), CAS on the observed version.
- Destination that exists and `overwrite !== true` → refuse: `cannot move to "<dest>": file exists. Read it and pass overwrite: true to replace it.` This is the direct answer to Codex's silent-overwrite failure (`tool.rs:325-346`).
- `overwrite: true` requires a prior read of the *destination* too — reusing the `edit-intent` gate.
- One atomic `rename(2)` within a filesystem; cross-device falls back to copy + fsync + unlink with the destination published through the existing `writeFileAtomic` staging path (`fsio.ts:588`).
- Emit `fs/observed` as `absent` for `from_path` and `present` for `to_path`.
- Success: `Moved <from> to <to>.`

**Tests:** move succeeds and both observations update; move onto an unread existing file refuses; `overwrite: true` after reading succeeds; cross-device fallback preserves bytes and mode; moved-to path is immediately editable without a re-read.

---

### R7. Cover the read-truncation → edit failure round trip (test-only)

**Impact: M · Effort: S**
**Files:** `packages/fs/tool-fs/tests/integration.spec.ts`, `packages/fs/tool-str-replace-editor/tests/tools.spec.ts`

**Problem.** §4.2: this is the highest-value **untested** behavior on the DSH read side. R3 proposes fixing the message; without a test, nothing pins it.

**Design.** Add, in the `read`→`edit→disk` integration block (`integration.spec.ts:142`):

```ts
it('a truncated long line cannot be used as old_string, and the error says why', async () => {
  const long = 'x'.repeat(3000)
  await writeFile(join(dir, 'long.txt'), `before\n${long}\nafter`)
  const read = await call('read', { file_path: 'long.txt' })
  expect(text(read)).toContain('... (line truncated to 2000 chars)')
  // The text the model saw, reused verbatim, cannot match.
  const result = await call('edit', {
    file_path: 'long.txt',
    old_string: `${long.slice(0, 2000)}... (line truncated to 2000 chars)`,
    new_string: 'replaced',
  })
  expect(result.isError).toBe(true)
  expect(result.error).toMatchObject({ info: { code: 'FS_EDIT_NOT_FOUND' } })
  expect(text(result)).toContain('line 2 was truncated')   // R3
})
```
Plus the `str_replace_editor` `view`-clip analogue (its cap is chars, not lines, so the failing anchor is the tail of the clipped block).

Also worth adding, per §2.8: an integration test asserting the **documented** divergence — the same mixed-EOL file edited through `edit` (ambiguous) versus `str_replace_editor` (succeeds) — so the two surfaces' semantics are pinned rather than accidental.

---

### R8. Bound the `view` command's memory before the cap is applied

**Impact: L · Effort: S**
**Files:** `packages/fs/tool-str-replace-editor/src/index.ts` (`formatFileView`, :138-185)

**Problem.** `view` calls `ctx.fs.readText` (whole file), then `content.split('\n')` into an array, *then* applies `maxOutputChars` truncation (`index.ts:144`, `:184`). On a 200 MB log file this allocates the entire file **and** an array of every line before discarding ~all of it. `tool-fs`'s `read` solved exactly this with streaming + a bounded line buffer (`read-render.ts:111-144`); `str_replace_editor` did not.

**Design.** Either route `view` through `buildWindow` (`read-render.ts`) with `{offset: viewRange?.[0] ?? 1, limit: viewRange ? finalLine - initialLine + 1 : maxLinesFor(maxOutputChars), maxLineLength, maxBytes}`, or add an 8 MiB pre-read guard that returns `FS_TOO_LARGE` with a pointer to `read`'s pagination. Prefer the former — it also inherits the "one newline-free giant line cannot grow memory" property.

**Tests:** `view` on a file above the stream threshold uses `streamText`, not `readText` (mirroring `tool-fs/tests/tools.spec.ts:311-321`); `view_range` still numbers lines correctly against the file, not the window.

---

### R9. (Codex-side, for the comparison record) — four concrete Codex weaknesses worth naming

Not actionable by DSH, recorded because they are the other half of the tradeoff:

1. **In-lock CAS before matching.** `apply_hunks_to_files` re-derives content with no version check (`apply-patch/src/lib.rs:609-616`), so a change between verify and apply is either a clean failure or a silent wrong-site edit. Compare `fs-local/src/index.ts:263-275`.
2. **Refuse `Add File` onto an existing file without a read.** `tool.rs:348-364` pins the current silent overwrite. One `if exists && !explicit_overwrite { return Err(...) }` in the `Hunk::AddFile` arm at `lib.rs:508-535`.
3. **Atomic writes.** `exec-server/src/no_follow/unix.rs:122-142` truncates in place and never fsyncs. Temp file in the destination directory + `sync_all()` + `rename` (as DSH does at `fsio.ts:588-670`) closes a data-loss window that `lib.rs:489-491` already admits exists but no test covers.
4. **`String::truncate` on possibly-multibyte stdout.** `core/src/exec.rs:715-719` panics if the 1 MiB cap lands mid-character; needs a char-boundary-safe truncation.

---

## 10. Confidence and gaps

**High confidence (read the full implementation and its tests):** DSH `edit`/`write`/`read` semantics, the observation-policy gate, the version CAS, atomic-write mechanics, all failure strings, all caps and footers; Codex `apply_patch` grammar, `seek_sequence` fuzziness ladder, `compute_replacements` cursor semantics, verify-vs-apply re-derivation, non-atomicity, in-place destructive `write_file` with no fsync, the silent-overwrite tests, and the absence of read/grep file tools.

**Lower confidence / not verified:**
- **[I]** No harness benchmark was run; token figures are character counts of hand-built payloads with a chars/4 estimate, not a real tokenizer over a real task.
- **[I]** The "trim-match lands on the wrong line" hazard in `seek_sequence` is derived from reading the descending-strictness loop (`seek_sequence.rs:39-112`); no test exercises it and I did not construct a repro.
- **[I]** Codex's `apply_replacements` quadratic cost is derived from `Vec::remove`/`Vec::insert` semantics (`file_update.rs:225-246`); no benchmark exists in the repo.
- **[I]** `String::truncate` panic risk at `exec.rs:718` assumes no char-boundary guard upstream; I traced the call site but not the full stdout capture pipeline.
- **[I]** The ENOSPC-mid-write truncation of the original file follows from `set_len(0)` → `write_all` (`no_follow/unix.rs:135-141`) plus the crate's own admission at `lib.rs:489-491`; I did not reproduce it.
- **UNVERIFIED** whether the three Codex patch parsers (Lark grammar, `parser.rs`, `streaming_parser.rs`) agree on all inputs — no cross-parser equivalence test was found.
- **UNVERIFIED** whether the Windows `no_follow` write path (`exec-server/src/no_follow/windows.rs:226`) has the same non-atomic shape; only the Unix path was read. The Windows path is longer (226+ lines) and may differ.
