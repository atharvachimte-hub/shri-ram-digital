const assert = require("assert");

async function runTests() {
  const baseUrl = "http://localhost:5000";

  console.log("Starting Admin Protection Verification Tests...\n");

  // Helper to make fetch request without following redirects
  async function request(path, headers = {}) {
    return await fetch(`${baseUrl}${path}`, {
      headers,
      redirect: "manual"
    });
  }

  // Test 1: Accessing admin-payout.html as guest (no cookies)
  // Expected: 302 Redirect to /admin.html
  {
    const res = await request("/admin-payout.html");
    console.log(`Test 1: Guest accessing admin-payout.html -> Status: ${res.status}, Location: ${res.headers.get("location")}`);
    assert.strictEqual(res.status, 302);
    assert.strictEqual(res.headers.get("location"), "/admin.html");
  }

  // Test 2: Accessing admin-payout.html as normal user (userAuth cookie)
  // Expected: 302 Redirect to /dashboard.html
  {
    const res = await request("/admin-payout.html", { Cookie: "userAuth=TESTUSER" });
    console.log(`Test 2: Normal user accessing admin-payout.html -> Status: ${res.status}, Location: ${res.headers.get("location")}`);
    assert.strictEqual(res.status, 302);
    assert.strictEqual(res.headers.get("location"), "/dashboard.html");
  }

  // Test 3: Accessing admin-payout.html as admin (adminAuth cookie)
  // Expected: 200 OK
  {
    const res = await request("/admin-payout.html", { Cookie: "adminAuth=admin123" });
    console.log(`Test 3: Admin accessing admin-payout.html -> Status: ${res.status}`);
    assert.strictEqual(res.status, 200);
  }

  // Test 4: Accessing api stats as guest (no cookies)
  // Expected: 401 Unauthorized
  {
    const res = await request("/api/admin/stats");
    console.log(`Test 4: Guest accessing api stats -> Status: ${res.status}`);
    assert.strictEqual(res.status, 401);
  }

  // Test 5: Accessing api stats as normal user (userAuth cookie)
  // Expected: 401 Unauthorized
  {
    const res = await request("/api/admin/stats", { Cookie: "userAuth=TESTUSER" });
    console.log(`Test 5: Normal user accessing api stats -> Status: ${res.status}`);
    assert.strictEqual(res.status, 401);
  }

  // Test 6: Accessing api stats as admin (adminAuth cookie)
  // Expected: 200 OK
  {
    const res = await request("/api/admin/stats", { Cookie: "adminAuth=admin123" });
    console.log(`Test 6: Admin accessing api stats -> Status: ${res.status}`);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.success, true);
  }

  // Test 7: Accessing admin.html as normal user (userAuth cookie)
  // Expected: 302 Redirect to /dashboard.html
  {
    const res = await request("/admin.html", { Cookie: "userAuth=TESTUSER" });
    console.log(`Test 7: Normal user accessing admin.html -> Status: ${res.status}, Location: ${res.headers.get("location")}`);
    assert.strictEqual(res.status, 302);
    assert.strictEqual(res.headers.get("location"), "/dashboard.html");
  }

  // Test 8: Accessing admin.html as guest (no cookies)
  // Expected: 200 OK (so they can load the login overlay)
  {
    const res = await request("/admin.html");
    console.log(`Test 8: Guest accessing admin.html -> Status: ${res.status}`);
    assert.strictEqual(res.status, 200);
  }

  console.log("\nAll Admin Protection Verification Tests Passed! 🎉");
}

runTests().catch(err => {
  console.error("\nVerification Test Failed: ❌", err.message);
  process.exit(1);
});
