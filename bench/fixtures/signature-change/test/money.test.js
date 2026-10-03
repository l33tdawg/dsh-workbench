import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { formatPrice } from '../src/money.js'

describe('formatPrice', () => {
  it('formats with an explicit currency and locale', () => {
    assert.equal(formatPrice(12.5, { currency: 'USD', locale: 'en-US' }), '$12.50')
  })

  it('follows the locale, not a fixed en-US shape', () => {
    const german = formatPrice(1234.5, { currency: 'EUR', locale: 'de-DE' })
    // Asserted on the decimal separator rather than the whole string: ICU writes
    // a non-breaking space before the symbol and that is not what is under test.
    assert.ok(german.includes('1.234,50'), `expected a German-shaped amount, got ${german}`)
  })

  it('defaults to USD and en-US when options are omitted entirely', () => {
    assert.equal(formatPrice(9), '$9.00')
  })

  it('defaults each field separately, not the whole object', () => {
    assert.equal(formatPrice(9, { locale: 'en-US' }), '$9.00')
    assert.equal(formatPrice(9, { currency: 'EUR' }), '€9.00')
  })

  it('rejects a bare currency string, which is the retired signature', () => {
    // This is what makes a half-finished migration loud instead of silent: a
    // consumer still passing 'USD' fails here rather than quietly formatting USD.
    assert.throws(() => formatPrice(9, 'USD'), TypeError)
  })
})
