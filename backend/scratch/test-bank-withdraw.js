const mongoose = require("mongoose");

// Connect to MongoDB
const DB_URI = "mongodb://atharvachimte_db_user:846AgF2y1bwtS0Kd@ac-l2kdw4z-shard-00-00.cdoydlu.mongodb.net:27017,ac-l2kdw4z-shard-00-01.cdoydlu.mongodb.net:27017,ac-l2kdw4z-shard-00-02.cdoydlu.mongodb.net:27017/myapp?ssl=true&replicaSet=atlas-8n11xu-shard-0&authSource=admin&retryWrites=true&w=majority";

const User = require("../models/User");

async function runTests() {
  console.log("Connecting to Database...");
  await mongoose.connect(DB_URI);
  console.log("Connected.");

  const testUserId = "TEST_BANK_USER";

  try {
    // Clean up
    await User.deleteMany({ userId: testUserId });

    // 1. Create a user with wallet balance but no bank details
    const user = new User({
      userId: testUserId,
      password: "password123",
      fullName: "Test Bank User",
      walletBalance: 1000,
      isActive: true
    });
    await user.save();
    console.log("Created user with zero bank details, wallet: ₹1000");

    // Helper fetch client
    async function makeRequest(url, method, body) {
      const response = await fetch(`http://localhost:5000${url}`, {
        method,
        headers: { "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined
      });
      return { status: response.status, data: await response.json() };
    }

    // 2. Fetch payout-details initially (should be empty strings)
    console.log("\n--- Test A: GET payout details initially ---");
    const resA = await makeRequest(`/api/user/${testUserId}/payout-details`, "GET");
    console.log("Data:", resA.data);
    if (!resA.data.success || resA.data.payoutDetails.bankName !== "") {
      throw new Error("Test A failed!");
    }

    // 3. Save payout details (partially missing holder name)
    console.log("\n--- Test B: PUT payout details (save info) ---");
    const resB = await makeRequest(`/api/user/${testUserId}/payout-details`, "PUT", {
      accountHolderName: "Atharva Chimte",
      bankName: "SBI Bank",
      accountNumber: "9876543210",
      ifscCode: "SBIN0007890",
      upiId: "atharva@upi"
    });
    console.log("Status:", resB.status, "Response:", resB.data);
    if (!resB.data.success || resB.data.payoutDetails.accountHolderName !== "Atharva Chimte") {
      throw new Error("Test B failed!");
    }

    // Verify they are saved in MongoDB
    const dbUser1 = await User.findOne({ userId: testUserId });
    console.log("DB User bank name:", dbUser1.bankName, "UPI:", dbUser1.upiId, "Holder:", dbUser1.accountHolderName);
    if (dbUser1.accountHolderName !== "Atharva Chimte" || dbUser1.ifscCode !== "SBIN0007890") {
      throw new Error("Bank details not persisted in MongoDB User Model!");
    }

    // 4. Try requesting BANK transfer (should succeed since bank details are set)
    console.log("\n--- Test C: Request BANK transfer (valid details) ---");
    const resC = await makeRequest("/api/withdraw/request", "POST", {
      userId: testUserId,
      amount: 150,
      paymentMethod: "BANK",
      note: "Valid bank test"
    });
    console.log("Response:", resC.data);
    if (!resC.data.success) {
      throw new Error("Test C failed!");
    }

    // Clear bank details to test conditional validation
    await User.updateOne({ userId: testUserId }, { $set: { bankName: "", accountNumber: "", ifscCode: "", accountHolderName: "" } });
    console.log("Cleared bank details for validation test");

    // 5. Try requesting BANK transfer with missing bank details (should fail)
    console.log("\n--- Test D: Request BANK transfer with missing bank details ---");
    const resD = await makeRequest("/api/withdraw/request", "POST", {
      userId: testUserId,
      amount: 150,
      paymentMethod: "BANK",
      note: "Invalid bank test"
    });
    console.log("Status:", resD.status, "Response:", resD.data);
    if (resD.data.success !== false || !resD.data.message.includes("Bank details")) {
      throw new Error("Test D failed!");
    }

    // 6. Try requesting UPI transfer (should succeed since upiId is set)
    console.log("\n--- Test E: Request UPI transfer (valid UPI ID) ---");
    const resE = await makeRequest("/api/withdraw/request", "POST", {
      userId: testUserId,
      amount: 150,
      paymentMethod: "UPI",
      note: "Valid UPI test"
    });
    console.log("Response:", resE.data);
    if (!resE.data.success) {
      throw new Error("Test E failed!");
    }

    // Clear UPI details to test validation
    await User.updateOne({ userId: testUserId }, { $set: { upiId: "" } });
    console.log("Cleared UPI ID for validation test");

    // 7. Try requesting UPI transfer with missing UPI details (should fail)
    console.log("\n--- Test F: Request UPI with missing UPI ID ---");
    const resF = await makeRequest("/api/withdraw/request", "POST", {
      userId: testUserId,
      amount: 150,
      paymentMethod: "UPI",
      note: "Invalid UPI test"
    });
    console.log("Status:", resF.status, "Response:", resF.data);
    if (resF.data.success !== false || !resF.data.message.includes("UPI ID is required")) {
      throw new Error("Test F failed!");
    }

    // 8. Test admin rejected payout aggregation stats
    console.log("\n--- Test G: Test admin stats rejected payout sums ---");
    const adminStats1 = await makeRequest("/api/admin/stats", "GET");
    const initRejected = adminStats1.data.stats.totalRejectedWithdraw || 0;
    console.log("Initial rejected payout sum:", initRejected);

    // Get the index of the UPI request we submitted (since it's at index 1)
    const adminReqs = await makeRequest("/api/admin/withdraw-requests", "GET");
    const testReq = adminReqs.data.requests.find(r => r.userId === testUserId && r.status === "pending");
    console.log("Found pending request at index:", testReq.index);

    // Reject it
    await makeRequest("/api/admin/withdraw-action", "PATCH", {
      userId: testUserId,
      index: testReq.index,
      action: "reject",
      adminRemark: "Rejecting Test G"
    });
    console.log("Rejected request.");

    const adminStats2 = await makeRequest("/api/admin/stats", "GET");
    const afterRejected = adminStats2.data.stats.totalRejectedWithdraw || 0;
    console.log("Rejected payout sum after rejection:", afterRejected);
    if (afterRejected !== initRejected + 150) {
      throw new Error("Rejected payout stats did not sum correctly!");
    }

    console.log("\n=== ALL BANK/UPI VALIDATION & FLOW TESTS PASSED! 🚀 ===");

  } catch (err) {
    console.error("Test execution failed:", err);
  } finally {
    await User.deleteMany({ userId: testUserId });
    await mongoose.disconnect();
    console.log("Disconnected from Database.");
  }
}

runTests();
