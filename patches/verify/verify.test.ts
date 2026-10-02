import assert from 'node:assert/strict'
import { bwrapProfileArgs, networkAllowed, seatbeltProfileArgs } from './profiles.ts'

const RO = { mode: 'read-only', workspaceRoot: '/ws' }
const WW = { mode: 'workspace-write', workspaceRoot: '/ws' }
let pass = 0
const check = (name, fn) => { fn(); pass++; console.log('  ok  ' + name) }

console.log('networkAllowed')
check('absent means deny', () => {
  assert.equal(networkAllowed(RO), false)
  assert.equal(networkAllowed({ ...RO, network: 'deny' }), false)
})
check("'allow' means allow", () => assert.equal(networkAllowed({ ...RO, network: 'allow' }), true))

console.log('bwrap (Linux: private network namespace)')
check('read-only denies by default', () => {
  const args = bwrapProfileArgs(RO)
  assert.ok(args.includes('--unshare-net'), 'expected --unshare-net')
})
check('workspace-write denies by default', () => {
  assert.ok(bwrapProfileArgs(WW).includes('--unshare-net'))
})
check("'allow' omits the flag entirely", () => {
  assert.ok(!bwrapProfileArgs({ ...RO, network: 'allow' }).includes('--unshare-net'))
})
check('file mounts are unchanged by the network decision', () => {
  const ww = bwrapProfileArgs(WW)
  assert.deepEqual(ww.slice(ww.indexOf('--tmpfs')), ['--tmpfs', '/tmp', '--bind', '/ws', '/ws'])
  assert.deepEqual(
    bwrapProfileArgs({ ...WW, network: 'allow' }),
    ['--ro-bind', '/', '/', '--dev', '/dev', '--unshare-pid', '--proc', '/proc', '--die-with-parent', '--tmpfs', '/tmp', '--bind', '/ws', '/ws'],
  )
})

console.log('seatbelt (macOS: kernel deny)')
check('read-only denies by default', () => {
  const profile = seatbeltProfileArgs(RO)[1]
  assert.ok(profile.includes('(deny network*)'), 'expected (deny network*) in ' + profile)
})
check('workspace-write denies by default', () => {
  assert.ok(seatbeltProfileArgs(WW)[1].includes('(deny network*)'))
})
check("'allow' omits the deny entirely", () => {
  const profile = seatbeltProfileArgs({ ...RO, network: 'allow' })[1]
  assert.ok(!profile.includes('network'))
})
check('the file-write deny survives the network decision', () => {
  for (const policy of [RO, WW, { ...RO, network: 'allow' }, { ...WW, network: 'allow' }]) {
    assert.ok(seatbeltProfileArgs(policy)[1].includes('(deny file-write*)'))
  }
})
check('the deny sits inside a profile that still parses as one -p argument', () => {
  const args = seatbeltProfileArgs(RO)
  assert.equal(args.length, 2)
  assert.equal(args[0], '-p')
  assert.ok(args[1].startsWith('(version 1) (allow default)'))
})

console.log('\n' + pass + ' checks passed')
