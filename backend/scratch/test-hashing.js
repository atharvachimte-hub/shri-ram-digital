const mongoose = require("mongoose");
const User = require("../models/User");

const BASE_URL = "http://localhost:5000";

async function verifyHashing() {
  console.log("-----------------------------------------");
  console.log("VERIFYING LOGIN COMPATIBILITY & HASHING  ");
  console.log("-----------------------------------------");

  // Connect to DB
  await mongoose.connect(
    "mongodb://atharvachimte_db_user:846AgF2y1bwtS0Kd@ac-l2kdw4z-shard-00-00.cdoydlu.mongodb.net:27017,ac-l2kdw4z-shard-00-01.cdoydlu.mongodb.net:27017,ac-l2kdw4z-shard-00-02.cdoydlu.mongodb.net:27017/myapp?ssl=true&replicaSet=atlas-8n11xu-shard-0&authSource=admin&retryWrites=true&w=majority"
  );
  console.log("Connected to MongoDB.");

  try {
    // 1. Verify TESTUSER was seeded with plain password "1234"
    const testUserObj = await User.findOne({ userId: "TESTUSER" }).lean();
    console.log(`TESTUSER password in DB: "${testUserObj.password}" (Expected plain: "1234")`);
    if (testUserObj.password !== "1234") {
      throw new Error("Seed failed: TESTUSER password is not plain '1234'");
    }

    // 2. Verify login for TESTUSER / 1234
    console.log("\n[Test 1] Attempting login with plain password (TESTUSER / 1234)...");
    const loginRes1 = await fetch(`${BASE_URL}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "TESTUSER", password: "1234" })
    });
    console.log(`Status: ${loginRes1.status} (Expected: 200)`);
    const loginData1 = await loginRes1.json();
    console.log(`Response success: ${loginData1.success}`);
    if (loginRes1.status !== 200 || !loginData1.success) {
      throw new Error("Test 1 Failed: Could not login as TESTUSER / 1234");
    }
    console.log("Result: PASS");

    // 3. Register a temporary user using register endpoint
    // To register we need a valid EPIN. Let's create an unused EPIN directly in the DB.
    const Epin = require("../models/Epin");
    const epinCode = "SDTESTHASHING";
    await Epin.deleteOne({ code: epinCode });
    await Epin.create({ code: epinCode, amount: 500, status: "unused" });
    console.log(`\nCreated unused EPIN: ${epinCode}`);

    console.log("\n[Test 2] Registering new user with password 'mysecurepass123'...");
    const regRes = await fetch(`${BASE_URL}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        epinCode,
        fullName: "Hashing User",
        email: "hashinguser@example.com",
        mobile: "9988776655",
        password: "mysecurepass123",
        sponsorId: "TESTUSER"
      })
    });
    console.log(`Registration Status: ${regRes.status} (Expected: 200)`);
    const regData = await regRes.json();
    if (regRes.status !== 200 || !regData.success) {
      throw new Error("Test 2 Failed: Registration request failed");
    }
    const newUserId = regData.userId;
    console.log(`Registered user ID: ${newUserId}`);

    // Retrieve new user from DB to verify password is a SHA-256 hash (64 hex characters)
    const newUserObj = await User.findOne({ userId: newUserId }).lean();
    console.log(`Hashed password in DB: "${newUserObj.password}"`);
    const isSha256 = /^[0-9a-f]{64}$/i.test(newUserObj.password);
    console.log(`Password is SHA-256 hash? ${isSha256} (Expected: true)`);
    if (!isSha256) {
      throw new Error("Test 2 Failed: Password was not securely hashed in the DB");
    }
    console.log("Result: PASS");

    // 4. Verify login for new user with their plain password
    console.log("\n[Test 3] Attempting login with plain password for hashed user...");
    const loginRes2 = await fetch(`${BASE_URL}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: newUserId, password: "mysecurepass123" })
    });
    console.log(`Status: ${loginRes2.status} (Expected: 200)`);
    const loginData2 = await loginRes2.json();
    if (loginRes2.status !== 200 || !loginData2.success) {
      throw new Error("Test 3 Failed: Could not login hashed user with plain password");
    }
    console.log("Result: PASS");

    // 5. Test forgot password recovery resets to a hashed password
    console.log("\n[Test 4] Resetting password via forgot password flow...");
    const forgotRes = await fetch(`${BASE_URL}/api/auth/forgot-password`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: newUserId,
        contactInfo: "9988776655",
        newPassword: "newhackedpass"
      })
    });
    console.log(`Forgot Password Status: ${forgotRes.status} (Expected: 200)`);
    const forgotData = await forgotRes.json();
    if (forgotRes.status !== 200 || !forgotData.success) {
      throw new Error("Test 4 Failed: Forgot password reset request failed");
    }

    // Verify DB password is still a hash
    const updatedUserObj = await User.findOne({ userId: newUserId }).lean();
    console.log(`New updated password in DB: "${updatedUserObj.password}"`);
    const isUpdatedSha256 = /^[0-9a-f]{64}$/i.test(updatedUserObj.password);
    if (!isUpdatedSha256) {
      throw new Error("Test 4 Failed: New password reset was not hashed");
    }
    console.log("Result: PASS");

    // Try logging in with the new password
    console.log("\n[Test 5] Logging in with new reset password...");
    const loginRes3 = await fetch(`${BASE_URL}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: newUserId, password: "newhackedpass" })
    });
    console.log(`Status: ${loginRes3.status} (Expected: 200)`);
    const loginData3 = await loginRes3.json();
    if (loginRes3.status !== 200 || !loginData3.success) {
      throw new Error("Test 5 Failed: Login with reset password failed");
    }
    console.log("Result: PASS");

    // Cleanup temporary resources
    await User.deleteOne({ userId: newUserId });
    await Epin.deleteOne({ code: epinCode });
    console.log("\nCleanup completed.");

    console.log("=========================================");
    console.log("ALL VERIFICATION SUITES PASSED! 🚀");
    console.log("=========================================");

  } catch (err) {
    console.error("\nTEST SUITE ENCOUNTERED ERROR ❌");
    console.error(err.message);
    process.exit(1);
  } finally {
    await mongoose.connection.close();
  }
}

verifyHashing();
