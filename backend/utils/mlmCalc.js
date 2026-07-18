const User = require("../models/User");

// ─── Constants ──────────────────────────────────────────────────────────────
const BV_PER_PAIR = 150;
const DAILY_PAIR_CAP = 1000;        // ₹1000 gross pair income per day
const ADMIN_DEDUCTION_RATE = 0.08;  // 8%
const TDS_DEDUCTION_RATE = 0.02;    // 2%
const TOTAL_DEDUCTION_RATE = ADMIN_DEDUCTION_RATE + TDS_DEDUCTION_RATE; // 10%
const OVERRIDE_RATE = 0.25;         // 25% of gross pair income

// ─── Helper Functions ───────────────────────────────────────────────────────

/** Safe number converter */
function safeNumber(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

/**
 * Package-wise direct sponsor bonus.
 * ₹500 package → ₹25, ₹600 package → ₹30.
 */
function getDirectBonus(activationAmount) {
  const amt = safeNumber(activationAmount);
  if (amt >= 600) return 30;
  return 25;
}

/**
 * Apply deductions (8% admin + 2% TDS = 10% total).
 * @param {number} grossAmount
 * @returns {{ adminDeduct: number, tdsDeduct: number, totalDeduction: number, netAmount: number }}
 */
function applyDeductions(grossAmount) {
  const adminDeduct = grossAmount * ADMIN_DEDUCTION_RATE;
  const tdsDeduct = grossAmount * TDS_DEDUCTION_RATE;
  const totalDeduction = adminDeduct + tdsDeduct;
  const netAmount = grossAmount - totalDeduction;
  return { adminDeduct, tdsDeduct, totalDeduction, netAmount };
}

/**
 * Get today's date as YYYY-MM-DD string for daily cap comparison.
 */
function getTodayString() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

/**
 * Format a Date as YYYY-MM-DD string.
 */
function formatDateString(d) {
  if (!d) return null;
  const dt = new Date(d);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
}

/**
 * Get the user's remaining daily cap (gross). Resets todayPairIncome if date changed.
 */
function getDailyCapRemaining(user) {
  const today = getTodayString();
  const lastDate = formatDateString(user.lastIncomeDate);

  if (lastDate !== today) {
    // New day – reset daily counter
    user.todayPairIncome = 0;
    user.lastIncomeDate = new Date();
  }

  return Math.max(0, DAILY_PAIR_CAP - safeNumber(user.todayPairIncome));
}

/**
 * Duplicate-payment protection: check if a specific income log already exists.
 */
function isDuplicatePayment(user, type, sourceId) {
  return user.incomeLogs.some(
    (log) => log.type === type && log.source === sourceId
  );
}

// ─── Core Matching Algorithm ────────────────────────────────────────────────

/**
 * Binary pair matching with 1:2/2:1 then 1:1 logic.
 *
 * Phase 1 (1:2): When sides are unequal, burn excess from the strong side.
 *   Each 1:2 pair consumes 2 from the strong side + 1 from the weak side.
 *   phase1Pairs = min(delta, weakSide, floor(strongSide / 2))
 *
 * Phase 2 (1:1): Match remaining carries 1-for-1.
 *   phase2Pairs = min(remainingStrong, remainingWeak)
 *
 * @param {number} carryLeft  - Available carry on left side
 * @param {number} carryRight - Available carry on right side
 * @param {number} dailyCapRemaining - Remaining daily cap in ₹ (gross). Defaults to Infinity.
 * @returns {{ totalPairs, consumedLeft, consumedRight, phase1Pairs, phase2Pairs }}
 */
function matchPairs(carryLeft, carryRight, dailyCapRemaining = Infinity) {
  const left = Math.max(0, Math.floor(safeNumber(carryLeft)));
  const right = Math.max(0, Math.floor(safeNumber(carryRight)));

  if (left === 0 || right === 0) {
    return { totalPairs: 0, consumedLeft: 0, consumedRight: 0, phase1Pairs: 0, phase2Pairs: 0 };
  }

  const capValue = (dailyCapRemaining === Infinity) ? Infinity : safeNumber(dailyCapRemaining);
  const maxPairsByDailyCap = (capValue === Infinity) ? Infinity : Math.floor(capValue / BV_PER_PAIR);
  if (maxPairsByDailyCap <= 0) {
    return { totalPairs: 0, consumedLeft: 0, consumedRight: 0, phase1Pairs: 0, phase2Pairs: 0 };
  }

  let strong, weak, strongIsLeft;
  if (left >= right) {
    strong = left; weak = right; strongIsLeft = true;
  } else {
    strong = right; weak = left; strongIsLeft = false;
  }

  // Phase 1: 1:2 matching – burn excess from strong side
  const delta = strong - weak;
  let phase1Pairs = Math.min(delta, weak, Math.floor(strong / 2));

  let remainStrong = strong - (phase1Pairs * 2);
  let remainWeak = weak - phase1Pairs;

  // Phase 2: 1:1 matching – match remaining 1-for-1
  let phase2Pairs = Math.min(remainStrong, remainWeak);

  let totalPairs = phase1Pairs + phase2Pairs;

  // Cap by daily limit
  if (totalPairs > maxPairsByDailyCap) {
    let excess = totalPairs - maxPairsByDailyCap;
    // Reduce phase2 first (least efficient at burning excess), then phase1
    const reducedPhase2 = Math.min(phase2Pairs, excess);
    phase2Pairs -= reducedPhase2;
    excess -= reducedPhase2;
    if (excess > 0) {
      phase1Pairs -= excess;
    }
    totalPairs = maxPairsByDailyCap;
  }

  // Calculate consumption
  const consumedStrong = (phase1Pairs * 2) + phase2Pairs;
  const consumedWeak = phase1Pairs + phase2Pairs;

  const consumedLeft = strongIsLeft ? consumedStrong : consumedWeak;
  const consumedRight = strongIsLeft ? consumedWeak : consumedStrong;

  return { totalPairs, consumedLeft, consumedRight, phase1Pairs, phase2Pairs };
}

// ─── Pair Matching Processor ────────────────────────────────────────────────

/**
 * Process pair matching for a single user.
 * Handles 1:2/2:1 then 1:1 matching, daily capping, deductions, and sponsor override.
 *
 * @param {Object} user - Mongoose user document (used only for userId reference; re-fetched inside)
 */
async function processPairMatching(user) {
  // Re-fetch to get latest state (carries may have changed)
  const freshUser = await User.findOne({ userId: user.userId });
  if (!freshUser) return;

  const dailyCapRemaining = getDailyCapRemaining(freshUser);

  const match = matchPairs(
    safeNumber(freshUser.carryLeft),
    safeNumber(freshUser.carryRight),
    dailyCapRemaining
  );

  if (match.totalPairs <= 0) return;

  const grossPairIncome = match.totalPairs * BV_PER_PAIR;
  const { adminDeduct, tdsDeduct, netAmount: netPairIncome } = applyDeductions(grossPairIncome);

  // Update user metrics
  freshUser.carryLeft = safeNumber(freshUser.carryLeft) - match.consumedLeft;
  freshUser.carryRight = safeNumber(freshUser.carryRight) - match.consumedRight;
  freshUser.pairIncome = safeNumber(freshUser.pairIncome) + grossPairIncome;
  freshUser.adminDeduction = safeNumber(freshUser.adminDeduction) + adminDeduct;
  freshUser.tdsDeduction = safeNumber(freshUser.tdsDeduction) + tdsDeduct;
  freshUser.walletBalance = safeNumber(freshUser.walletBalance) + netPairIncome;
  freshUser.todayPairIncome = safeNumber(freshUser.todayPairIncome) + grossPairIncome;
  freshUser.lastIncomeDate = new Date();
  freshUser.totalIncome = safeNumber(freshUser.directIncome) + safeNumber(freshUser.pairIncome) + safeNumber(freshUser.overrideIncome);

  // Build description
  const descParts = [];
  if (match.phase1Pairs > 0) descParts.push(`${match.phase1Pairs} pair(s) at 1:2`);
  if (match.phase2Pairs > 0) descParts.push(`${match.phase2Pairs} pair(s) at 1:1`);

  freshUser.incomeLogs.push({
    type: "pair",
    amount: netPairIncome,
    description: `Binary pair matching: ${descParts.join(" + ")}. Gross ₹${grossPairIncome}, Deductions: Admin (8%) ₹${adminDeduct}, TDS (2%) ₹${tdsDeduct}. Net credited: ₹${netPairIncome}`,
    source: "pair_matching",
    date: new Date(),
  });

  await freshUser.save();
  console.log(`[Pair] ${freshUser.userId} matched ${match.totalPairs} pair(s) [${descParts.join(" + ")}]. Net ₹${netPairIncome}. Carry: L=${freshUser.carryLeft}, R=${freshUser.carryRight}`);

  // ── Sponsor Override (25% of gross pair income) ──
  if (freshUser.sponsorId) {
    const sponsorId = String(freshUser.sponsorId).trim().toUpperCase();
    const sponsor = await User.findOne({ userId: sponsorId });
    if (sponsor) {
      const grossOverride = grossPairIncome * OVERRIDE_RATE;
      const od = applyDeductions(grossOverride);

      sponsor.overrideIncome = safeNumber(sponsor.overrideIncome) + grossOverride;
      sponsor.adminDeduction = safeNumber(sponsor.adminDeduction) + od.adminDeduct;
      sponsor.tdsDeduction = safeNumber(sponsor.tdsDeduction) + od.tdsDeduct;
      sponsor.walletBalance = safeNumber(sponsor.walletBalance) + od.netAmount;
      sponsor.totalIncome = safeNumber(sponsor.directIncome) + safeNumber(sponsor.pairIncome) + safeNumber(sponsor.overrideIncome);

      sponsor.incomeLogs.push({
        type: "bonus",
        amount: od.netAmount,
        description: `Sponsor binary override (25%) from ${freshUser.userId}: Gross ₹${grossOverride}, Admin ₹${od.adminDeduct}, TDS ₹${od.tdsDeduct}. Net ₹${od.netAmount}`,
        source: freshUser.userId,
        date: new Date(),
      });

      await sponsor.save();
      console.log(`[Override] Sponsor ${sponsorId} received ₹${od.netAmount} override from ${freshUser.userId}`);
    }
  }
}

// ─── Main Activation Function ───────────────────────────────────────────────

/**
 * Activates a user, awards direct sponsor income, updates downline active counts,
 * checks for binary pair matching with 1:2/2:1 then 1:1 logic, applies 10% deductions
 * (8% admin + 2% TDS), awards sponsor overrides, enforces daily capping,
 * updates wallet balances, and logs transactions.
 *
 * @param {string} userId - The unique ID of the user to activate.
 * @param {number} activationAmount - The activation/joining fee (e.g., 500 or 600).
 */
async function processUserActivation(userId, activationAmount) {
  const normalizedId = String(userId || "").trim().toUpperCase();
  const user = await User.findOne({ userId: normalizedId });
  if (!user) {
    console.error(`[Activation Error] User ${normalizedId} not found`);
    return { success: false, message: "User not found" };
  }

  // Duplicate-activation protection: if already active, bail out
  if (user.isActive) {
    console.log(`[Activation Info] User ${normalizedId} is already active`);
    return { success: true, message: "User already active" };
  }

  // Mark user as active
  user.isActive = true;
  user.status = "active";
  user.lastEpinAmount = safeNumber(activationAmount);
  await user.save();

  console.log(`[Activation] User ${normalizedId} activated with amount ₹${activationAmount}`);

  // ── 1. Package-wise Direct Sponsor Income ──
  if (user.sponsorId) {
    const sponsorId = String(user.sponsorId).trim().toUpperCase();
    const sponsor = await User.findOne({ userId: sponsorId });
    if (sponsor) {
      // Duplicate-payment protection
      if (!isDuplicatePayment(sponsor, "direct", normalizedId)) {
        const directAmt = getDirectBonus(activationAmount);
        sponsor.directIncome = safeNumber(sponsor.directIncome) + directAmt;
        sponsor.walletBalance = safeNumber(sponsor.walletBalance) + directAmt;
        sponsor.totalIncome = safeNumber(sponsor.directIncome) + safeNumber(sponsor.pairIncome) + safeNumber(sponsor.overrideIncome);

        sponsor.incomeLogs.push({
          type: "direct",
          amount: directAmt,
          description: `Direct sponsor income for activating child ${normalizedId} (₹${activationAmount} package)`,
          source: normalizedId,
          date: new Date(),
        });

        await sponsor.save();
        console.log(`[Activation] Sponsor ${sponsorId} credited with direct income ₹${directAmt} (₹${activationAmount} package)`);
      }
    }
  }

  // ── 2. Match pre-accumulated carries on the newly activated user ──
  await processPairMatching(user);

  // ── 3. Walk upline parents – unlimited depth BV propagation ──
  let currentUserId = user.userId;
  let parentId = user.parentId ? String(user.parentId).trim().toUpperCase() : null;

  while (parentId) {
    const parent = await User.findOne({ userId: parentId });
    if (!parent) break;

    // Determine which side the current node sits on
    const isLeft = parent.left === currentUserId;
    const isRight = parent.right === currentUserId;

    if (isLeft) {
      parent.leftCount = safeNumber(parent.leftCount) + 1;
      parent.carryLeft = safeNumber(parent.carryLeft) + 1;
    } else if (isRight) {
      parent.rightCount = safeNumber(parent.rightCount) + 1;
      parent.carryRight = safeNumber(parent.carryRight) + 1;
    } else {
      console.warn(`[Activation Warning] Path mismatch for parent ${parentId} and child ${currentUserId}`);
      break;
    }

    // Save updated counts so matching sees fresh data
    await parent.save();

    // Binary pair matching for parent (only if active!)
    if (parent.isActive) {
      await processPairMatching(parent);
    }

    // Continue upward (unlimited depth)
    currentUserId = parent.userId;
    parentId = parent.parentId ? String(parent.parentId).trim().toUpperCase() : null;
  }

  return { success: true };
}

// ─── Full Recalculation ─────────────────────────────────────────────────────

/**
 * Resets all user counts and MLM wallet incomes, then recalculates everything
 * chronologically by activating all active users in order.
 */
async function recalculateAllMLM() {
  console.log("[Recalculate] Starting full MLM recalculation...");

  // 1. Fetch all users
  const users = await User.find({});

  // Remember which users were originally active before resetting
  const activeUserIds = new Set(
    users
      .filter((u) => u.totalEpinUsed > 0 || u.isActive || u.lastEpinAmount > 0)
      .map((u) => u.userId)
  );

  // Reset all users
  for (const user of users) {
    user.leftCount = 0;
    user.rightCount = 0;
    user.carryLeft = 0;
    user.carryRight = 0;
    user.directIncome = 0;
    user.pairIncome = 0;
    user.overrideIncome = 0;
    user.adminDeduction = 0;
    user.tdsDeduction = 0;
    user.repurchaseDeduction = 0;
    user.todayPairIncome = 0;
    user.lastIncomeDate = null;

    // Filter out previous MLM payout entries, keeping only "epin" and admin debit logs
    user.incomeLogs = user.incomeLogs.filter(
      (log) => log.type === "epin" || (log.type === "admin" && log.amount < 0)
    );

    // Wallet balance starts from EPIN amount minus withdrawals
    let epinSum = 0;
    user.incomeLogs.forEach((log) => {
      if (log.type === "epin") {
        epinSum += safeNumber(log.amount);
      }
    });

    let withdrawnSum = 0;
    if (Array.isArray(user.withdrawRequests)) {
      user.withdrawRequests.forEach((req) => {
        if (req.status === "approved") {
          withdrawnSum += safeNumber(req.amount);
        }
      });
    }

    user.walletBalance = epinSum - withdrawnSum;
    user.totalWithdrawn = withdrawnSum;
    user.totalIncome = 0;
    user.isActive = false;
    user.status = "inactive";
    await user.save();
  }

  // 2. Sort active users chronologically
  const activeUsersToProcess = users
    .filter((u) => activeUserIds.has(u.userId))
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

  console.log(`[Recalculate] Found ${activeUsersToProcess.length} active users to process.`);

  // 3. Activate them one by one in chronological order
  for (const activeUser of activeUsersToProcess) {
    const activationAmount = activeUser.lastEpinAmount || 500;
    await processUserActivation(activeUser.userId, activationAmount);
  }

  console.log("[Recalculate] Full MLM recalculation complete! 🔥");
  return { success: true };
}

// ─── Exports ────────────────────────────────────────────────────────────────
module.exports = {
  processUserActivation,
  recalculateAllMLM,
  // Exported for unit testing
  matchPairs,
  getDirectBonus,
  applyDeductions,
  safeNumber,
  DAILY_PAIR_CAP,
  BV_PER_PAIR,
};
