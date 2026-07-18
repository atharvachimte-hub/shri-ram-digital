require("dotenv").config({ path: require("path").join(__dirname, ".env") });
const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const epinRoutes = require("./routes/epinRoutes");
const path = require("path");
const { processUserActivation, recalculateAllMLM } = require("./utils/mlmCalc");

const User = require("./models/User");
const Epin = require("./models/Epin");
const PaymentRequest = require("./models/PaymentRequest");

const app = express();

const ADMIN_USERNAME = process.env.ADMIN_USERNAME || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin123";

app.use(cors());
app.use(express.json());

// Admin Pages Authorization Guard (Server-Side)
const adminPages = [
  "/admin.html", "/admin",
  "/admin-payout.html", "/admin-payout",
  "/admin-ledger.html", "/admin-ledger",
  "/epin-manager.html", "/epin-manager",
  "/admin-income.html", "/admin-income",
  "/admin-withdraw.html", "/admin-withdraw",
  "/admin-payments.html", "/admin-payments"
];

function adminPageGuard(req, res, next) {
  const auth = getCookie(req, "adminAuth");
  if (auth !== ADMIN_PASSWORD) {
    const userAuth = getCookie(req, "userAuth");
    if (userAuth) {
      return res.redirect("/dashboard.html");
    }
    // If requesting admin.html directly, let them load it to log in
    if (req.path === "/admin.html" || req.path === "/admin") {
      return next();
    }
    return res.redirect("/admin.html");
  }
  next();
}

adminPages.forEach(page => {
  app.get(page, adminPageGuard, (req, res) => {
    const pageName = req.path.replace(/^\//, "");
    const finalFile = pageName.endsWith(".html") ? pageName : pageName + ".html";
    res.sendFile(path.join(__dirname, "public", finalFile));
  });
});

app.use(express.static(path.join(__dirname, "public")));

const ipRequestCounts = {};
function apiRateLimiter(maxRequests, windowMs) {
  return (req, res, next) => {
    const ip = req.ip || req.headers["x-forwarded-for"] || req.socket.remoteAddress;
    const now = Date.now();

    if (!ipRequestCounts[ip]) {
      ipRequestCounts[ip] = [];
    }

    // Filter out requests older than windowMs
    ipRequestCounts[ip] = ipRequestCounts[ip].filter((time) => now - time < windowMs);

    if (ipRequestCounts[ip].length >= maxRequests) {
      return res.status(429).json({
        success: false,
        message: "Too many requests. Please try again later."
      });
    }

    ipRequestCounts[ip].push(now);
    next();
  };
}

function getCookie(req, name) {
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) return null;
  const cookies = cookieHeader.split(";");
  for (let cookie of cookies) {
    const [key, val] = cookie.trim().split("=");
    if (key === name) return decodeURIComponent(val);
  }
  return null;
}

function adminAuthGuard(req, res, next) {
  const authHeader = req.headers["x-admin-auth"];
  const authCookie = getCookie(req, "adminAuth");
  const auth = authHeader || authCookie;

  if (auth !== ADMIN_PASSWORD) {
    return res.status(401).json({
      success: false,
      message: "Unauthorized admin access"
    });
  }
  next();
}

function userAuthGuard(req, res, next) {
  const reqUserId = normalizeUserId(req.params.id || req.body.userId);
  const authUserIdHeader = req.headers["x-user-auth"];
  const authUserIdCookie = getCookie(req, "userAuth");
  const authUserId = authUserIdHeader || authUserIdCookie;

  if (!authUserId || reqUserId !== normalizeUserId(authUserId)) {
    return res.status(401).json({
      success: false,
      message: "Unauthorized user access"
    });
  }
  next();
}

async function anyAuthGuard(req, res, next) {
  const adminAuthHeader = req.headers["x-admin-auth"];
  const adminAuthCookie = getCookie(req, "adminAuth");
  const adminAuth = adminAuthHeader || adminAuthCookie;

  if (adminAuth === ADMIN_PASSWORD) {
    return next();
  }

  const authUserIdHeader = req.headers["x-user-auth"];
  const authUserIdCookie = getCookie(req, "userAuth");
  const authUserId = authUserIdHeader || authUserIdCookie;

  if (authUserId) {
    try {
      const userExists = await User.findOne({ userId: normalizeUserId(authUserId) }).lean();
      if (userExists) {
        return next();
      }
    } catch (e) {
      console.error("anyAuthGuard DB error:", e);
    }
  }

  return res.status(401).json({
    success: false,
    message: "Unauthorized access"
  });
}

app.use("/api/epins", epinRoutes);

const PORT = process.env.PORT || 5000;

mongoose
  .connect(process.env.MONGODB_URI)
  .then(async () => {
    console.log("MongoDB connected 🔥");
    try {
      const testUser = await User.findOne({ userId: "TESTUSER" });
      if (!testUser) {
        await User.create({
          userId: "TESTUSER",
          password: "1234",
          fullName: "Test User",
          isActive: true,
          status: "active",
          lastEpinAmount: 500,
          walletBalance: 1000,
          todayIncome: 0,
          directIncome: 0,
          pairIncome: 0
        });
        console.log("Seeded testuser successfully.");
      } else {
        testUser.isActive = true;
        testUser.status = "active";
        testUser.lastEpinAmount = 500;
        testUser.password = "1234";
        await testUser.save();
        console.log("Forced testuser to active and reset password to 1234 on startup.");
      }
    } catch (e) {
      console.error("Failed to seed testuser:", e);
    }
  })
  .catch((error) => console.error("MongoDB error:", error));

const crypto = require("crypto");

function isHash(password) {
  return /^[0-9a-f]{64}$/i.test(password);
}

function hashPassword(password) {
  return crypto.createHash("sha256").update(password).digest("hex");
}

function randomUserId() {
  return "AC" + Math.floor(100000 + Math.random() * 900000);
}

function safeNumber(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function isValidObjectId(value) {
  return mongoose.Types.ObjectId.isValid(value);
}

function normalizeUserId(value) {
  return String(value || "").trim().toUpperCase();
}

function normalizeText(value, fallback = "") {
  return typeof value === "string" ? value.trim() : fallback;
}

function formatDateTime(value) {
  return value ? new Date(value) : null;
}

function getPendingWithdrawAmount(user) {
  if (!user || !Array.isArray(user.withdrawRequests)) return 0;

  let total = 0;

  for (const req of user.withdrawRequests) {
    if (req && req.status === "pending") {
      total += safeNumber(req.amount);
    }
  }

  return total;
}

function getAvailableWithdrawBalance(user) {
  const walletBalance = safeNumber(user?.walletBalance);
  const pendingAmount = getPendingWithdrawAmount(user);
  return Math.max(0, walletBalance - pendingAmount);
}

function formatWithdrawRequest(request, extra = {}) {
  if (!request) return null;

  return {
    _id: request._id,
    amount: safeNumber(request.amount),
    status: request.status || "pending",
    requestDate: request.requestDate || null,
    processedDate: request.processedDate || null,
    paymentMethod: request.paymentMethod || "",
    accountHolderName: request.accountHolderName || "",
    bankName: request.bankName || "",
    accountNumber: request.accountNumber || "",
    ifscCode: request.ifscCode || "",
    upiId: request.upiId || "",
    note: request.note || "",
    adminRemark: request.adminRemark || "",
    ...extra,
  };
}

function buildIncomeLog(type, amount, description) {
  return {
    type,
    amount: safeNumber(amount),
    description: description || "",
    date: new Date(),
  };
}

async function findUniqueUserId() {
  let userId = randomUserId();
  let exists = await User.findOne({ userId });

  while (exists) {
    userId = randomUserId();
    exists = await User.findOne({ userId });
  }

  return userId;
}

async function getSponsorName(sponsorId) {
  if (!sponsorId) return "";
  const sponsor = await User.findOne({ userId: sponsorId }).lean();
  return sponsor?.fullName || "";
}

async function updateSingleParentChildCount(parentUserId) {
  // Safe compat: handled dynamically on activation
}

async function updateCountsUpline(startParentId) {
  // Safe compat: handled dynamically on activation
}

async function calculateIncomeForUser(userId) {
  // Safe compat: handled dynamically on activation
}

async function calculateIncomeUpline(startUserId) {
  // Safe compat: handled dynamically on activation
}

function buildAdminBusinessStatus(user) {
  const totalIncome = safeNumber(user.totalIncome);
  const active = !!user.isActive;

  if (active && totalIncome > 0) return "Active Earner";
  if (active) return "Active";
  if (!active && totalIncome > 0) return "Inactive Earner";
  return "Inactive";
}

async function buildTree(userId, depth = 5) {
  if (!userId || depth <= 0) return null;

  const user = await User.findOne({ userId }).lean();
  if (!user) return null;

  const sponsorName = await getSponsorName(user.sponsorId);

  const leftTree = user.left ? await buildTree(user.left, depth - 1) : null;
  const rightTree = user.right ? await buildTree(user.right, depth - 1) : null;

  const totalReferral = safeNumber(user.leftCount) + safeNumber(user.rightCount);
  const carryForward = safeNumber(user.carryLeft) + safeNumber(user.carryRight);

  return {
    _id: user._id,
    userId: user.userId,
    fullName: user.fullName || "No Name",
    email: user.email || "",
    mobile: user.mobile || "",
    profilePic: user.profilePic || "",
    sponsorId: user.sponsorId || null,
    sponsorName: sponsorName || "",
    parentId: user.parentId || null,
    position: user.position || "ROOT",
    leftCount: safeNumber(user.leftCount),
    rightCount: safeNumber(user.rightCount),
    totalIncome: safeNumber(user.totalIncome),
    todayIncome: safeNumber(user.todayIncome),
    directIncome: safeNumber(user.directIncome),
    pairIncome: safeNumber(user.pairIncome),
    carryLeft: safeNumber(user.carryLeft),
    carryRight: safeNumber(user.carryRight),
    carryForward,
    breakage: 0,
    dailyCap: 1000,
    joiningAmount: 500,
    referralCount: totalReferral,
    totalReferral,
    isActive: !!user.isActive,
    status: user.status || (user.isActive ? "active" : "inactive"),
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    businessStatus: buildAdminBusinessStatus(user),
    walletBalance: safeNumber(user.walletBalance),
    totalWithdrawn: safeNumber(user.totalWithdrawn),
    availableWithdrawBalance: getAvailableWithdrawBalance(user),
    left: leftTree,
    right: rightTree,
  };
}

function normalizePage(page) {
  const value = parseInt(page, 10);
  if (!Number.isFinite(value) || value < 1) return 1;
  return value;
}

function normalizeLimit(limit) {
  const value = parseInt(limit, 10);
  if (!Number.isFinite(value) || value < 1) return 10;
  return Math.min(value, 100);
}

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/dashboard", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "dashboard.html"));
});

app.get("/tree", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "tree-view.html"));
});

app.get("/registration.html", (req, res) => {
  res.redirect("/register.html");
});

// USER DETAILS
app.get("/api/user/:id", userAuthGuard, async (req, res) => {
  try {
    const user = await User.findOne({ userId: req.params.id.toUpperCase() }).lean();

    if (!user) {
      return res.json({ success: false, message: "User not found" });
    }

    if (user && user.password) {
      delete user.password;
    }
    const sponsorName = await getSponsorName(user.sponsorId);
    const referralCount = await User.countDocuments({ sponsorId: user.userId });

    return res.json({
      success: true,
      user: {
        ...user,
        sponsorName,
        referralCount,
        walletBalance: safeNumber(user.walletBalance),
        totalWithdrawn: safeNumber(user.totalWithdrawn),
        availableWithdrawBalance: getAvailableWithdrawBalance(user),
        pendingWithdrawAmount: getPendingWithdrawAmount(user),
      },
    });
  } catch (error) {
    console.error("GET USER ERROR:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// REGISTER
app.post("/register", apiRateLimiter(10, 60000), async (req, res) => {
  try {
    const { password, sponsorId, parentId, position, epinCode, fullName, email, mobile } = req.body;

    if (!password || String(password).trim().length < 4) {
      return res.status(400).json({
        success: false,
        message: "Password must be at least 4 characters long",
      });
    }

    if (!fullName || String(fullName).trim().length === 0) {
      return res.status(400).json({
        success: false,
        message: "Full Name is required",
      });
    }

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({
        success: false,
        message: "A valid email address is required",
      });
    }

    if (!mobile || !/^\d{10}$/.test(String(mobile).trim())) {
      return res.status(400).json({
        success: false,
        message: "A valid 10-digit mobile number is required",
      });
    }

    const hasEpin = epinCode && String(epinCode).trim().length > 0;
    let amt = 0;
    let epin = null;

    if (hasEpin) {
      const cleanEpinCode = String(epinCode).trim().toUpperCase();
      if (!cleanEpinCode.startsWith("SD")) {
        return res.status(400).json({
          success: false,
          message: "Invalid EPIN code (must start with SD)",
        });
      }

      // Find and validate EPIN
      epin = await Epin.findOne({ code: cleanEpinCode });
      if (!epin) {
        return res.status(400).json({
          success: false,
          message: "Invalid EPIN code",
        });
      }

      if (epin.status === "used") {
        return res.status(400).json({
          success: false,
          message: "EPIN code has already been used",
        });
      }

      if (epin.amount !== 500 && epin.amount !== 600) {
        return res.status(400).json({
          success: false,
          message: "Invalid EPIN amount. Must be 500 or 600",
        });
      }
      amt = epin.amount;
    }

    const cleanSponsorId = sponsorId ? String(sponsorId).trim().toUpperCase() : null;
    const cleanParentId = parentId ? String(parentId).trim().toUpperCase() : null;
    let cleanPosition = position ? String(position).trim().toUpperCase() : null;
    if (cleanPosition === "LEFT" || cleanPosition === "L") {
      cleanPosition = "L";
    } else if (cleanPosition === "RIGHT" || cleanPosition === "R") {
      cleanPosition = "R";
    }

    if (cleanSponsorId) {
      const sponsorExists = await User.findOne({ userId: cleanSponsorId });
      if (!sponsorExists) {
        return res.status(400).json({
          success: false,
          message: "Sponsor User ID does not exist",
        });
      }
    }

    let parent = null;
    if (cleanParentId) {
      parent = await User.findOne({ userId: cleanParentId });
      if (!parent) {
        return res.status(400).json({
          success: false,
          message: "Parent User ID does not exist",
        });
      }

      if (cleanPosition !== "L" && cleanPosition !== "R") {
        return res.status(400).json({
          success: false,
          message: "Position must be L (Left) or R (Right)",
        });
      }

      if (cleanPosition === "L" && parent.left) {
        return res.status(400).json({
          success: false,
          message: `Parent already has a Left child: ${parent.left}`,
        });
      }

      if (cleanPosition === "R" && parent.right) {
        return res.status(400).json({
          success: false,
          message: `Parent already has a Right child: ${parent.right}`,
        });
      }
    }

    // Generate unique user ID
    const userId = await findUniqueUserId();

    // Link parent
    if (parent) {
      if (cleanPosition === "L") {
        parent.left = userId;
      } else {
        parent.right = userId;
      }
      await parent.save();
    }

    // Direct sponsor income is handled inside processUserActivation (Phase 2)
    // No inline payment here – single source of truth in mlmCalc.js

    const newUser = new User({
      userId,
      password: hashPassword(password),
      fullName: fullName || "No Name",
      email: email || "",
      mobile: mobile || "",
      profilePic: "",
      sponsorId: cleanSponsorId,
      parentId: cleanParentId,
      position: cleanPosition,
      lastEpinAmount: amt,
      totalEpinUsed: hasEpin ? 1 : 0,
      isActive: false, // Inactive by default until paid/activated
    });

    await newUser.save();

    if (hasEpin) {
      // Automatically activate user and trigger MLM calculations upon registration
      await processUserActivation(userId, amt);

      // Update EPIN status to used
      epin.status = "used";
      epin.usedBy = userId;
      epin.usedFor = "account_activation";
      epin.usedAt = new Date();
      await epin.save();
    }

    return res.json({
      success: true,
      message: "User registered successfully",
      userId,
    });
  } catch (error) {
    console.error("REGISTER ERROR:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// LOGIN
app.post("/login", apiRateLimiter(20, 60000), async (req, res) => {
  try {
    const { userId, password } = req.body;

    if (!userId || !password || String(userId).trim().length === 0 || String(password).length === 0) {
      return res.status(400).json({
        success: false,
        message: "User ID and password are required",
      });
    }

    const user = await User.findOne({
      userId: String(userId).trim().toUpperCase(),
    }).lean();

    if (!user) {
      return res.status(401).json({
        success: false,
        message: "Invalid user ID or password",
      });
    }

    let isMatch = false;
    if (isHash(user.password)) {
      isMatch = (user.password === hashPassword(password));
    } else {
      isMatch = (user.password === String(password));
    }

    if (!isMatch) {
      return res.status(401).json({
        success: false,
        message: "Invalid user ID or password",
      });
    }

    res.setHeader("Set-Cookie", `userAuth=${user.userId}; Path=/; SameSite=Strict; Max-Age=86400`);
    return res.json({
      success: true,
      message: "Login successful",
      user: {
        userId: user.userId,
        fullName: user.fullName,
        isActive: user.isActive,
        sponsorId: user.sponsorId,
        position: user.position,
        walletBalance: safeNumber(user.walletBalance),
        totalWithdrawn: safeNumber(user.totalWithdrawn),
        availableWithdrawBalance: getAvailableWithdrawBalance(user),
      },
    });
  } catch (error) {
    console.error("LOGIN ERROR:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// FORGOT PASSWORD
app.post("/api/auth/forgot-password", apiRateLimiter(5, 60000), async (req, res) => {
  try {
    const { userId, contactInfo, newPassword } = req.body;

    if (!userId || !contactInfo || !newPassword) {
      return res.status(400).json({
        success: false,
        message: "User ID, email/mobile verification details, and new password are required"
      });
    }

    const cleanUserId = String(userId).trim().toUpperCase();
    const cleanContact = String(contactInfo).trim().toLowerCase();
    const cleanPassword = String(newPassword);

    if (cleanPassword.length < 4) {
      return res.status(400).json({
        success: false,
        message: "Password must be at least 4 characters long"
      });
    }

    const user = await User.findOne({ userId: cleanUserId });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User ID not found in system"
      });
    }

    const dbEmail = String(user.email || "").trim().toLowerCase();
    const dbMobile = String(user.mobile || "").trim();

    if (cleanContact !== dbEmail && cleanContact !== dbMobile) {
      return res.status(400).json({
        success: false,
        message: "Verification failed. Email or mobile does not match registered details."
      });
    }

    user.password = hashPassword(cleanPassword);
    await user.save();

    return res.json({
      success: true,
      message: "Password reset successfully! Please login with your new password."
    });
  } catch (error) {
    console.error("FORGOT PASSWORD ERROR:", error);
    return res.status(500).json({ success: false, message: "Server error resetting password" });
  }
});

// TREE
app.get("/api/tree/:id", anyAuthGuard, async (req, res) => {
  try {
    const userId = String(req.params.id || "").trim().toUpperCase();
    const depth = normalizeLimit(req.query.depth || 5);

    const tree = await buildTree(userId, depth);

    if (!tree) {
      return res.status(404).json({
        success: false,
        message: "User tree not found",
      });
    }

    return res.json({
      success: true,
      tree,
    });
  } catch (error) {
    console.error("TREE ERROR:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// COMPANY PROFIT
app.get("/company-profit", adminAuthGuard, async (req, res) => {
  try {
    const users = await User.find().lean();

    let totalJoining = 0;
    let totalPayout = 0;
    let totalWithdrawn = 0;
    let totalWalletBalance = 0;
    let totalPendingWithdraw = 0;
    let totalAdminDeduction = 0;
    let totalTdsDeduction = 0;
    let totalRepurchaseDeduction = 0;

    for (const user of users) {
      // Joining is counted for active users
      const activeAmt = user.lastEpinAmount || (user.isActive ? 500 : 0);
      totalJoining += activeAmt;

      totalPayout += safeNumber(user.directIncome) + safeNumber(user.pairIncome) + safeNumber(user.overrideIncome);
      totalWithdrawn += safeNumber(user.totalWithdrawn);
      totalWalletBalance += safeNumber(user.walletBalance);
      totalPendingWithdraw += getPendingWithdrawAmount(user);
      totalAdminDeduction += safeNumber(user.adminDeduction);
      totalTdsDeduction += safeNumber(user.tdsDeduction);
      totalRepurchaseDeduction += safeNumber(user.repurchaseDeduction);
    }

    return res.json({
      success: true,
      totalUsers: users.length,
      totalJoining,
      totalPayout,
      profit: totalJoining - totalPayout,
      totalWithdrawn,
      totalWalletBalance,
      totalPendingWithdraw,
      totalAdminDeduction,
      totalTdsDeduction,
      totalRepurchaseDeduction,
    });
  } catch (error) {
    console.error("COMPANY PROFIT ERROR:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// ADMIN LOGIN
app.post("/api/admin/login", async (req, res) => {
  try {
    const { username, password } = req.body;

    if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
      res.setHeader("Set-Cookie", `adminAuth=${ADMIN_PASSWORD}; Path=/; SameSite=Strict; Max-Age=86400`);
      return res.json({
        success: true,
        message: "Admin login successful",
        admin: {
          username: ADMIN_USERNAME,
          role: "super_admin",
        },
      });
    }

    return res.status(401).json({
      success: false,
      message: "Invalid admin credentials",
    });
  } catch (error) {
    console.error("ADMIN LOGIN ERROR:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// ADMIN STATS
app.get("/api/admin/stats", adminAuthGuard, async (req, res) => {
  try {
    const users = await User.find().sort({ createdAt: -1 }).lean();

    const totalUsers = users.length;
    const activeUsers = users.filter((u) => u.isActive).length;
    const inactiveUsers = totalUsers - activeUsers;

    let totalIncome = 0;
    let directIncome = 0;
    let pairIncome = 0;
    let overrideIncome = 0;
    let totalAdminDeduction = 0;
    let totalTdsDeduction = 0;
    let totalRepurchaseDeduction = 0;
    let totalCarryLeft = 0;
    let totalCarryRight = 0;
    let totalWalletBalance = 0;
    let totalWithdrawn = 0; // approved payout
    let totalPendingWithdraw = 0;
    let totalRejectedWithdraw = 0;
    let totalApprovedWithdrawRequests = 0;
    let totalRejectedWithdrawRequests = 0;
    let totalPendingWithdrawRequests = 0;
    let totalJoining = 0;

    for (const user of users) {
      const activeAmt = user.lastEpinAmount || (user.isActive ? 500 : 0);
      totalJoining += activeAmt;

      totalIncome += safeNumber(user.totalIncome);
      directIncome += safeNumber(user.directIncome);
      pairIncome += safeNumber(user.pairIncome);
      overrideIncome += safeNumber(user.overrideIncome);
      totalAdminDeduction += safeNumber(user.adminDeduction);
      totalTdsDeduction += safeNumber(user.tdsDeduction);
      totalRepurchaseDeduction += safeNumber(user.repurchaseDeduction);

      totalCarryLeft += safeNumber(user.carryLeft);
      totalCarryRight += safeNumber(user.carryRight);
      totalWalletBalance += safeNumber(user.walletBalance);
      totalWithdrawn += safeNumber(user.totalWithdrawn);
      totalPendingWithdraw += getPendingWithdrawAmount(user);

      if (Array.isArray(user.withdrawRequests)) {
        for (const request of user.withdrawRequests) {
          if (request.status === "pending") totalPendingWithdrawRequests += 1;
          if (request.status === "approved") totalApprovedWithdrawRequests += 1;
          if (request.status === "rejected") {
            totalRejectedWithdrawRequests += 1;
            totalRejectedWithdraw += safeNumber(request.amount);
          }
        }
      }
    }

    const totalPayout = directIncome + pairIncome + overrideIncome;
    const companyProfit = totalJoining - totalPayout;

    const recentUsers = users.slice(0, 5).map((user) => ({
      userId: user.userId,
      fullName: user.fullName || "No Name",
      sponsorId: user.sponsorId || "--",
      isActive: !!user.isActive,
      createdAt: user.createdAt,
    }));

    return res.json({
      success: true,
      stats: {
        totalUsers,
        activeUsers,
        inactiveUsers,
        totalIncome,
        directIncome,
        pairIncome,
        overrideIncome,
        totalAdminDeduction,
        totalTdsDeduction,
        totalRepurchaseDeduction,
        totalJoining,
        totalPayout,
        companyProfit,
        totalCarryLeft,
        totalCarryRight,
        totalWalletBalance,
        totalWithdrawn,
        totalPendingWithdraw,
        totalRejectedWithdraw,
        totalPendingWithdrawRequests,
        totalApprovedWithdrawRequests,
        totalRejectedWithdrawRequests,
        recentUsers,
      },
    });
  } catch (error) {
    console.error("ADMIN STATS ERROR:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// ADMIN USERS LIST
app.get("/api/admin/users", adminAuthGuard, async (req, res) => {
  try {
    const search = String(req.query.search || "").trim();
    const status = String(req.query.status || "all").trim().toLowerCase();
    const page = normalizePage(req.query.page || 1);
    const limit = normalizeLimit(req.query.limit || 10);

    const query = {};

    if (search) {
      query.$or = [
        { userId: { $regex: search, $options: "i" } },
        { fullName: { $regex: search, $options: "i" } },
        { sponsorId: { $regex: search, $options: "i" } },
        { email: { $regex: search, $options: "i" } },
        { mobile: { $regex: search, $options: "i" } },
      ];
    }

    if (status === "active") {
      query.isActive = true;
    } else if (status === "inactive") {
      query.isActive = false;
    }

    const total = await User.countDocuments(query);

    const users = await User.find(query)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();

    const mappedUsers = users.map((user) => ({
      userId: user.userId,
      fullName: user.fullName || "No Name",
      email: user.email || "",
      mobile: user.mobile || "",
      sponsorId: user.sponsorId || "--",
      parentId: user.parentId || "--",
      position: user.position || "--",
      isActive: !!user.isActive,
      status: user.status || (user.isActive ? "active" : "inactive"),
      leftCount: safeNumber(user.leftCount),
      rightCount: safeNumber(user.rightCount),
      directIncome: safeNumber(user.directIncome),
      pairIncome: safeNumber(user.pairIncome),
      overrideIncome: safeNumber(user.overrideIncome),
      adminDeduction: safeNumber(user.adminDeduction),
      tdsDeduction: safeNumber(user.tdsDeduction),
      repurchaseDeduction: safeNumber(user.repurchaseDeduction),
      totalIncome: safeNumber(user.totalIncome),
      carryLeft: safeNumber(user.carryLeft),
      carryRight: safeNumber(user.carryRight),
      walletBalance: safeNumber(user.walletBalance),
      totalWithdrawn: safeNumber(user.totalWithdrawn),
      pendingWithdrawAmount: getPendingWithdrawAmount(user),
      availableWithdrawBalance: getAvailableWithdrawBalance(user),
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
      businessStatus: buildAdminBusinessStatus(user),
    }));

    return res.json({
      success: true,
      users: mappedUsers,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit) || 1,
      },
    });
  } catch (error) {
    console.error("ADMIN USERS ERROR:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

app.get("/api/admin/user/:id", adminAuthGuard, async (req, res) => {
  try {
    const userId = String(req.params.id || "").trim().toUpperCase();
    const user = await User.findOne({ userId }).lean();

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    if (user && user.password) {
      delete user.password;
    }
    const sponsorName = await getSponsorName(user.sponsorId);

    const leftUser = user.left
      ? await User.findOne({ userId: user.left }).lean()
      : null;

    const rightUser = user.right
      ? await User.findOne({ userId: user.right }).lean()
      : null;

    return res.json({
      success: true,
      user: {
        ...user,
        sponsorName: sponsorName || "",
        leftUserId: leftUser?.userId || "--",
        rightUserId: rightUser?.userId || "--",
        joiningAmount: 500,
        dailyCap: 1000,
        breakage: 0,
        referralCount: safeNumber(user.leftCount) + safeNumber(user.rightCount),
        businessStatus: buildAdminBusinessStatus(user),
        walletBalance: safeNumber(user.walletBalance),
        totalWithdrawn: safeNumber(user.totalWithdrawn),
        pendingWithdrawAmount: getPendingWithdrawAmount(user),
        availableWithdrawBalance: getAvailableWithdrawBalance(user),
      },
    });
  } catch (error) {
    console.error("ADMIN USER DETAIL ERROR:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// ADMIN USER ACTIVATE / DEACTIVATE
app.patch("/api/admin/user/:id/status", adminAuthGuard, async (req, res) => {
  try {
    const userId = String(req.params.id || "").trim().toUpperCase();
    const { isActive } = req.body;

    if (typeof isActive !== "boolean") {
      return res.status(400).json({
        success: false,
        message: "isActive must be boolean",
      });
    }

    const user = await User.findOne({ userId });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    if (isActive) {
      const result = await processUserActivation(userId, 500);
      if (result && !result.success) {
        return res.status(400).json(result);
      }
    } else {
      user.isActive = false;
      await user.save();
    }

    const updatedUser = await User.findOne({ userId }).lean();

    return res.json({
      success: true,
      message: `User ${isActive ? "activated" : "deactivated"} successfully`,
      user: {
        userId: updatedUser.userId,
        fullName: updatedUser.fullName || "No Name",
        isActive: updatedUser.isActive,
        status: updatedUser.status,
      },
    });
  } catch (error) {
    console.error("ADMIN STATUS UPDATE ERROR:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// ADMIN RECALCULATE MLM
app.post("/api/admin/recalculate-mlm", adminAuthGuard, async (req, res) => {
  try {
    const result = await recalculateAllMLM();
    return res.json({
      success: true,
      message: "MLM recalculation successfully completed",
      result,
    });
  } catch (error) {
    console.error("ADMIN RECALCULATE ERROR:", error);
    return res.status(500).json({ success: false, message: "Server error", error: error.message });
  }
});

// ADMIN RECENT JOINS
app.get("/api/admin/recent-joins", adminAuthGuard, async (req, res) => {
  try {
    const limit = normalizeLimit(req.query.limit || 8);

    const users = await User.find()
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    return res.json({
      success: true,
      recentUsers: users.map((user) => ({
        userId: user.userId,
        fullName: user.fullName || "No Name",
        sponsorId: user.sponsorId || "--",
        position: user.position || "--",
        isActive: !!user.isActive,
        createdAt: user.createdAt,
      })),
    });
  } catch (error) {
    console.error("RECENT JOINS ERROR:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// ================================
// USER PAYOUT DETAILS
// ================================

// GET USER PAYOUT DETAILS
app.get("/api/user/:id/payout-details", userAuthGuard, async (req, res) => {
  try {
    const userId = normalizeUserId(req.params.id);

    const user = await User.findOne({ userId }).lean();

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    return res.json({
      success: true,
      payoutDetails: {
        accountHolderName: user.accountHolderName || "",
        bankName: user.bankName || "",
        accountNumber: user.accountNumber || "",
        ifscCode: user.ifscCode || "",
        upiId: user.upiId || "",
      },
    });
  } catch (error) {
    console.error("GET PAYOUT DETAILS ERROR:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// UPDATE USER PAYOUT DETAILS
app.put("/api/user/:id/payout-details", userAuthGuard, async (req, res) => {
  try {
    const userId = normalizeUserId(req.params.id);
    const { accountHolderName, bankName, accountNumber, ifscCode, upiId } = req.body;

    const user = await User.findOne({ userId });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    user.accountHolderName = normalizeText(accountHolderName);
    user.bankName = normalizeText(bankName);
    user.accountNumber = normalizeText(accountNumber);
    user.ifscCode = normalizeText(ifscCode).toUpperCase();
    user.upiId = normalizeText(upiId).toLowerCase();

    await user.save();

    return res.json({
      success: true,
      message: "Payout details updated successfully",
      payoutDetails: {
        accountHolderName: user.accountHolderName || "",
        bankName: user.bankName || "",
        accountNumber: user.accountNumber || "",
        ifscCode: user.ifscCode || "",
        upiId: user.upiId || "",
      },
    });
  } catch (error) {
    console.error("UPDATE PAYOUT DETAILS ERROR:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// ================================
// USER WITHDRAW SYSTEM
// ================================

// CREATE WITHDRAW REQUEST
app.post("/api/withdraw/request", userAuthGuard, async (req, res) => {
  try {
    const userId = normalizeUserId(req.body.userId);
    const amount = safeNumber(req.body.amount);
    const paymentMethod = normalizeText(req.body.paymentMethod).toUpperCase();
    const note = normalizeText(req.body.note);

    const user = await User.findOne({ userId });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    if (amount <= 0) {
      return res.status(400).json({
        success: false,
        message: "Valid withdraw amount is required",
      });
    }

    if (amount < 100) {
      return res.status(400).json({
        success: false,
        message: "Minimum withdraw amount is 100",
      });
    }

    const allowedMethods = ["BANK", "UPI"];

    if (!allowedMethods.includes(paymentMethod)) {
      return res.status(400).json({
        success: false,
        message: "Payment method must be BANK or UPI",
      });
    }

    if (paymentMethod === "BANK") {
      if (
        !normalizeText(user.accountHolderName) ||
        !normalizeText(user.bankName) ||
        !normalizeText(user.accountNumber) ||
        !normalizeText(user.ifscCode)
      ) {
        return res.status(400).json({
          success: false,
          message: "Bank details (Holder Name, Bank, Account, IFSC) are required before BANK withdraw request",
        });
      }
    }

    if (paymentMethod === "UPI") {
      if (!normalizeText(user.upiId)) {
        return res.status(400).json({
          success: false,
          message: "UPI ID is required before UPI withdraw request",
        });
      }
    }

// 🔥 Available balance check
const availableBalance = getAvailableWithdrawBalance(user);
if (amount > availableBalance) {
  return res.status(400).json({
    success: false,
    message: "Withdraw amount exceeds available balance",
  });
}

// 🔥 Create withdraw request
const withdrawRequest = {
  amount,
  status: "pending",
  requestDate: new Date(),
  paymentMethod,
  accountHolderName: user.accountHolderName || user.fullName || "",
  bankName: user.bankName || "",
  accountNumber: user.accountNumber || "",
  ifscCode: user.ifscCode || "",
  upiId: user.upiId || "",
  note,
};

// 🔥 Push request
if (!Array.isArray(user.withdrawRequests)) {
  user.withdrawRequests = [];
}

user.withdrawRequests.push(withdrawRequest);

// 🔥 Save
await user.save();

return res.json({
  success: true,
  message: "Withdraw request submitted successfully",
  request: formatWithdrawRequest(withdrawRequest),
});
} catch (error) {
  console.error("WITHDRAW REQUEST ERROR:", error);
  return res.status(500).json({
    success: false,
    message: "Server error",
  });
}
});

// ================================
// USER WITHDRAW HISTORY
// ================================

app.get("/api/user/:id/withdraw-history", userAuthGuard, async (req, res) => {
  try {
    const userId = normalizeUserId(req.params.id);

    const user = await User.findOne({ userId }).lean();

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    const requests = (user.withdrawRequests || []).map((req) =>
      formatWithdrawRequest(req)
    );

    return res.json({
      success: true,
      requests,
    });
  } catch (error) {
    console.error("WITHDRAW HISTORY ERROR:", error);
    return res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
});

// ================================
// ADMIN WITHDRAW REQUEST LIST
// ================================

app.get("/api/admin/withdraw-requests", adminAuthGuard, async (req, res) => {
  try {
    const users = await User.find().lean();

    let requests = [];

    users.forEach((user) => {
      (user.withdrawRequests || []).forEach((req, index) => {
        requests.push(
          formatWithdrawRequest(req, {
            userId: user.userId,
            fullName: user.fullName,
            index,
          })
        );
      });
    });

    return res.json({
      success: true,
      requests,
    });
  } catch (error) {
    console.error("ADMIN WITHDRAW LIST ERROR:", error);
    return res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
});

// ================================
// ADMIN APPROVE / REJECT
// ================================

app.patch("/api/admin/withdraw-action", adminAuthGuard, async (req, res) => {
  try {
    const userId = normalizeUserId(req.body.userId);
    const index = parseInt(req.body.index);
    const action = normalizeText(req.body.action).toLowerCase();
    const adminRemark = normalizeText(req.body.adminRemark);

    const user = await User.findOne({ userId });

    if (!user || !user.withdrawRequests[index]) {
      return res.status(404).json({
        success: false,
        message: "Withdraw request not found",
      });
    }

    const request = user.withdrawRequests[index];

    if (request.status !== "pending") {
      return res.status(400).json({
        success: false,
        message: "Request already processed",
      });
    }

    if (action === "approve") {
      request.status = "approved";
      request.processedDate = new Date();
      request.adminRemark = adminRemark;

      user.walletBalance -= safeNumber(request.amount);
      user.totalWithdrawn += safeNumber(request.amount);

      if (!Array.isArray(user.incomeLogs)) {
        user.incomeLogs = [];
      }

      user.incomeLogs.push(
        buildIncomeLog(
          "admin",
          -request.amount,
          `Withdraw approved: ₹${request.amount}`
        )
      );
    } else if (action === "reject") {
      request.status = "rejected";
      request.processedDate = new Date();
      request.adminRemark = adminRemark;
    } else {
      return res.status(400).json({
        success: false,
        message: "Invalid action",
      });
    }

    await user.save();

    return res.json({
      success: true,
      message: `Withdraw request ${action}ed successfully`,
    });
  } catch (error) {
    console.error("ADMIN WITHDRAW ACTION ERROR:", error);
    return res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
});

// ================================
// INCOME LEDGER & TRANSACTION HISTORY
// ================================

function buildLedgerEntries(user) {
  let entries = [];

  // 1. Process incomeLogs
  if (Array.isArray(user.incomeLogs)) {
    user.incomeLogs.forEach((log) => {
      const dateVal = log.date || new Date();
      const fromUserVal = log.source || "system";
      
      if (log.type === "direct") {
        entries.push({
          date: dateVal,
          type: "Direct Income",
          amount: safeNumber(log.amount),
          creditDebit: "credit",
          fromUser: fromUserVal,
          remark: log.description || "Direct sponsor income"
        });
      } else if (log.type === "pair") {
        const net = safeNumber(log.amount);
        const gross = net / 0.85;
        const adminFee = gross * 0.08;
        const tds = gross * 0.02;
        const repurchase = gross * 0.05;

        // Credit gross binary income
        entries.push({
          date: dateVal,
          type: "Binary Income",
          amount: gross,
          creditDebit: "credit",
          fromUser: fromUserVal,
          remark: log.description || "Binary pair matching income"
        });

        // Debit deductions
        entries.push({
          date: dateVal,
          type: "Admin Fee Deduction",
          amount: adminFee,
          creditDebit: "debit",
          fromUser: "system",
          remark: "8% admin fee deduction on Binary Match"
        });
        entries.push({
          date: dateVal,
          type: "TDS Deduction",
          amount: tds,
          creditDebit: "debit",
          fromUser: "system",
          remark: "2% TDS deduction on Binary Match"
        });
        entries.push({
          date: dateVal,
          type: "Repurchase Deduction",
          amount: repurchase,
          creditDebit: "debit",
          fromUser: "system",
          remark: "5% repurchase deduction on Binary Match"
        });
      } else if (log.type === "bonus") {
        const net = safeNumber(log.amount);
        const gross = net / 0.85;
        const adminFee = gross * 0.08;
        const tds = gross * 0.02;
        const repurchase = gross * 0.05;

        // Credit gross override income
        entries.push({
          date: dateVal,
          type: "Override Income",
          amount: gross,
          creditDebit: "credit",
          fromUser: fromUserVal,
          remark: log.description || "Direct sponsor binary override bonus"
        });

        // Debit deductions
        entries.push({
          date: dateVal,
          type: "Admin Fee Deduction",
          amount: adminFee,
          creditDebit: "debit",
          fromUser: "system",
          remark: "8% admin fee deduction on Override Income"
        });
        entries.push({
          date: dateVal,
          type: "TDS Deduction",
          amount: tds,
          creditDebit: "debit",
          fromUser: "system",
          remark: "2% TDS deduction on Override Income"
        });
        entries.push({
          date: dateVal,
          type: "Repurchase Deduction",
          amount: repurchase,
          creditDebit: "debit",
          fromUser: "system",
          remark: "5% repurchase deduction on Override Income"
        });
      } else if (log.type === "admin") {
        // This is approved payout debit (represented in incomeLogs as negative amount)
        entries.push({
          date: dateVal,
          type: "Payout Debit",
          amount: Math.abs(safeNumber(log.amount)),
          creditDebit: "debit",
          fromUser: "system",
          remark: log.description || "Withdraw request approved and paid"
        });
      } else if (log.type === "epin") {
        entries.push({
          date: dateVal,
          type: "EPIN Transaction",
          amount: Math.abs(safeNumber(log.amount)),
          creditDebit: safeNumber(log.amount) < 0 ? "debit" : "credit",
          fromUser: fromUserVal,
          remark: log.description || "EPIN transaction log"
        });
      }
    });
  }

  // 2. Process withdrawRequests (pending / rejected)
  if (Array.isArray(user.withdrawRequests)) {
    user.withdrawRequests.forEach((req) => {
      const dateVal = req.processedDate || req.requestDate || new Date();
      const methodText = req.paymentMethod || "BANK";
      
      if (req.status === "rejected") {
        entries.push({
          date: dateVal,
          type: "Payout Rejected",
          amount: safeNumber(req.amount),
          creditDebit: "info",
          fromUser: "admin",
          remark: `Withdraw request of ₹${req.amount} via ${methodText} was rejected. Remark: ${req.adminRemark || "None"}`
        });
      } else if (req.status === "pending") {
        entries.push({
          date: req.requestDate || new Date(),
          type: "Payout Pending",
          amount: safeNumber(req.amount),
          creditDebit: "info",
          fromUser: "system",
          remark: `Pending withdraw request of ₹${req.amount} via ${methodText}`
        });
      }
    });
  }

  return entries;
}

// GET USER LEDGER
app.get("/api/user/:id/ledger", userAuthGuard, async (req, res) => {
  try {
    const userId = normalizeUserId(req.params.id);
    const filter = normalizeText(req.query.filter, "all").toLowerCase();

    const user = await User.findOne({ userId });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found"
      });
    }

    let entries = buildLedgerEntries(user);

    // Apply filter
    if (filter === "credit") {
      entries = entries.filter((e) => e.creditDebit === "credit");
    } else if (filter === "debit") {
      entries = entries.filter((e) => e.creditDebit === "debit");
    } else if (filter === "direct") {
      entries = entries.filter((e) => e.type === "Direct Income");
    } else if (filter === "binary") {
      entries = entries.filter((e) => e.type === "Binary Income" || e.type === "Override Income");
    } else if (filter === "payout") {
      entries = entries.filter((e) => e.type.startsWith("Payout"));
    } else if (filter === "deduction") {
      entries = entries.filter((e) => e.type.endsWith("Deduction"));
    }

    // Sort by date descending
    entries.sort((a, b) => new Date(b.date) - new Date(a.date));

    // Calculate totals for stats
    const allEntries = buildLedgerEntries(user);
    let calculatedBalance = 0;
    let totalGrossEarned = 0;
    let totalPayoutDebited = 0;
    let totalDeductionsDebited = 0;

    allEntries.forEach((e) => {
      if (e.creditDebit === "credit") {
        calculatedBalance += e.amount;
        if (e.type.includes("Income")) {
          totalGrossEarned += e.amount;
        }
      } else if (e.creditDebit === "debit") {
        calculatedBalance -= e.amount;
        if (e.type === "Payout Debit") {
          totalPayoutDebited += e.amount;
        } else if (e.type.includes("Deduction")) {
          totalDeductionsDebited += e.amount;
        }
      }
    });

    // Precision check: round to 4 decimal places to prevent float issues
    calculatedBalance = Math.round(calculatedBalance * 10000) / 10000;
    const walletBalance = Math.round(safeNumber(user.walletBalance) * 10000) / 10000;

    return res.json({
      success: true,
      walletBalance: user.walletBalance,
      calculatedBalance,
      ledgerMatchesWallet: calculatedBalance === walletBalance,
      stats: {
        totalGrossEarned: Math.round(totalGrossEarned * 100) / 100,
        totalPayoutDebited: Math.round(totalPayoutDebited * 100) / 100,
        totalDeductionsDebited: Math.round(totalDeductionsDebited * 100) / 100,
        walletBalance: user.walletBalance
      },
      entries
    });
  } catch (error) {
    console.error("GET USER LEDGER ERROR:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// GET ADMIN MASTER LEDGER
app.get("/api/admin/ledger", adminAuthGuard, async (req, res) => {
  try {
    const filter = normalizeText(req.query.filter, "all").toLowerCase();
    const search = normalizeText(req.query.search).toUpperCase();
    const page = normalizePage(req.query.page || 1);
    const limit = normalizeLimit(req.query.limit || 15);

    let userQuery = {};
    if (search) {
      userQuery.$or = [
        { userId: { $regex: search, $options: "i" } },
        { fullName: { $regex: search, $options: "i" } }
      ];
    }

    const users = await User.find(userQuery).lean();
    let allEntries = [];

    users.forEach((user) => {
      const userEntries = buildLedgerEntries(user).map((entry) => ({
        ...entry,
        userId: user.userId,
        fullName: user.fullName || "No Name"
      }));
      allEntries.push(...userEntries);
    });

    // Apply type filter
    if (filter === "credit") {
      allEntries = allEntries.filter((e) => e.creditDebit === "credit");
    } else if (filter === "debit") {
      allEntries = allEntries.filter((e) => e.creditDebit === "debit");
    } else if (filter === "direct") {
      allEntries = allEntries.filter((e) => e.type === "Direct Income");
    } else if (filter === "binary") {
      allEntries = allEntries.filter((e) => e.type === "Binary Income" || e.type === "Override Income");
    } else if (filter === "payout") {
      allEntries = allEntries.filter((e) => e.type.startsWith("Payout"));
    } else if (filter === "deduction") {
      allEntries = allEntries.filter((e) => e.type.endsWith("Deduction"));
    }

    // Sort by date descending
    allEntries.sort((a, b) => new Date(b.date) - new Date(a.date));

    const total = allEntries.length;
    const paginatedEntries = allEntries.slice((page - 1) * limit, page * limit);

    return res.json({
      success: true,
      entries: paginatedEntries,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit) || 1
      }
    });
  } catch (error) {
    console.error("GET ADMIN LEDGER ERROR:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// ================================
// MANUAL PAYMENT SYSTEM (NEW)
// ================================

// GET USER PAYMENT REQUEST STATUS
app.get("/api/payment/status/:id", userAuthGuard, async (req, res) => {
  try {
    const userId = normalizeUserId(req.params.id);
    const request = await PaymentRequest.findOne({ userId }).sort({ createdAt: -1 }).lean();
    return res.json({
      success: true,
      request
    });
  } catch (error) {
    console.error("GET PAYMENT STATUS ERROR:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// SUBMIT USER PAYMENT REQUEST
app.post("/api/payment/request", userAuthGuard, async (req, res) => {
  try {
    const { userId, amount, utr, screenshot, packageSelected } = req.body;
    const cleanUserId = normalizeUserId(userId);
    const cleanUtr = String(utr || "").trim().toUpperCase();

    if (!cleanUserId || !amount || !cleanUtr || !packageSelected) {
      return res.status(400).json({
        success: false,
        message: "User ID, Amount, UTR Number, and Package Selection are required",
      });
    }

    if (Number(amount) !== Number(packageSelected)) {
      return res.status(400).json({
        success: false,
        message: "Payment amount must match the selected package amount",
      });
    }

    if (Number(packageSelected) !== 500 && Number(packageSelected) !== 600) {
      return res.status(400).json({
        success: false,
        message: "Invalid package. Must be 500 or 600",
      });
    }

    // Check if UTR already exists in DB
    const existingUtr = await PaymentRequest.findOne({ utr: cleanUtr });
    if (existingUtr) {
      return res.status(400).json({
        success: false,
        message: "UTR number has already been submitted",
      });
    }

    // Check if user is already active
    const user = await User.findOne({ userId: cleanUserId });
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    if (user.isActive) {
      return res.status(400).json({
        success: false,
        message: "User account is already active",
      });
    }

    // Check if there is already a pending request for this user
    const existingPending = await PaymentRequest.findOne({ userId: cleanUserId, status: "pending" });
    if (existingPending) {
      return res.status(400).json({
        success: false,
        message: "You already have a pending payment request. Please wait for approval.",
      });
    }

    const newRequest = new PaymentRequest({
      userId: cleanUserId,
      fullName: user.fullName || "",
      amount: Number(amount),
      utr: cleanUtr,
      screenshot: screenshot || "",
      packageSelected: Number(packageSelected),
      status: "pending",
    });

    await newRequest.save();

    return res.json({
      success: true,
      message: "Payment request submitted successfully",
      request: newRequest
    });
  } catch (error) {
    console.error("SUBMIT PAYMENT REQUEST ERROR:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// GET ADMIN ALL PAYMENT REQUESTS
app.get("/api/admin/payment-requests", adminAuthGuard, async (req, res) => {
  try {
    const requests = await PaymentRequest.find().sort({ createdAt: -1 }).lean();
    return res.json({
      success: true,
      requests
    });
  } catch (error) {
    console.error("GET ADMIN PAYMENT REQUESTS ERROR:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// ADMIN APPROVE / REJECT PAYMENT REQUEST
app.patch("/api/admin/payment-action", adminAuthGuard, async (req, res) => {
  try {
    const { requestId, action, adminRemark } = req.body;
    
    if (!requestId || !action) {
      return res.status(400).json({
        success: false,
        message: "Request ID and Action (approve/reject) are required",
      });
    }

    const request = await PaymentRequest.findById(requestId);
    if (!request) {
      return res.status(404).json({
        success: false,
        message: "Payment request not found",
      });
    }

    if (request.status !== "pending") {
      return res.status(400).json({
        success: false,
        message: "Payment request has already been processed",
      });
    }

    if (action === "approve") {
      request.status = "approved";
      request.adminRemark = adminRemark || "Approved by admin";
      request.processedAt = new Date();
      await request.save();

      // Automatically activate user and trigger MLM system calculations
      const user = await User.findOne({ userId: request.userId });
      if (user) {
        if (!user.isActive) {
          await processUserActivation(request.userId, request.packageSelected);
        }
      }
    } else if (action === "reject") {
      request.status = "rejected";
      request.adminRemark = adminRemark || "Rejected by admin";
      request.processedAt = new Date();
      await request.save();
    } else {
      return res.status(400).json({
        success: false,
        message: "Invalid action. Must be 'approve' or 'reject'",
      });
    }

    return res.json({
      success: true,
      message: `Payment request successfully ${action}ed!`,
      request
    });
  } catch (error) {
    console.error("ADMIN PAYMENT ACTION ERROR:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

app.listen(PORT, () => {
  console.log(`Server running 🚀 on http://localhost:${PORT}`);
});