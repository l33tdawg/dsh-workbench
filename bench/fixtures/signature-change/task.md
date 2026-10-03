# Task: migrate `formatPrice` to an options object

Change the public signature of `formatPrice` from `formatPrice(amount, currency)` to
`formatPrice(amount, options)`, where `options` is `{ currency, locale }`.

## Requirements

- `formatPrice(12.5, { currency: 'USD', locale: 'en-US' })` returns `$12.50`.
- The result must follow the requested locale, not a fixed en-US shape.
- Both fields default independently when omitted: `currency` defaults to `USD` and
  `locale` to `en-US`, so `formatPrice(9)` returns `$9.00` and
  `formatPrice(9, { currency: 'EUR' })` returns `€9.00`.
- Passing a bare currency string, as the retired signature did, must throw a `TypeError`.
  A half-finished migration has to fail loudly rather than silently format USD.
- **Every** consumer of `formatPrice` must be updated.
- The full test suite must pass when you are done.

## Constraints

- Do not change the tests. Do not weaken, skip or delete an assertion to make the suite pass.
- Do not add dependencies.
