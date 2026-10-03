import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

import { cartItemLine, cartTotalLine } from '../src/cart.js'
import { receiptLine, refundNotice } from '../src/receipt.js'

const REPORT = fileURLToPath(new URL('../scripts/report.js', import.meta.url))

describe('every consumer of formatPrice', () => {
  it('renders a cart total', () => {
    assert.equal(cartTotalLine([1, 2]), 'Total: $3.00')
  })

  it('renders a cart item', () => {
    assert.equal(cartItemLine({ name: 'Widget', price: 2.5 }), 'Widget - $2.50')
  })

  it('renders a receipt line', () => {
    assert.equal(receiptLine({ orderId: 'A1', amount: 10 }), 'Order A1 - $10.00')
  })

  it('renders a refund notice', () => {
    assert.equal(refundNotice(5), 'Refunded $5.00 to the original payment method.')
  })

  it('still runs the takings report as a script', () => {
    // Outside src/, so a migration that only greps src/ leaves this one calling
    // the retired signature, and the script then exits non-zero.
    const output = execFileSync(process.execPath, [REPORT], { encoding: 'utf8' })
    assert.ok(output.includes('Orders: 3'), output)
    assert.ok(output.includes('Takings: $154.75'), output)
  })
})
