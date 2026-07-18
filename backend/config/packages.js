/**
 * =========================================================
 * PACKAGE DEFINITIONS — Single Source of Truth
 * =========================================================
 *
 * All package amounts, bonuses, caps, and BV values are
 * defined here. The compensation engine, registration,
 * E-PIN generation, and payment request flows should all
 * reference this file instead of hardcoding values.
 *
 * To add or modify a package, update the PACKAGES object
 * below. No other files should contain hardcoded package
 * values after the full migration is complete.
 * =========================================================
 */

const PACKAGES = {
  150: {
    id: "PKG_150",
    amount: 150,
    directBonus: 25,
    matchingBonus: 25,
    dailyCap: 500,
    bv: 1,
    label: "Package 1 — ₹150",
  },
  499: {
    id: "PKG_499",
    amount: 499,
    directBonus: 100,
    matchingBonus: 100,
    dailyCap: 1000,
    bv: 1,
    label: "Package 2 — ₹499",
  },
  999: {
    id: "PKG_999",
    amount: 999,
    directBonus: 200,
    matchingBonus: 200,
    dailyCap: 5000,
    bv: 1,
    label: "Package 3 — ₹999",
  },
  1500: {
    id: "PKG_1500",
    amount: 1500,
    directBonus: 250,
    matchingBonus: 250,
    dailyCap: 5000,
    bv: 1,
    label: "Package 4 — ₹1500",
  },
};

/**
 * Binary matching rules.
 *
 * firstMatch:
 *   The very first successful binary match for a user
 *   consumes BV in a 1:2 (or 2:1) ratio.
 *   e.g. Left=1, Right=2 consumed → 1 match event.
 *
 * regularMatch:
 *   After the first successful match, all subsequent
 *   matches consume BV in a strict 1:1 ratio.
 *
 * unlimitedDepth:
 *   BV propagates upward through the entire binary
 *   placement ancestry chain with no depth limit.
 *
 * carryForwardExpires:
 *   false = unused BV on either side carries forward
 *   indefinitely until consumed by a valid match.
 */
const BINARY_RULES = {
  firstMatch: {
    smallSide: 1,
    largeSide: 2,
  },
  regularMatch: {
    left: 1,
    right: 1,
  },
  unlimitedDepth: true,
  carryForwardExpires: false,
};

/**
 * Helper: get a valid list of all allowed package amounts.
 * Used for validation in registration, E-PIN, and payment flows.
 */
function getPackageAmounts() {
  return Object.keys(PACKAGES).map(Number);
}

/**
 * Helper: look up a package by its amount.
 * Returns the package config object, or null if invalid.
 */
function getPackageByAmount(amount) {
  const key = Number(amount);
  return PACKAGES[key] || null;
}

/**
 * Helper: validate that a given amount corresponds to a valid package.
 */
function isValidPackageAmount(amount) {
  return PACKAGES.hasOwnProperty(Number(amount));
}

module.exports = {
  PACKAGES,
  BINARY_RULES,
  getPackageAmounts,
  getPackageByAmount,
  isValidPackageAmount,
};
