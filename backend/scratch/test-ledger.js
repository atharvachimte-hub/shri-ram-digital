const mongoose = require("mongoose");

const DB_URI = "mongodb://atharvachimte_db_user:846AgF2y1bwtS0Kd@ac-l2kdw4z-shard-00-00.cdoydlu.mongodb.net:27017,ac-l2kdw4z-shard-00-01.cdoydlu.mongodb.net:27017,ac-l2kdw4z-shard-00-02.cdoydlu.mongodb.net:27017/myapp?ssl=true&replicaSet=atlas-8n11xu-shard-0&authSource=admin&retryWrites=true&w=majority";
const User = require("../models/User");

async function runTests() {
  console.log("Connecting to Database...");
  await mongoose.connect(DB_URI);
  console.log("Connected.");

  const testUserId = "TEST_LEDGER_USER";

  try {
    // 1. Clean up old user if any
    await User.deleteMany({ userId: testUserId });

    // 2. Create test user with specific wallet balance and logs
    // Math: Direct (25) + Net Pair (127.5) - Withdraw Approved (50) = 102.5
    const user = new User({
      userId: testUserId,
      password: "password123",
      fullName: "Test Ledger User",
      walletBalance: 102.5,
      isActive: true,
      incomeLogs: [
        {
          type: "direct",
          amount: 25,
          description: "Direct sponsor income for child AC1",
          source: "AC1",
          date: new Date(Date.now() - 1000 * 60 * 60) // 1 hr ago
        },
        {
          type: "pair",
          amount: 127.5,
          description: "Binary matching pair: Gross 150, Deduct: Admin 12, TDS 3, Repurchase 7.5. Net: 127.5",
          source: "pair_match",
          date: new Date(Date.now() - 1000 * 60 * 30) // 30 mins ago
        },
        {
          type: "admin",
          amount: -50,
          description: "Withdraw approved: ₹50",
          source: "system",
          date: new Date(Date.now() - 1000 * 60 * 10) // 10 mins ago
        }
      ],
      withdrawRequests: [
        {
          amount: 50,
          status: "approved",
          requestDate: new Date(Date.now() - 1000 * 60 * 15),
          processedDate: new Date(Date.now() - 1000 * 60 * 10),
          paymentMethod: "BANK",
          accountHolderName: "Test Ledger User",
          bankName: "SBI",
          accountNumber: "12345",
          ifscCode: "SBIN123",
          upiId: ""
        },
        {
          amount: 30,
          status: "rejected",
          requestDate: new Date(Date.now() - 1000 * 60 * 5),
          processedDate: new Date(Date.now() - 1000 * 60 * 2),
          paymentMethod: "UPI",
          upiId: "test@upi",
          adminRemark: "Invalid UPI ID details"
        }
      ]
    });

    await user.save();
    console.log("Seeded test ledger user in database.");

    // Helper fetch client
    async function makeRequest(url) {
      const response = await fetch(`http://localhost:5000${url}`);
      return { status: response.status, data: await response.json() };
    }

    // 3. Test A: Fetch user ledger
    console.log("\n--- Test A: GET user ledger (All) ---");
    const resA = await makeRequest(`/api/user/${testUserId}/ledger`);
    console.log("Calculated Balance:", resA.data.calculatedBalance);
    console.log("Wallet Balance:", resA.data.walletBalance);
    console.log("Ledger Matches Wallet:", resA.data.ledgerMatchesWallet);
    console.log("Stats:", resA.data.stats);
    console.log("Total entries count:", resA.data.entries.length);

    if (!resA.data.success || !resA.data.ledgerMatchesWallet || resA.data.entries.length !== 7) {
      throw new Error("Test A failed! Ledger entries mismatch or balance mismatch.");
    }

    // 4. Test B: Filter by Credit
    console.log("\n--- Test B: GET user ledger (Filter: Credit) ---");
    const resB = await makeRequest(`/api/user/${testUserId}/ledger?filter=credit`);
    console.log("Credit entries count:", resB.data.entries.length);
    resB.data.entries.forEach(e => console.log(`  - Type: ${e.type}, Amount: ${e.amount}, CreditDebit: ${e.creditDebit}`));
    
    // Expected credits: Direct (25) + Binary gross (150) = 2 credits
    if (resB.data.entries.length !== 2) {
      throw new Error("Test B failed! Expected 2 credit entries.");
    }

    // 5. Test C: Filter by Debit
    console.log("\n--- Test C: GET user ledger (Filter: Debit) ---");
    const resC = await makeRequest(`/api/user/${testUserId}/ledger?filter=debit`);
    console.log("Debit entries count:", resC.data.entries.length);
    resC.data.entries.forEach(e => console.log(`  - Type: ${e.type}, Amount: ${e.amount}, CreditDebit: ${e.creditDebit}`));
    
    // Expected debits: Admin Fee (12) + TDS (3) + Repurchase (7.5) + Payout Debit (50) = 4 debits
    if (resC.data.entries.length !== 4) {
      throw new Error("Test C failed! Expected 4 debit entries.");
    }

    // 6. Test D: Filter by Deduction
    console.log("\n--- Test D: GET user ledger (Filter: Deduction) ---");
    const resD = await makeRequest(`/api/user/${testUserId}/ledger?filter=deduction`);
    console.log("Deductions count:", resD.data.entries.length);
    if (resD.data.entries.length !== 3) {
      throw new Error("Test D failed! Expected 3 deduction entries.");
    }

    // 7. Test E: Filter by Payout
    console.log("\n--- Test E: GET user ledger (Filter: Payout) ---");
    const resE = await makeRequest(`/api/user/${testUserId}/ledger?filter=payout`);
    console.log("Payout entries count:", resE.data.entries.length);
    resE.data.entries.forEach(e => console.log(`  - Type: ${e.type}, Amount: ${e.amount}, CreditDebit: ${e.creditDebit}, Remark: ${e.remark}`));
    
    // Expected payouts: Payout Debit (50) + Payout Rejected (30) = 2 entries
    if (resE.data.entries.length !== 2) {
      throw new Error("Test E failed! Expected 2 payout entries.");
    }

    // 8. Test F: Admin Master Ledger with search & pagination
    console.log("\n--- Test F: GET admin master ledger ---");
    const resF = await makeRequest(`/api/admin/ledger?search=${testUserId}`);
    console.log("Admin entries count:", resF.data.entries.length);
    console.log("Pagination:", resF.data.pagination);
    
    if (!resF.data.success || resF.data.entries.length !== 7) {
      throw new Error("Test F failed! Admin search did not retrieve all entries.");
    }

    console.log("\n=== ALL INCOME LEDGER & TRANSACTION HISTORY TESTS PASSED! 🚀 ===");

  } catch (err) {
    console.error("Test execution failed:", err);
  } finally {
    await User.deleteMany({ userId: testUserId });
    await mongoose.disconnect();
    console.log("Disconnected from Database.");
  }
}

runTests();
