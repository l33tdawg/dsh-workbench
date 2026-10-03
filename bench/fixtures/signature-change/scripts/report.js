#!/usr/bin/env node
/**
 * Daily takings report. Run with: node scripts/report.js
 *
 * Deliberately outside src/, because a consumer that lives in a build script is
 * the one a migration forgets.
 */

import { formatPrice } from '../src/money.js'

const ORDERS = [120.5, 30, 4.25]

const total = ORDERS.reduce((sum, amount) => sum + amount, 0)
console.log(`Orders: ${ORDERS.length}`)
console.log(`Takings: ${formatPrice(total, 'USD')}`)
