import { formatPrice } from './money.js'

/**
 * The footer line on an emailed receipt.
 * @param {{orderId: string, amount: number}} order - the settled order.
 * @returns {string} the receipt summary.
 */
export function receiptLine(order) {
  return `Order ${order.orderId} - ${formatPrice(order.amount, 'USD')}`
}

/**
 * The refund notice shown when an order is reversed.
 * @param {number} amount - the refunded amount.
 * @returns {string} the notice.
 */
export function refundNotice(amount) {
  return `Refunded ${formatPrice(amount, 'USD')} to the original payment method.`
}
