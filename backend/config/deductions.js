/**
 * =========================================================
 * DEDUCTION CONFIGURATION — Single Source of Truth
 * =========================================================
 *
 * All deduction percentages applied to MLM income are
 * defined here. The compensation engine should reference
 * this file when calculating gross → net income.
 *
 * Current confirmed deductions:
 *   TDS:           2%
 *   Admin Charge:  8%
 *   ─────────────────
 *   Total:        10%
 *
 * Note: The old 5% "repurchase" deduction has been removed
 * from the new compensation plan. The repurchasePercent
 * field is retained at 0 for backward compatibility with
 * existing ledger display logic until fully migrated.
 * =========================================================
 */

const DEDUCTIONS = {
  tdsPercent: 0.02,          // 2% TDS
  adminChargePercent: 0.08,  // 8% Admin Charge
  repurchasePercent: 0,      // 0% — removed from new plan

  /**
   * Returns the total deduction rate as a decimal.
   * e.g. 0.10 = 10%
   */
  get totalPercent() {
    return this.tdsPercent + this.adminChargePercent + this.repurchasePercent;
  },
};

/**
 * Helper: calculate all deduction amounts for a given gross income.
 *
 * @param {number} grossIncome — The income amount before deductions.
 * @returns {{ gross, tds, adminCharge, repurchase, totalDeduction, net }}
 */
function calculateDeductions(grossIncome) {
  const gross = Number(grossIncome) || 0;

  const tds = Math.round(gross * DEDUCTIONS.tdsPercent * 100) / 100;
  const adminCharge = Math.round(gross * DEDUCTIONS.adminChargePercent * 100) / 100;
  const repurchase = Math.round(gross * DEDUCTIONS.repurchasePercent * 100) / 100;
  const totalDeduction = Math.round((tds + adminCharge + repurchase) * 100) / 100;
  const net = Math.round((gross - totalDeduction) * 100) / 100;

  return {
    gross,
    tds,
    adminCharge,
    repurchase,
    totalDeduction,
    net,
  };
}

module.exports = {
  DEDUCTIONS,
  calculateDeductions,
};
