import { parseDuration } from './duration.js'

/**
 * The total minutes a list of written durations adds up to.
 * @param {string[]} entries - written durations.
 * @returns {number} the total in minutes.
 */
export function agendaTotal(entries) {
  let minutes = 0
  for (const entry of entries) {
    const parts = parseDuration(entry)
    minutes += parts.hours * 60 + parts.minutes
  }
  return minutes
}

/**
 * The agenda as one human-readable line.
 * @param {string[]} entries - written durations.
 * @returns {string} the summary line.
 */
export function agendaLine(entries) {
  return `${entries.length} entries, ${agendaTotal(entries)} minutes`
}
