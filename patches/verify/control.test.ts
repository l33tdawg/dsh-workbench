// Control: asserts only what the PATCHED profiles.ts must guarantee, using only
// exports that exist in both versions. If this passes on unpatched code, the
// verification is not actually testing the fence.
import assert from 'node:assert/strict'
import { bwrapProfileArgs, seatbeltProfileArgs } from './profiles.ts'

const RO = { mode: 'read-only', workspaceRoot: '/ws' }
const bwrap = bwrapProfileArgs(RO)
const seatbelt = seatbeltProfileArgs(RO)[1]
console.log('bwrap args :', bwrap.join(' '))
console.log('seatbelt   :', seatbelt)
try {
  assert.ok(bwrap.includes('--unshare-net'), 'bwrap must isolate the network namespace')
  assert.ok(seatbelt.includes('(deny network*)'), 'seatbelt must deny network')
  console.log('\nRESULT: fence present')
} catch (error) {
  console.log('\nRESULT: NO FENCE - ' + error.message)
  process.exit(1)
}
