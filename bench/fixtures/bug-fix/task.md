# Task: fix the duration bug

`parseDuration` returns the parts exactly as written, so a duration written as `90m` parses to
`{ hours: 0, minutes: 90 }` instead of `{ hours: 1, minutes: 30 }`. Everything that renders those
parts back to a person therefore shows `0h 90m`.

## Requirements

- `parseDuration('90m')` returns `{ hours: 1, minutes: 30 }`.
- `parseDuration('1h90m')` returns `{ hours: 2, minutes: 30 }`.
- `parseDuration('45m')` returns `{ hours: 0, minutes: 45 }` and `parseDuration('2h')` returns
  `{ hours: 2, minutes: 0 }`.
- No rendering of a duration may ever contain a minute component of 60 or more, for any input.
- The full test suite must pass when you are done.

## Constraints

- Do not change the tests. Do not weaken, skip or delete an assertion to make the suite pass.
- Do not add dependencies.
- `src/units.js` is correct. Do not change it.

## Before you report back

State what you ran to check your final revision, and what it printed. If you did not check the
final revision, say so rather than implying that you did.
