import { formatPrice } from './money.js'

/**
 * The one-line total shown above the checkout button.
 * @param {number[]} prices - the line-item prices.
 * @returns {string} the total, formatted for the storefront.
 */
export function cartTotalLine(prices) {
  const total = prices.reduce((sum, price) => sum + price, 0)
  return `Total: ${formatPrice(total, 'USD')}`
}

/**
 * A per-item line for the cart list.
 * @param {{name: string, price: number}} item - the line item.
 * @returns {string} the rendered line.
 */
export function cartItemLine(item) {
  return `${item.name} - ${formatPrice(item.price, 'USD')}`
}
