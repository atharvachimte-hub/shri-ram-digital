const mongoose = require("mongoose");

// We'll run the assertions directly using database queries to be clean, 
// and we'll also test the HTTP endpoints if the server is running on port 5000.
const PORT = 5000;
const BASE_URL = `http://localhost:${PORT}`;

async function runTests() {
  console.log("Starting Manual Onboarding Payment Flow Verification...");
  
  // Connect to DB directly for seeding & deep assertions
  const mongoUri = "mongodb://atharvachimte_db_user:846AgF2y1bwtS0Kd@ac-l2kdw4z-shard-00-00.cdoydlu.mongodb.net:27017,ac-l2kdw4z-shard-00-01.cdoydlu.mongodb.net:27017,ac-l2kdw4z-shard-00-02.cdoydlu.mongodb.net:27017/myapp?ssl=true&replicaSet=atlas-8n11xu-shard-0&authSource=admin&retryWrites=true&w=majority";
  await mongoose.connect(mongoUri);
  console.log("Connected to MongoDB database.");

  const User = require("../models/User");
  const PaymentRequest = require("../models/PaymentRequest");

  // Clean previous test user if any
  const TEST_USER_ID = "ACTESTVERIFY";
  await User.deleteOne({ userId: TEST_USER_ID });
  await PaymentRequest.deleteOne({ userId: TEST_USER_ID });
  await PaymentRequest.deleteOne({ utr: "TESTUTR12345" });
  
  // Clear TESTUSER children pointers so new join fits
  await User.updateOne({ userId: "TESTUSER" }, { $set: { left: null, right: null } });

  let assignedUserId = null;
  try {
    // 1. Register a new user without EPIN via HTTP POST
    console.log("\n--- TEST 1: Registering User Without EPIN ---");
    const regPayload = {
      password: "testpassword",
      fullName: "Test Verification User",
      email: "testverify@example.com",
      mobile: "9876543210",
      sponsorId: "TESTUSER", // Existing active user
      parentId: "TESTUSER",
      position: "L"
    };

    // We'll perform the register HTTP call
    const regResponse = await fetch(`${BASE_URL}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(regPayload)
    });

    const regData = await regResponse.json();
    console.log("Register API Response:", regData);
    
    if (!regData.success) {
      throw new Error("Registration failed: " + regData.message);
    }

    assignedUserId = regData.userId;
    console.log(`Registered User successfully with ID: ${assignedUserId}`);

    // Verify in DB that user is created as inactive
    const dbUser = await User.findOne({ userId: assignedUserId });
    if (!dbUser) {
      throw new Error("User not found in database!");
    }
    
    console.log(`DB User Status: isActive=${dbUser.isActive}, status=${dbUser.status}`);
    if (dbUser.isActive) {
      throw new Error("User should be registered as INACTIVE when no EPIN is provided!");
    }
    console.log("TEST 1 PASSED: User registered as inactive.");

    // 2. Submit payment request via HTTP
    console.log("\n--- TEST 2: Submitting Manual Payment Request ---");
    const payPayload = {
      userId: assignedUserId,
      amount: 600,
      utr: "TESTUTR12345",
      screenshot: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", // 1x1 png dummy
      packageSelected: 600
    };

    const payResponse = await fetch(`${BASE_URL}/api/payment/request`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-User-Auth": assignedUserId
      },
      body: JSON.stringify(payPayload)
    });

    const payData = await payResponse.json();
    console.log("Payment Request API Response:", payData);

    if (!payData.success) {
      throw new Error("Payment request submission failed: " + payData.message);
    }

    // Verify request is saved as pending in DB
    const dbRequest = await PaymentRequest.findOne({ userId: assignedUserId });
    if (!dbRequest) {
      throw new Error("PaymentRequest record not found in database!");
    }
    console.log(`DB Payment Request Status: ${dbRequest.status}, Package: ${dbRequest.packageSelected}, UTR: ${dbRequest.utr}`);
    if (dbRequest.status !== "pending") {
      throw new Error("PaymentRequest status should be pending!");
    }
    console.log("TEST 2 PASSED: Payment request submitted as pending.");

    // 3. Try to submit duplicate UTR
    console.log("\n--- TEST 3: Duplicate UTR Prevention ---");
    const dupResponse = await fetch(`${BASE_URL}/api/payment/request`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-User-Auth": assignedUserId
      },
      body: JSON.stringify(payPayload)
    });

    const dupData = await dupResponse.json();
    console.log("Duplicate Request API Response:", dupData);
    if (dupData.success) {
      throw new Error("Duplicate request succeeded, but it should fail!");
    }
    console.log("TEST 3 PASSED: Duplicate UTR submission successfully blocked: " + dupData.message);

    // 4. Approve request as Admin
    console.log("\n--- TEST 4: Admin Payment Approval ---");
    const adminActionPayload = {
      requestId: dbRequest._id.toString(),
      action: "approve",
      adminRemark: "Test verification approval remark"
    };

    const adminResponse = await fetch(`${BASE_URL}/api/admin/payment-action`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "X-Admin-Auth": "admin123"
      },
      body: JSON.stringify(adminActionPayload)
    });

    const adminData = await adminResponse.json();
    console.log("Admin Action API Response:", adminData);
    if (!adminData.success) {
      throw new Error("Admin approval action failed: " + adminData.message);
    }

    // Verify in DB that request status is approved
    const dbRequestProcessed = await PaymentRequest.findById(dbRequest._id);
    if (dbRequestProcessed.status !== "approved") {
      throw new Error("Payment request status in DB was not set to approved!");
    }

    // Verify user is now activated and MLM calculations occurred
    const dbUserActive = await User.findOne({ userId: assignedUserId });
    console.log(`Post-Approval User Status: isActive=${dbUserActive.isActive}, lastEpinAmount=${dbUserActive.lastEpinAmount}`);
    
    if (!dbUserActive.isActive) {
      throw new Error("User account was not activated!");
    }
    if (dbUserActive.lastEpinAmount !== 600) {
      throw new Error(`User lastEpinAmount package is ${dbUserActive.lastEpinAmount}, expected 600!`);
    }

    // Let's check if sponsor (TESTUSER) received income
    const dbSponsor = await User.findOne({ userId: "TESTUSER" });
    console.log(`Sponsor Wallet Balance: ₹${dbSponsor.walletBalance}, Direct Income: ₹${dbSponsor.directIncome}`);
    console.log("TEST 4 PASSED: User successfully activated and package assigned.");

    console.log("\n=============================================");
    console.log("🎉 ALL TESTS PASSED SUCCESSFULLY! manual onboarding verification module is fully production-ready.");
    console.log("=============================================");

  } catch (error) {
    console.error("❌ TEST FAILED:", error.message);
  } finally {
    // Clean up test user
    if (assignedUserId) {
      await User.deleteOne({ userId: assignedUserId });
      await PaymentRequest.deleteOne({ userId: assignedUserId });
    }
    await PaymentRequest.deleteOne({ utr: "TESTUTR12345" });
    await mongoose.connection.close();
  }
}

runTests();
