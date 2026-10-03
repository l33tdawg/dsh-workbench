/**
 * Parse a duration written the way a person writes one: `45m`, `2h`, `1h30m`.
 *
 * BUG: the parts are returned exactly as written, so `90m` parses to
 * `{ hours: 0, minutes: 90 }`. Every caller that renders those parts back to a
 * person shows `0h 90m`.
 *
 * @param {string} text - the written duration.
 * @returns {{hours: number, minutes: number}} the parsed parts.
 */
export function parseDuration(text) {
  const hours = /(\d+)h/.exec(text)
  const minutes = /(\d+)m/.exec(text)
  return {
    hours: hours === null ? 0 : Number(hours[1]),
    minutes: minutes === null ? 0 : Number(minutes[1]),
  }
}

/**
 * Render a written duration back in canonical form.
 * @param {string} text - the written duration.
 * @returns {string} the canonical rendering, e.g. `1h 30m`.
 */
export function describeDuration(text) {
  const { hours, minutes } = parseDuration(text)
  return `${hours}h ${minutes}m`
}
