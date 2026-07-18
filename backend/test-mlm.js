const mongoose = require("mongoose");
const User = require("./models/User");
const {
  processUserActivation,
  recalculateAllMLM,
  matchPairs,
  getDirectBonus,
  applyDeductions,
  safeNumber,
  DAILY_PAIR_CAP,
  BV_PER_PAIR,
} = require("./utils/mlmCalc");

const DB_URI =
  "mongodb://atharvachimte_db_user:846AgF2y1bwtS0Kd@ac-l2kdw4z-shard-00-00.cdoydlu.mongodb.net:27017,ac-l2kdw4z-shard-00-01.cdoydlu.mongodb.net:27017,ac-l2kdw4z-shard-00-02.cdoydlu.mongodb.net:27017/myapp?ssl=true&replicaSet=atlas-8n11xu-shard-0&authSource=admin&retryWrites=true&w=majority";

// ─── Test Utilities ─────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failedTests = [];

function assert(condition, message) {
  if (!condition) {
    throw new Error(`ASSERTION FAILED: ${message}`);
  }
}

function assertEq(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

function assertClose(actual, expected, message, tolerance = 0.01) {
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error(`${message}: expected ~${expected}, got ${actual} (tolerance ${tolerance})`);
  }
}

async function cleanup() {
  await User.deleteMany({ userId: { $regex: /^TEST_/ } });
}

async function createUser(data) {
  const user = new User({ password: "test1234", ...data });
  await user.save();
  return user;
}

async function getUser(userId) {
  return User.findOne({ userId: userId.toUpperCase() });
}

async function runTest(name, fn) {
  try {
    console.log(`\n${"═".repeat(60)}`);
    console.log(`  TEST: ${name}`);
    console.log(`${"═".repeat(60)}`);
    await fn();
    console.log(`  ✅ PASSED: ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ❌ FAILED: ${name}`);
    console.error(`     ${err.message}`);
    failedTests.push({ name, error: err.message });
    failed++;
  }
}

// ─── Unit Tests (no MongoDB) ────────────────────────────────────────────────

async function unitTests() {
  // ── Test: getDirectBonus ──
  await runTest("getDirectBonus: ₹500 → ₹25, ₹600 → ₹30", async () => {
    assertEq(getDirectBonus(500), 25, "₹500 package bonus");
    assertEq(getDirectBonus(600), 30, "₹600 package bonus");
    assertEq(getDirectBonus(0), 25, "₹0 fallback");
    assertEq(getDirectBonus(999), 30, "₹999 gives ₹30 (>= 600)");
  });

  // ── Test: applyDeductions ──
  await runTest("applyDeductions: 10% total (8% admin + 2% TDS)", async () => {
    const d = applyDeductions(150);
    assertClose(d.adminDeduct, 12, "Admin deduction 8% of 150");
    assertClose(d.tdsDeduct, 3, "TDS deduction 2% of 150");
    assertClose(d.totalDeduction, 15, "Total deduction 10% of 150");
    assertClose(d.netAmount, 135, "Net amount after 10% deduction");

    const d2 = applyDeductions(1000);
    assertClose(d2.adminDeduct, 80, "Admin deduction 8% of 1000");
    assertClose(d2.tdsDeduct, 20, "TDS deduction 2% of 1000");
    assertClose(d2.netAmount, 900, "Net amount after 10% of 1000");
  });

  // ── Test: matchPairs 1:1 symmetric ──
  await runTest("matchPairs: 1:1 symmetric matching (equal sides)", async () => {
    const r = matchPairs(3, 3);
    assertEq(r.totalPairs, 3, "3 pairs matched");
    assertEq(r.phase1Pairs, 0, "No 1:2 phase (equal sides)");
    assertEq(r.phase2Pairs, 3, "All 3 at 1:1");
    assertEq(r.consumedLeft, 3, "All left consumed");
    assertEq(r.consumedRight, 3, "All right consumed");
  });

  // ── Test: matchPairs 1:1 single pair ──
  await runTest("matchPairs: single pair (1, 1)", async () => {
    const r = matchPairs(1, 1);
    assertEq(r.totalPairs, 1, "1 pair");
    assertEq(r.phase1Pairs, 0, "No 1:2 phase");
    assertEq(r.phase2Pairs, 1, "1 at 1:1");
  });

  // ── Test: matchPairs 1:2 asymmetric (left strong) ──
  await runTest("matchPairs: 1:2 asymmetric (L=5, R=3)", async () => {
    // delta=2, phase1=min(2,3,2)=2 pairs at 1:2. Consume L=4, R=2. Remaining L=1, R=1.
    // phase2=1 at 1:1. Total=3.
    const r = matchPairs(5, 3);
    assertEq(r.totalPairs, 3, "3 total pairs");
    assertEq(r.phase1Pairs, 2, "2 pairs at 1:2");
    assertEq(r.phase2Pairs, 1, "1 pair at 1:1");
    assertEq(r.consumedLeft, 5, "All left consumed (2*2+1)");
    assertEq(r.consumedRight, 3, "All right consumed (2+1)");
  });

  // ── Test: matchPairs 1:2 asymmetric (right strong) ──
  await runTest("matchPairs: 1:2 asymmetric (L=2, R=6)", async () => {
    // strong=R=6, weak=L=2, delta=4. phase1=min(4,2,3)=2 at 1:2. Consume R=4, L=2. Remaining R=2, L=0.
    // phase2=0. Total=2. Carry: R=2.
    const r = matchPairs(2, 6);
    assertEq(r.totalPairs, 2, "2 total pairs");
    assertEq(r.phase1Pairs, 2, "2 pairs at 1:2");
    assertEq(r.phase2Pairs, 0, "0 pairs at 1:1");
    assertEq(r.consumedLeft, 2, "Weak side fully consumed");
    assertEq(r.consumedRight, 4, "Strong side: 2*2=4 consumed");
  });

  // ── Test: matchPairs 1:2 extreme imbalance ──
  await runTest("matchPairs: extreme imbalance (L=100, R=1)", async () => {
    // strong=L=100, weak=R=1, delta=99. phase1=min(99,1,50)=1 at 1:2. Consume L=2, R=1.
    // Remaining L=98, R=0. phase2=0. Total=1. Carry: L=98.
    const r = matchPairs(100, 1);
    assertEq(r.totalPairs, 1, "Only 1 pair (limited by weak side)");
    assertEq(r.phase1Pairs, 1, "1 pair at 1:2");
    assertEq(r.consumedLeft, 2, "2 consumed from strong side");
    assertEq(r.consumedRight, 1, "1 consumed from weak side");
  });

  // ── Test: matchPairs zero cases ──
  await runTest("matchPairs: zero carry on one side", async () => {
    const r1 = matchPairs(5, 0);
    assertEq(r1.totalPairs, 0, "No match with 0 right");
    const r2 = matchPairs(0, 5);
    assertEq(r2.totalPairs, 0, "No match with 0 left");
    const r3 = matchPairs(0, 0);
    assertEq(r3.totalPairs, 0, "No match with both 0");
  });

  // ── Test: matchPairs with daily cap ──
  await runTest("matchPairs: daily cap limits matching", async () => {
    // L=10, R=10 → would produce 10 pairs (1500 gross)
    // but daily cap remaining = 450 → max floor(450/150) = 3 pairs
    const r = matchPairs(10, 10, 450);
    assertEq(r.totalPairs, 3, "Capped to 3 pairs by daily cap");
    assertEq(r.consumedLeft, 3, "3 left consumed");
    assertEq(r.consumedRight, 3, "3 right consumed");
  });

  // ── Test: matchPairs daily cap zero remaining ──
  await runTest("matchPairs: daily cap exhausted (remaining=0)", async () => {
    const r = matchPairs(5, 5, 0);
    assertEq(r.totalPairs, 0, "No pairs when cap is 0");
  });

  // ── Test: matchPairs daily cap insufficient for even 1 pair ──
  await runTest("matchPairs: daily cap insufficient for 1 pair (remaining=100)", async () => {
    const r = matchPairs(5, 5, 100);
    assertEq(r.totalPairs, 0, "No pairs when remaining < BV_PER_PAIR");
  });

  // ── Test: matchPairs daily cap reduces 1:2 pairs ──
  await runTest("matchPairs: daily cap cuts into 1:2+1:1 phases", async () => {
    // L=5, R=3: normally 2 at 1:2 + 1 at 1:1 = 3 pairs (450 gross)
    // Cap remaining = 300 → max 2 pairs.
    // Reduce phase2 first: phase2 goes 1→0 (excess=1 reduced). Remaining excess=0.
    // Result: 2 at 1:2, 0 at 1:1 = 2 pairs.
    const r = matchPairs(5, 3, 300);
    assertEq(r.totalPairs, 2, "Capped to 2 pairs");
    assertEq(r.phase1Pairs, 2, "2 at 1:2 preserved");
    assertEq(r.phase2Pairs, 0, "1:1 phase cut");
    assertEq(r.consumedLeft, 4, "4 left consumed (2*2)");
    assertEq(r.consumedRight, 2, "2 right consumed");
  });

  // ── Test: safeNumber ──
  await runTest("safeNumber: edge cases", async () => {
    assertEq(safeNumber(42), 42, "Normal number");
    assertEq(safeNumber("100"), 100, "String number");
    assertEq(safeNumber(null), 0, "null → 0");
    assertEq(safeNumber(undefined), 0, "undefined → 0");
    assertEq(safeNumber(NaN), 0, "NaN → 0");
    assertEq(safeNumber(Infinity), 0, "Infinity → 0");
    assertEq(safeNumber("abc", 5), 5, "Non-numeric string → fallback");
  });
}

// ─── Integration Tests (MongoDB) ────────────────────────────────────────────

async function integrationTests() {
  // ── Test: Direct Bonus ₹500 ──
  await runTest("Integration: Direct bonus ₹500 package → ₹25", async () => {
    await cleanup();
    await createUser({ userId: "TEST_SP", fullName: "Sponsor" });
    await createUser({ userId: "TEST_CHILD1", fullName: "Child 1", sponsorId: "TEST_SP" });

    await processUserActivation("TEST_SP", 500);
    await processUserActivation("TEST_CHILD1", 500);

    const sp = await getUser("TEST_SP");
    assertEq(sp.directIncome, 25, "Sponsor direct income");
    assertEq(sp.walletBalance, 25, "Sponsor wallet");
  });

  // ── Test: Direct Bonus ₹600 ──
  await runTest("Integration: Direct bonus ₹600 package → ₹30", async () => {
    await cleanup();
    await createUser({ userId: "TEST_SP2", fullName: "Sponsor 2" });
    await createUser({ userId: "TEST_CHILD2", fullName: "Child 2", sponsorId: "TEST_SP2" });

    await processUserActivation("TEST_SP2", 500);
    await processUserActivation("TEST_CHILD2", 600);

    const sp = await getUser("TEST_SP2");
    assertEq(sp.directIncome, 30, "Sponsor direct income for ₹600 package");
    assertEq(sp.walletBalance, 30, "Sponsor wallet");
  });

  // ── Test: Basic 1:1 pair matching ──
  await runTest("Integration: Basic 1:1 pair matching (L=1, R=1)", async () => {
    await cleanup();

    // Create network: SPONSOR → ROOT → L1, R1
    await createUser({ userId: "TEST_SPONSOR", fullName: "Sponsor" });
    const root = await createUser({
      userId: "TEST_ROOT", fullName: "Root", sponsorId: "TEST_SPONSOR",
    });

    await createUser({
      userId: "TEST_L1", fullName: "Left 1",
      sponsorId: "TEST_ROOT", parentId: "TEST_ROOT", position: "L",
    });
    root.left = "TEST_L1";
    await root.save();

    await createUser({
      userId: "TEST_R1", fullName: "Right 1",
      sponsorId: "TEST_ROOT", parentId: "TEST_ROOT", position: "R",
    });
    root.right = "TEST_R1";
    await root.save();

    // Activate in order
    await processUserActivation("TEST_SPONSOR", 500);
    await processUserActivation("TEST_ROOT", 500);
    await processUserActivation("TEST_L1", 500);
    await processUserActivation("TEST_R1", 500);

    const rootFinal = await getUser("TEST_ROOT");
    const sponsorFinal = await getUser("TEST_SPONSOR");

    // ROOT: directIncome = 25+25 = 50, pairIncome = 150
    // Pair deductions (10%): admin=12, TDS=3. Net pair = 135.
    // wallet = 50 + 135 = 185
    assertEq(rootFinal.directIncome, 50, "ROOT direct income (2×₹25)");
    assertEq(rootFinal.pairIncome, 150, "ROOT pair income (gross)");
    assertClose(rootFinal.adminDeduction, 12, "ROOT admin deduction (8% of 150)");
    assertClose(rootFinal.tdsDeduction, 3, "ROOT TDS deduction (2% of 150)");
    assertClose(rootFinal.walletBalance, 185, "ROOT wallet (50 + 135)");
    assertEq(rootFinal.carryLeft, 0, "ROOT carry left = 0");
    assertEq(rootFinal.carryRight, 0, "ROOT carry right = 0");
    assertEq(rootFinal.totalIncome, 200, "ROOT totalIncome (50+150+0)");

    // SPONSOR: directIncome = 25 (from ROOT), overrideIncome = 37.5 (25% of 150)
    // Override deductions (10%): admin=3, TDS=0.75. Net override = 33.75.
    // wallet = 25 + 33.75 = 58.75
    assertEq(sponsorFinal.directIncome, 25, "SPONSOR direct income");
    assertClose(sponsorFinal.overrideIncome, 37.5, "SPONSOR override income");
    assertClose(sponsorFinal.walletBalance, 58.75, "SPONSOR wallet");
    assertClose(sponsorFinal.adminDeduction, 3, "SPONSOR admin deduction");
    assertClose(sponsorFinal.tdsDeduction, 0.75, "SPONSOR TDS deduction");
  });

  // ── Test: 1:2 matching (asymmetric tree) ──
  await runTest("Integration: 1:2 matching (L=3, R=1)", async () => {
    await cleanup();

    // Tree:       ROOT
    //            /    \
    //           L1     R1
    //          /
    //         L2
    //        /
    //       L3
    await createUser({ userId: "TEST_SPONSOR", fullName: "Sponsor" });
    const root = await createUser({
      userId: "TEST_ROOT", fullName: "Root", sponsorId: "TEST_SPONSOR",
    });

    // Left chain
    const l1 = await createUser({
      userId: "TEST_L1", fullName: "L1",
      sponsorId: "TEST_ROOT", parentId: "TEST_ROOT", position: "L",
    });
    root.left = "TEST_L1"; await root.save();

    const l2 = await createUser({
      userId: "TEST_L2", fullName: "L2",
      sponsorId: "TEST_ROOT", parentId: "TEST_L1", position: "L",
    });
    l1.left = "TEST_L2"; await l1.save();

    const l3 = await createUser({
      userId: "TEST_L3", fullName: "L3",
      sponsorId: "TEST_ROOT", parentId: "TEST_L2", position: "L",
    });
    l2.left = "TEST_L3"; await l2.save();

    // Right single
    await createUser({
      userId: "TEST_R1", fullName: "R1",
      sponsorId: "TEST_ROOT", parentId: "TEST_ROOT", position: "R",
    });
    const rootRefresh = await getUser("TEST_ROOT");
    rootRefresh.right = "TEST_R1"; await rootRefresh.save();

    // Activate: SPONSOR, ROOT, L1, L2, L3, R1
    await processUserActivation("TEST_SPONSOR", 500);
    await processUserActivation("TEST_ROOT", 500);
    await processUserActivation("TEST_L1", 500);
    await processUserActivation("TEST_L2", 500);
    await processUserActivation("TEST_L3", 500);
    await processUserActivation("TEST_R1", 500);

    const rootFinal = await getUser("TEST_ROOT");

    // ROOT carry before R1: L=3, R=0. After R1: L=3, R=1.
    // matchPairs(3, 1): strong=L=3, weak=R=1, delta=2.
    //   phase1 = min(2, 1, 1) = 1 at 1:2. Consume L=2, R=1. Remaining L=1, R=0.
    //   phase2 = 0.
    //   Total = 1 pair. Carry: L=1, R=0.
    // Gross: 150, Net: 135.
    // ROOT direct: 4×25 = 100 (L1, L2, L3, R1)
    assertEq(rootFinal.directIncome, 100, "ROOT direct (4×₹25)");
    assertEq(rootFinal.pairIncome, 150, "ROOT pair (1 pair gross)");
    assertClose(rootFinal.walletBalance, 235, "ROOT wallet (100 + 135)");
    assertEq(rootFinal.carryLeft, 1, "ROOT carry left = 1 (leftover)");
    assertEq(rootFinal.carryRight, 0, "ROOT carry right = 0");

    // L1 carries: L=2, R=0. No matching (no right carry).
    const l1Final = await getUser("TEST_L1");
    assertEq(l1Final.carryLeft, 2, "L1 carry left = 2");
    assertEq(l1Final.carryRight, 0, "L1 carry right = 0");
    assertEq(l1Final.pairIncome, 0, "L1 no pair income (no right side)");
  });

  // ── Test: Carry-forward ──
  await runTest("Integration: Carry-forward persists for future matching", async () => {
    await cleanup();

    // Same tree as above but add R2 under R1 to trigger second match at ROOT
    await createUser({ userId: "TEST_SPONSOR", fullName: "Sponsor" });
    const root = await createUser({
      userId: "TEST_ROOT", fullName: "Root", sponsorId: "TEST_SPONSOR",
    });

    const l1 = await createUser({
      userId: "TEST_L1", fullName: "L1",
      sponsorId: "TEST_ROOT", parentId: "TEST_ROOT", position: "L",
    });
    root.left = "TEST_L1"; await root.save();

    const l2 = await createUser({
      userId: "TEST_L2", fullName: "L2",
      sponsorId: "TEST_ROOT", parentId: "TEST_L1", position: "L",
    });
    l1.left = "TEST_L2"; await l1.save();

    const r1 = await createUser({
      userId: "TEST_R1", fullName: "R1",
      sponsorId: "TEST_ROOT", parentId: "TEST_ROOT", position: "R",
    });
    const rootRefresh1 = await getUser("TEST_ROOT");
    rootRefresh1.right = "TEST_R1"; await rootRefresh1.save();

    // R2 under R1
    const r2 = await createUser({
      userId: "TEST_R2", fullName: "R2",
      sponsorId: "TEST_ROOT", parentId: "TEST_R1", position: "R",
    });
    const r1Refresh = await getUser("TEST_R1");
    r1Refresh.right = "TEST_R2"; await r1Refresh.save();

    // Activate in order
    await processUserActivation("TEST_SPONSOR", 500);
    await processUserActivation("TEST_ROOT", 500);
    await processUserActivation("TEST_L1", 500);
    await processUserActivation("TEST_L2", 500);

    // After L1, L2: ROOT carry L=2, R=0.
    let rootMid = await getUser("TEST_ROOT");
    assertEq(rootMid.carryLeft, 2, "ROOT carry left = 2 after L1, L2");
    assertEq(rootMid.carryRight, 0, "ROOT carry right = 0");

    await processUserActivation("TEST_R1", 500);

    // After R1: ROOT carry L=2, R=1 → match!
    // matchPairs(2, 1): strong=L=2, weak=R=1, delta=1.
    //   phase1 = min(1, 1, 1) = 1 at 1:2. Consume L=2, R=1. Carry: L=0, R=0.
    //   phase2 = 0.
    // Total = 1 pair.
    rootMid = await getUser("TEST_ROOT");
    assertEq(rootMid.carryLeft, 0, "ROOT carry left = 0 after R1 match");
    assertEq(rootMid.carryRight, 0, "ROOT carry right = 0 after R1 match");
    assertEq(rootMid.pairIncome, 150, "ROOT pair income = 150 after 1st match");

    await processUserActivation("TEST_R2", 500);

    // After R2: ROOT carry R=0+1=1. But carry L=0, so no new match at ROOT.
    // However R1 gets carry R=1. R1 has no left carry, so no match at R1 either.
    rootMid = await getUser("TEST_ROOT");
    assertEq(rootMid.carryRight, 1, "ROOT carry right = 1 after R2");
    assertEq(rootMid.carryLeft, 0, "ROOT carry left still 0");
    assertEq(rootMid.pairIncome, 150, "ROOT pair income unchanged (no new match)");
  });

  // ── Test: Unlimited-depth BV propagation ──
  await runTest("Integration: Unlimited-depth BV propagation (5 levels)", async () => {
    await cleanup();

    // Chain: ROOT → A → B → C → D (all left side)
    //        ROOT → R1 (right side)
    await createUser({ userId: "TEST_ROOT", fullName: "Root" });

    const a = await createUser({
      userId: "TEST_A", fullName: "A",
      sponsorId: "TEST_ROOT", parentId: "TEST_ROOT", position: "L",
    });
    let r = await getUser("TEST_ROOT"); r.left = "TEST_A"; await r.save();

    const b = await createUser({
      userId: "TEST_B", fullName: "B",
      sponsorId: "TEST_ROOT", parentId: "TEST_A", position: "L",
    });
    let aRef = await getUser("TEST_A"); aRef.left = "TEST_B"; await aRef.save();

    const c = await createUser({
      userId: "TEST_C", fullName: "C",
      sponsorId: "TEST_ROOT", parentId: "TEST_B", position: "L",
    });
    let bRef = await getUser("TEST_B"); bRef.left = "TEST_C"; await bRef.save();

    const d = await createUser({
      userId: "TEST_D", fullName: "D",
      sponsorId: "TEST_ROOT", parentId: "TEST_C", position: "L",
    });
    let cRef = await getUser("TEST_C"); cRef.left = "TEST_D"; await cRef.save();

    await createUser({
      userId: "TEST_R1", fullName: "R1",
      sponsorId: "TEST_ROOT", parentId: "TEST_ROOT", position: "R",
    });
    r = await getUser("TEST_ROOT"); r.right = "TEST_R1"; await r.save();

    // Activate all
    await processUserActivation("TEST_ROOT", 500);
    await processUserActivation("TEST_A", 500);
    await processUserActivation("TEST_B", 500);
    await processUserActivation("TEST_C", 500);
    await processUserActivation("TEST_D", 500);

    // After D activation, walk goes: D→C→B→A→ROOT.
    // Each ancestor on the path gets +1 left carry.
    // ROOT: leftCount=4 (A, B, C, D), carryLeft=4 (no matching yet, no right carry)
    r = await getUser("TEST_ROOT");
    assertEq(r.leftCount, 4, "ROOT leftCount=4 (BV propagated 4 levels up)");
    assertEq(r.carryLeft, 4, "ROOT carryLeft=4");

    aRef = await getUser("TEST_A");
    assertEq(aRef.leftCount, 3, "A leftCount=3 (B, C, D)");
    assertEq(aRef.carryLeft, 3, "A carryLeft=3");

    bRef = await getUser("TEST_B");
    assertEq(bRef.leftCount, 2, "B leftCount=2 (C, D)");

    cRef = await getUser("TEST_C");
    assertEq(cRef.leftCount, 1, "C leftCount=1 (D)");

    // Now activate R1 → ROOT gets right carry, should match
    await processUserActivation("TEST_R1", 500);

    r = await getUser("TEST_ROOT");
    assertEq(r.rightCount, 1, "ROOT rightCount=1");
    // matchPairs(4, 1): strong=L=4, weak=R=1, delta=3.
    //   phase1 = min(3, 1, 2) = 1 at 1:2. Consume L=2, R=1. Remaining L=2, R=0.
    //   phase2 = 0.
    // Total = 1 pair. Carry: L=2, R=0.
    assertEq(r.carryLeft, 2, "ROOT carry left = 2 after matching");
    assertEq(r.carryRight, 0, "ROOT carry right = 0 after matching");
    assertEq(r.pairIncome, 150, "ROOT pair income = 150");
  });

  // ── Test: Deductions are 10% (no repurchase) ──
  await runTest("Integration: Deductions are 8% admin + 2% TDS = 10% (no repurchase)", async () => {
    await cleanup();

    await createUser({ userId: "TEST_SPONSOR", fullName: "Sponsor" });
    const root = await createUser({
      userId: "TEST_ROOT", fullName: "Root", sponsorId: "TEST_SPONSOR",
    });
    await createUser({
      userId: "TEST_L1", fullName: "L1",
      sponsorId: "TEST_ROOT", parentId: "TEST_ROOT", position: "L",
    });
    root.left = "TEST_L1"; await root.save();
    await createUser({
      userId: "TEST_R1", fullName: "R1",
      sponsorId: "TEST_ROOT", parentId: "TEST_ROOT", position: "R",
    });
    const rootR = await getUser("TEST_ROOT"); rootR.right = "TEST_R1"; await rootR.save();

    await processUserActivation("TEST_SPONSOR", 500);
    await processUserActivation("TEST_ROOT", 500);
    await processUserActivation("TEST_L1", 500);
    await processUserActivation("TEST_R1", 500);

    const rootFinal = await getUser("TEST_ROOT");
    assertClose(rootFinal.adminDeduction, 12, "Admin deduction = 12 (8% of 150)");
    assertClose(rootFinal.tdsDeduction, 3, "TDS deduction = 3 (2% of 150)");
    assertEq(rootFinal.repurchaseDeduction, 0, "Repurchase deduction = 0 (removed in Phase 2)");
  });

  // ── Test: Duplicate-payment protection ──
  await runTest("Integration: Duplicate-payment protection (double activation)", async () => {
    await cleanup();

    await createUser({ userId: "TEST_SPONSOR", fullName: "Sponsor" });
    await createUser({ userId: "TEST_USER", fullName: "User", sponsorId: "TEST_SPONSOR" });

    await processUserActivation("TEST_SPONSOR", 500);
    await processUserActivation("TEST_USER", 500);

    const sp1 = await getUser("TEST_SPONSOR");
    const directBefore = sp1.directIncome;
    const walletBefore = sp1.walletBalance;
    const logCountBefore = sp1.incomeLogs.length;

    // Try to activate again – should be no-op
    const result = await processUserActivation("TEST_USER", 500);
    assert(result.success === true, "Second activation returns success");
    assert(result.message === "User already active", "Second activation message");

    const sp2 = await getUser("TEST_SPONSOR");
    assertEq(sp2.directIncome, directBefore, "No double direct income");
    assertEq(sp2.walletBalance, walletBefore, "No double wallet credit");
    assertEq(sp2.incomeLogs.length, logCountBefore, "No extra income logs");
  });

  // ── Test: Override income with 10% deductions ──
  await runTest("Integration: Override income (25% of gross, 10% deductions)", async () => {
    await cleanup();

    await createUser({ userId: "TEST_SPONSOR", fullName: "Sponsor" });
    const root = await createUser({
      userId: "TEST_ROOT", fullName: "Root", sponsorId: "TEST_SPONSOR",
    });
    await createUser({
      userId: "TEST_L1", fullName: "L1",
      sponsorId: "TEST_ROOT", parentId: "TEST_ROOT", position: "L",
    });
    root.left = "TEST_L1"; await root.save();
    await createUser({
      userId: "TEST_R1", fullName: "R1",
      sponsorId: "TEST_ROOT", parentId: "TEST_ROOT", position: "R",
    });
    const rootR = await getUser("TEST_ROOT"); rootR.right = "TEST_R1"; await rootR.save();

    await processUserActivation("TEST_SPONSOR", 500);
    await processUserActivation("TEST_ROOT", 500);
    await processUserActivation("TEST_L1", 500);
    await processUserActivation("TEST_R1", 500);

    const sp = await getUser("TEST_SPONSOR");

    // SPONSOR override: 25% of ROOT's gross pair (150) = 37.5
    // Deductions: admin = 37.5 * 0.08 = 3, TDS = 37.5 * 0.02 = 0.75
    // Net override = 37.5 - 3.75 = 33.75
    assertClose(sp.overrideIncome, 37.5, "SPONSOR override gross");
    // SPONSOR wallet = 25 (direct from ROOT) + 33.75 (net override) = 58.75
    assertClose(sp.walletBalance, 58.75, "SPONSOR wallet (25 + 33.75)");
    // SPONSOR deductions: admin = 3, TDS = 0.75
    assertClose(sp.adminDeduction, 3, "SPONSOR admin deduction on override");
    assertClose(sp.tdsDeduction, 0.75, "SPONSOR TDS deduction on override");
  });

  // ── Test: Daily cap via todayPairIncome ──
  await runTest("Integration: Daily cap limits pair income", async () => {
    await cleanup();

    // Create a simple pair (ROOT with L1, R1) but pre-set todayPairIncome near cap
    await createUser({ userId: "TEST_SPONSOR", fullName: "Sponsor" });
    const root = await createUser({
      userId: "TEST_ROOT", fullName: "Root", sponsorId: "TEST_SPONSOR",
    });
    await createUser({
      userId: "TEST_L1", fullName: "L1",
      sponsorId: "TEST_ROOT", parentId: "TEST_ROOT", position: "L",
    });
    root.left = "TEST_L1"; await root.save();
    await createUser({
      userId: "TEST_R1", fullName: "R1",
      sponsorId: "TEST_ROOT", parentId: "TEST_ROOT", position: "R",
    });
    const rootR = await getUser("TEST_ROOT"); rootR.right = "TEST_R1"; await rootR.save();

    // Activate sponsor and root
    await processUserActivation("TEST_SPONSOR", 500);
    await processUserActivation("TEST_ROOT", 500);

    // Manually set ROOT's todayPairIncome to 950 (only 50 remaining, < 150/pair)
    const rootPre = await getUser("TEST_ROOT");
    rootPre.todayPairIncome = 950;
    rootPre.lastIncomeDate = new Date();
    await rootPre.save();

    // Activate L1 and R1 to trigger matching at ROOT
    await processUserActivation("TEST_L1", 500);
    await processUserActivation("TEST_R1", 500);

    const rootFinal = await getUser("TEST_ROOT");
    // ROOT carry L=1, R=1 → matchPairs(1, 1, 50): max pairs = floor(50/150) = 0
    // No pair income should be credited. Carries should remain.
    assertEq(rootFinal.pairIncome, 0, "ROOT pair income = 0 (daily cap hit)");
    assertEq(rootFinal.carryLeft, 1, "ROOT carry left = 1 (preserved by cap)");
    assertEq(rootFinal.carryRight, 1, "ROOT carry right = 1 (preserved by cap)");
  });

  // ── Test: Recalculation restores correct state ──
  await runTest("Integration: Recalculation restores correct state after corruption", async () => {
    await cleanup();

    await createUser({ userId: "TEST_SPONSOR", fullName: "Sponsor" });
    const root = await createUser({
      userId: "TEST_ROOT", fullName: "Root", sponsorId: "TEST_SPONSOR",
    });
    await createUser({
      userId: "TEST_L1", fullName: "L1",
      sponsorId: "TEST_ROOT", parentId: "TEST_ROOT", position: "L",
    });
    root.left = "TEST_L1"; await root.save();
    await createUser({
      userId: "TEST_R1", fullName: "R1",
      sponsorId: "TEST_ROOT", parentId: "TEST_ROOT", position: "R",
    });
    const rootR = await getUser("TEST_ROOT"); rootR.right = "TEST_R1"; await rootR.save();

    await processUserActivation("TEST_SPONSOR", 500);
    await processUserActivation("TEST_ROOT", 500);
    await processUserActivation("TEST_L1", 500);
    await processUserActivation("TEST_R1", 500);

    // Record correct values
    const rootCorrect = await getUser("TEST_ROOT");
    const correctWallet = rootCorrect.walletBalance;
    const correctPair = rootCorrect.pairIncome;
    const correctDirect = rootCorrect.directIncome;

    // Corrupt data
    rootCorrect.walletBalance = 99999;
    rootCorrect.pairIncome = 88888;
    rootCorrect.directIncome = 77777;
    await rootCorrect.save();

    // Recalculate
    await recalculateAllMLM();

    const rootRestored = await getUser("TEST_ROOT");
    assertClose(rootRestored.walletBalance, correctWallet, "Wallet restored after recalc");
    assertClose(rootRestored.pairIncome, correctPair, "Pair income restored after recalc");
    assertClose(rootRestored.directIncome, correctDirect, "Direct income restored after recalc");
    assertEq(rootRestored.repurchaseDeduction, 0, "Repurchase stays 0 after recalc");
  });

  // ── Test: Mixed package direct bonuses ──
  await runTest("Integration: Mixed packages (₹500 and ₹600) in same tree", async () => {
    await cleanup();

    await createUser({ userId: "TEST_SPONSOR", fullName: "Sponsor" });
    await createUser({ userId: "TEST_C500", fullName: "Child 500", sponsorId: "TEST_SPONSOR" });
    await createUser({ userId: "TEST_C600", fullName: "Child 600", sponsorId: "TEST_SPONSOR" });

    await processUserActivation("TEST_SPONSOR", 500);
    await processUserActivation("TEST_C500", 500);
    await processUserActivation("TEST_C600", 600);

    const sp = await getUser("TEST_SPONSOR");
    // Direct: 25 (from C500) + 30 (from C600) = 55
    assertEq(sp.directIncome, 55, "SPONSOR direct = 25 + 30 = 55");
    assertEq(sp.walletBalance, 55, "SPONSOR wallet = 55");
  });
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function runAllTests() {
  try {
    console.log("Connecting to MongoDB...");
    await mongoose.connect(DB_URI);
    console.log("Connected to MongoDB.\n");

    // Run unit tests first (no DB needed for these)
    console.log("\n" + "▓".repeat(60));
    console.log("  UNIT TESTS");
    console.log("▓".repeat(60));
    await unitTests();

    // Run integration tests
    console.log("\n" + "▓".repeat(60));
    console.log("  INTEGRATION TESTS");
    console.log("▓".repeat(60));
    await integrationTests();

    // Final cleanup
    await cleanup();

    // Summary
    console.log("\n" + "═".repeat(60));
    console.log(`  RESULTS: ${passed} passed, ${failed} failed`);
    console.log("═".repeat(60));

    if (failedTests.length > 0) {
      console.log("\n  FAILED TESTS:");
      for (const t of failedTests) {
        console.log(`    ❌ ${t.name}`);
        console.log(`       ${t.error}`);
      }
      process.exit(1);
    } else {
      console.log("\n  🚀 ALL TESTS PASSED! Phase 2 MLM engine is working correctly.\n");
    }
  } catch (error) {
    console.error("\n  FATAL ERROR:", error);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
    console.log("Disconnected from MongoDB.");
  }
}

runAllTests();
