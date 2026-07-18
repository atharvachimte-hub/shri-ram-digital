const mongoose = require("mongoose");
const User = require("../models/User");

const BASE_URL = "http://localhost:5000";

async function runTests() {
  console.log("-----------------------------------------");
  console.log("RUNNING AUTH & SECURITY INTEGRATION TESTS");
  console.log("-----------------------------------------");

  // Connect to MongoDB to prepare seed data
  await mongoose.connect(
    "mongodb://atharvachimte_db_user:846AgF2y1bwtS0Kd@ac-l2kdw4z-shard-00-00.cdoydlu.mongodb.net:27017,ac-l2kdw4z-shard-00-01.cdoydlu.mongodb.net:27017,ac-l2kdw4z-shard-00-02.cdoydlu.mongodb.net:27017/myapp?ssl=true&replicaSet=atlas-8n11xu-shard-0&authSource=admin&retryWrites=true&w=majority"
  );
  console.log("Connected to MongoDB for seeding.");

  // Update/Ensure TESTUSER has mobile and email
  await User.updateOne(
    { userId: "TESTUSER" },
    {
      $set: {
        mobile: "1234567890",
        email: "testuser@gmail.com",
        password: "1234"
      }
    },
    { upsert: true }
  );
  console.log("Seeded TESTUSER with credentials.");

  try {
    // Test 1: Route Protection for user endpoints without auth header
    console.log("\n[Test 1] User endpoints without header...");
    const res1 = await fetch(`${BASE_URL}/api/user/TESTUSER`);
    console.log(`Status: ${res1.status} (Expected: 401)`);
    if (res1.status !== 401) throw new Error("Test 1 Failed: Allowed access without auth header");
    console.log("Result: PASS");

    // Test 2: Route Protection with incorrect auth header
    console.log("\n[Test 2] User endpoints with mismatched header...");
    const res2 = await fetch(`${BASE_URL}/api/user/TESTUSER`, {
      headers: { "X-User-Auth": "ANOTHERUSER" }
    });
    console.log(`Status: ${res2.status} (Expected: 401)`);
    if (res2.status !== 401) throw new Error("Test 2 Failed: Allowed access with mismatched user auth header");
    console.log("Result: PASS");

    // Test 3: Route Protection with correct auth header
    console.log("\n[Test 3] User endpoints with correct header...");
    const res3 = await fetch(`${BASE_URL}/api/user/TESTUSER`, {
      headers: { "X-User-Auth": "TESTUSER" }
    });
    console.log(`Status: ${res3.status} (Expected: 200)`);
    const data3 = await res3.json();
    if (res3.status !== 200 || !data3.success) throw new Error("Test 3 Failed: Access denied with correct auth header");
    console.log(`Password field exposed? ${data3.user.password !== undefined} (Expected: false)`);
    if (data3.user.password !== undefined) throw new Error("Test 3 Failed: User password leaked in response!");
    console.log("Result: PASS");

    // Test 4: Route Protection for admin endpoints
    console.log("\n[Test 4] Admin endpoints without header...");
    const res4 = await fetch(`${BASE_URL}/api/admin/stats`);
    console.log(`Status: ${res4.status} (Expected: 401)`);
    if (res4.status !== 401) throw new Error("Test 4 Failed: Admin endpoint allowed access without header");
    console.log("Result: PASS");

    console.log("\n[Test 4b] Admin endpoints with incorrect header...");
    const res4b = await fetch(`${BASE_URL}/api/admin/stats`, {
      headers: { "X-Admin-Auth": "wrongsecret" }
    });
    console.log(`Status: ${res4b.status} (Expected: 401)`);
    if (res4b.status !== 401) throw new Error("Test 4b Failed: Admin endpoint allowed access with wrong header");
    console.log("Result: PASS");

    console.log("\n[Test 4c] Admin endpoints with correct header...");
    const res4c = await fetch(`${BASE_URL}/api/admin/stats`, {
      headers: { "X-Admin-Auth": "admin123" }
    });
    console.log(`Status: ${res4c.status} (Expected: 200)`);
    if (res4c.status !== 200) throw new Error("Test 4c Failed: Admin access denied with correct header");
    console.log("Result: PASS");

    // Test 5: Forgot Password Recovery
    console.log("\n[Test 5] Forgot Password recovery validation...");
    const forgotRes1 = await fetch(`${BASE_URL}/api/auth/forgot-password`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: "TESTUSER",
        contactInfo: "wrong@wrong.com",
        newPassword: "newpassword123"
      })
    });
    console.log(`Status: ${forgotRes1.status} (Expected: 400/404/401)`);
    const forgotData1 = await forgotRes1.json();
    console.log(`Message: "${forgotData1.message}"`);
    if (forgotRes1.status === 200) throw new Error("Test 5 Failed: Reset password with wrong contact succeeded");

    console.log("\n[Test 5b] Forgot Password recovery with correct mobile...");
    const forgotRes2 = await fetch(`${BASE_URL}/api/auth/forgot-password`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: "TESTUSER",
        contactInfo: "1234567890",
        newPassword: "newsecurepass"
      })
    });
    console.log(`Status: ${forgotRes2.status} (Expected: 200)`);
    const forgotData2 = await forgotRes2.json();
    console.log(`Message: "${forgotData2.message}"`);
    if (forgotRes2.status !== 200 || !forgotData2.success) throw new Error("Test 5b Failed: Forgot password reset failed");
    console.log("Result: PASS");

    // Test 6: Rate Limiting
    console.log("\n[Test 6] Simulating login rate-limiting (25 requests)...");
    let rateLimited = false;
    for (let i = 0; i < 25; i++) {
      const res = await fetch(`${BASE_URL}/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: "TESTUSER", password: "somepassword" })
      });
      if (res.status === 429) {
        console.log(`Blocked at request #${i + 1} with HTTP 429 Too Many Requests`);
        rateLimited = true;
        break;
      }
    }
    if (!rateLimited) {
      throw new Error("Test 6 Failed: Rate limiting did not trigger after 25 rapid requests");
    }
    console.log("Result: PASS");

    console.log("\n=========================================");
    console.log("ALL TESTS COMPLETED SUCCESSFULLY! 🎉");
    console.log("=========================================");
  } catch (err) {
    console.error("\nTEST RUN ENCOUNTERED FAILURE ❌");
    console.error(err.message);
    process.exit(1);
  } finally {
    await mongoose.connection.close();
  }
}

runTests();
