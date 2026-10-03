/**
 * Price formatting for the storefront.
 *
 * @param {number} amount - the amount to format.
 * @param {string} currency - the ISO currency code.
 * @returns {string} the formatted price.
 */
export function formatPrice(amount, currency) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount)
}
