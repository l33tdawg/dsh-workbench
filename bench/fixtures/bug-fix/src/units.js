/**
 * Turning a total minute count into canonical hours and minutes.
 * @param {number} totalMinutes - the total.
 * @returns {{hours: number, minutes: number}} canonical parts.
 */
export function toParts(totalMinutes) {
  return { hours: Math.floor(totalMinutes / 60), minutes: totalMinutes % 60 }
}
