# Enabling DSH's auto-review (the guardian equivalent)

DSH already ships an LLM-based approval reviewer. It is functionally the same idea
as Codex's `guardian` crate: before a tool call runs, a model assesses the pending action, allows
it, or escalates it to the user.

The catch is that **no bundle mounts it**. `packages/experimental/auto-review/cordis.patch.yml`
is a bare self-insert, and `grep -rn "auto-review" packages/bundle/*/cordis.patch.yml` returns
nothing. Its own README says so: *"The dsh installation ships this layer switched off."*

Nothing in the harness needs to change to turn it on. Verified: the package is present in the
installed app, reading `app.asar`'s header lists `dsh-experimental-auto-review` among the bundled
packages, so the profile can resolve it by name.

## What it does

From `packages/experimental/auto-review/README.md`:

> Before each native or PTC inner tool call, the current agent's provider and model assess the
> pending action; an allowed call executes with Full access, and a denied call asks the user. […]
> It classifies actual effects: ordinary project-local work and exact cleanup of objects created in
> this Session are low risk and allowed; irreversible deletion of pre-existing objects, production
> operations, external writes, and security changes are medium risk and require explicit current
> human or direct-parent authorization of the action, target, and scope. Sensitive exfiltration
> across a trust boundary is high risk and always denied. Ambiguous effects and unresolved
> authorization conflicts are denied.

The design is sound in the ways that matter: denials fail closed, a malformed reviewer response
fails the call instead of allowing it, and the reviewer covers each PTC `tools.*` inner call, not
just the outer one. Codex's guardian is broader. It reasons about seven action kinds including
network, but DSH's is the same shape and is already written.

## Enable it

Two routes. The UI route is safer, because the harness owns the write.

### Route 1 : the Plugins page

Open the Web GUI, go to the sidebar's **Plugins** page, and enable **Auto review**. Then select
`Auto review` from the composer's permission picker (it carries an `EXP` badge) and confirm the
risk dialog. `/permission auto` selects it directly.

### Route 2 : the profile bundle list

Edit `~/.dsh/profiles/desktop/package.json` and add the package to both `dependencies` and
`dsh.profile.bundles`:

```json
{
 "name": "dsh-profile-desktop",
 "private": true,
 "dependencies": {
 "@l33tdawg/dsh-workspace-mcp": "link:/Users/l33tdawg/nodejs-projects/dsh-workspace-mcp",
 "@deepseek-ai/dsh-experimental-auto-review": "*"
 },
 "dsh": {
 "profile": {
 "bundles": [
 "@deepseek-ai/dsh-base",
 "@deepseek-ai/dsh-web-app",
 "@l33tdawg/dsh-workspace-mcp",
 "@deepseek-ai/dsh-experimental-auto-review"
 ]
 }
 }
}
```

Then restart DSH. Prefer this only if the UI route is unavailable, the UI route cannot leave the
profile half-edited.

## Verify

1. The permission picker in the composer shows a fourth option, `Auto review`, with an `EXP` badge.
2. Selecting it raises the current-session risk dialog before it applies.
3. On the next tool call, the transcript's tool card identifies Auto review, and a denied call's
 expanded output states that the body did not execute and shows the reason.

If the picker is unchanged, the layer did not activate. Check the boot log for a resolution error
naming `@deepseek-ai/dsh-experimental-auto-review`, instead of assuming it worked.

## Cost and risk

- **Tokens.** Every tool call adds one reviewer model call. On a session with dozens of calls this
 is a real cost, which is why it is per-session opt-in rather than a default.
- **It can be wrong in both directions**, and its own README says so: it can allow unsafe actions
 and it can deny useful work.
- **It does not add a network dimension.** The reviewer judges the action, but DSH's sandbox still
 has no network restriction to enforce, see the network finding in the main report. Auto review
 reduces approval friction; it is not a substitute for egress control.
