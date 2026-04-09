const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const epinRoutes = require("./routes/epinRoutes");
const path = require("path");

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.use("/api/epins", epinRoutes);

const ADMIN_USERNAME = "admin";
const ADMIN_PASSWORD = "admin123";
const PORT = 5000;

mongoose
  .connect(
    "mongodb://atharvachimte_db_user:846AgF2y1bwtS0Kd@ac-l2kdw4z-shard-00-00.cdoydlu.mongodb.net:27017,ac-l2kdw4z-shard-00-01.cdoydlu.mongodb.net:27017,ac-l2kdw4z-shard-00-02.cdoydlu.mongodb.net:27017/myapp?ssl=true&replicaSet=atlas-8n11xu-shard-0&authSource=admin&retryWrites=true&w=majority"
  )
  .then(() => console.log("MongoDB connected 🔥"))
  .catch((error) => console.error("MongoDB error:", error));

const User = require("./models/User");

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
  if (!parentUserId) return;

  const parent = await User.findOne({ userId: parentUserId });
  if (!parent) return;

  const leftUser = parent.left
    ? await User.findOne({ userId: parent.left }).lean()
    : null;

  const rightUser = parent.right
    ? await User.findOne({ userId: parent.right }).lean()
    : null;

  parent.leftCount =
    (leftUser ? 1 : 0) +
    safeNumber(leftUser?.leftCount) +
    safeNumber(leftUser?.rightCount);

  parent.rightCount =
    (rightUser ? 1 : 0) +
    safeNumber(rightUser?.leftCount) +
    safeNumber(rightUser?.rightCount);

  await parent.save();
}

async function updateCountsUpline(startParentId) {
  let currentParentId = startParentId;

  while (currentParentId) {
    await updateSingleParentChildCount(currentParentId);

    const currentParent = await User.findOne({ userId: currentParentId }).lean();
    currentParentId = currentParent?.parentId || null;
  }
}

async function calculateIncomeForUser(userId) {
  const user = await User.findOne({ userId });
  if (!user) return;

  const leftBusiness = safeNumber(user.leftCount) + safeNumber(user.carryLeft);
  const rightBusiness = safeNumber(user.rightCount) + safeNumber(user.carryRight);

  const pairCount = Math.min(leftBusiness, rightBusiness);
  const grossPairIncome = pairCount * 100;
  const remainingCap = Math.max(0, 1000 - safeNumber(user.todayIncome));
  const allowedPairIncome = Math.min(grossPairIncome, remainingCap);

  user.pairIncome = allowedPairIncome;
  user.totalIncome = safeNumber(user.directIncome) + safeNumber(user.pairIncome);
  user.carryLeft = leftBusiness - pairCount;
  user.carryRight = rightBusiness - pairCount;

  await user.save();
}

async function calculateIncomeUpline(startUserId) {
  let currentUserId = startUserId;

  while (currentUserId) {
    await calculateIncomeForUser(currentUserId);

    const currentUser = await User.findOne({ userId: currentUserId }).lean();
    currentUserId = currentUser?.parentId || null;
  }
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

// USER DETAILS
app.get("/api/user/:id", async (req, res) => {
  try {
    const user = await User.findOne({ userId: req.params.id.toUpperCase() }).lean();

    if (!user) {
      return res.json({ success: false, message: "User not found" });
    }

    const sponsorName = await getSponsorName(user.sponsorId);

    return res.json({
      success: true,
      user: {
        ...user,
        sponsorName,
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
app.post("/register", async (req, res) => {
  try {
    const { password, sponsorId, fullName, email, mobile } = req.body;

    if (!password) {
      return res.status(400).json({
        success: false,
        message: "Password is required",
      });
    }

    const userId = await findUniqueUserId();

    let parentId = null;
    let position = null;
    let normalizedSponsorId = sponsorId ? String(sponsorId).trim().toUpperCase() : null;

    if (normalizedSponsorId) {
      const sponsor = await User.findOne({ userId: normalizedSponsorId });

      if (sponsor) {
        if (!sponsor.left) {
          sponsor.left = userId;
          parentId = sponsor.userId;
          position = "L";
        } else if (!sponsor.right) {
          sponsor.right = userId;
          parentId = sponsor.userId;
          position = "R";
        } else {
          return res.status(400).json({
            success: false,
            message: "Sponsor already has both left and right positions filled",
          });
        }

        sponsor.directIncome = safeNumber(sponsor.directIncome) + 25;
        sponsor.walletBalance = safeNumber(sponsor.walletBalance) + 25;
        sponsor.totalIncome = safeNumber(sponsor.directIncome) + safeNumber(sponsor.pairIncome);

        if (!Array.isArray(sponsor.incomeLogs)) {
          sponsor.incomeLogs = [];
        }

        sponsor.incomeLogs.push(
          buildIncomeLog(
            "direct",
            25,
            `Direct income credited for new join under sponsor ${userId}`
          )
        );

        await sponsor.save();
      } else {
        normalizedSponsorId = null;
      }
    }

    const newUser = new User({
      userId,
      password,
      fullName: fullName || "No Name",
      email: email || "",
      mobile: mobile || "",
      profilePic: "",
      sponsorId: normalizedSponsorId,
      parentId,
      position,
    });

    await newUser.save();

    if (parentId) {
      await updateCountsUpline(parentId);
      await calculateIncomeUpline(parentId);
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
app.post("/login", async (req, res) => {
  try {
    const { userId, password } = req.body;

    if (!userId || !password) {
      return res.status(400).json({
        success: false,
        message: "User ID and password are required",
      });
    }

    const user = await User.findOne({
      userId: String(userId).trim().toUpperCase(),
      password: String(password),
    }).lean();

    if (!user) {
      return res.status(401).json({
        success: false,
        message: "Invalid user ID or password",
      });
    }

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

// TREE
app.get("/api/tree/:id", async (req, res) => {
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
app.get("/company-profit", async (req, res) => {
  try {
    const users = await User.find().lean();

    let totalJoining = users.length * 500;
    let totalPayout = 0;
    let totalWithdrawn = 0;
    let totalWalletBalance = 0;
    let totalPendingWithdraw = 0;

    for (const user of users) {
      totalPayout += safeNumber(user.directIncome) + safeNumber(user.pairIncome);
      totalWithdrawn += safeNumber(user.totalWithdrawn);
      totalWalletBalance += safeNumber(user.walletBalance);
      totalPendingWithdraw += getPendingWithdrawAmount(user);
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
app.get("/api/admin/stats", async (req, res) => {
  try {
    const users = await User.find().sort({ createdAt: -1 }).lean();

    const totalUsers = users.length;
    const activeUsers = users.filter((u) => u.isActive).length;
    const inactiveUsers = totalUsers - activeUsers;

    let totalIncome = 0;
    let directIncome = 0;
    let pairIncome = 0;
    let totalCarryLeft = 0;
    let totalCarryRight = 0;
    let totalWalletBalance = 0;
    let totalWithdrawn = 0;
    let totalPendingWithdraw = 0;
    let totalApprovedWithdrawRequests = 0;
    let totalRejectedWithdrawRequests = 0;
    let totalPendingWithdrawRequests = 0;

    for (const user of users) {
      totalIncome += safeNumber(user.totalIncome);
      directIncome += safeNumber(user.directIncome);
      pairIncome += safeNumber(user.pairIncome);
      totalCarryLeft += safeNumber(user.carryLeft);
      totalCarryRight += safeNumber(user.carryRight);
      totalWalletBalance += safeNumber(user.walletBalance);
      totalWithdrawn += safeNumber(user.totalWithdrawn);
      totalPendingWithdraw += getPendingWithdrawAmount(user);

      if (Array.isArray(user.withdrawRequests)) {
        for (const request of user.withdrawRequests) {
          if (request.status === "pending") totalPendingWithdrawRequests += 1;
          if (request.status === "approved") totalApprovedWithdrawRequests += 1;
          if (request.status === "rejected") totalRejectedWithdrawRequests += 1;
        }
      }
    }

    const totalJoining = totalUsers * 500;
    const totalPayout = directIncome + pairIncome;
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
        totalJoining,
        totalPayout,
        companyProfit,
        totalCarryLeft,
        totalCarryRight,
        totalWalletBalance,
        totalWithdrawn,
        totalPendingWithdraw,
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
app.get("/api/admin/users", async (req, res) => {
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

// ADMIN SINGLE USER DETAIL
app.get("/api/admin/user/:id", async (req, res) => {
  try {
    const userId = String(req.params.id || "").trim().toUpperCase();
    const user = await User.findOne({ userId }).lean();

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
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
app.patch("/api/admin/user/:id/status", async (req, res) => {
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

    user.isActive = isActive;
    await user.save();

    return res.json({
      success: true,
      message: `User ${isActive ? "activated" : "deactivated"} successfully`,
      user: {
        userId: user.userId,
        fullName: user.fullName || "No Name",
        isActive: user.isActive,
        status: user.status,
      },
    });
  } catch (error) {
    console.error("ADMIN STATUS UPDATE ERROR:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// ADMIN RECENT JOINS
app.get("/api/admin/recent-joins", async (req, res) => {
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
app.get("/api/user/:id/payout-details", async (req, res) => {
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
app.put("/api/user/:id/payout-details", async (req, res) => {
  try {
    const userId = normalizeUserId(req.params.id);
    const { bankName, accountNumber, ifscCode, upiId } = req.body;

    const user = await User.findOne({ userId });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    user.bankName = normalizeText(bankName);
    user.accountNumber = normalizeText(accountNumber);
    user.ifscCode = normalizeText(ifscCode).toUpperCase();
    user.upiId = normalizeText(upiId).toLowerCase();

    await user.save();

    return res.json({
      success: true,
      message: "Payout details updated successfully",
      payoutDetails: {
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
app.post("/api/withdraw/request", async (req, res) => {
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
        !normalizeText(user.bankName) ||
        !normalizeText(user.accountNumber) ||
        !normalizeText(user.ifscCode)
      ) {
        return res.status(400).json({
          success: false,
          message: "Bank details are required before BANK withdraw request",
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
  accountHolderName: user.fullName || "",
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

app.get("/api/user/:id/withdraw-history", async (req, res) => {
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

app.get("/api/admin/withdraw-requests", async (req, res) => {
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

app.patch("/api/admin/withdraw-action", async (req, res) => {
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
app.listen(PORT, () => {
  console.log(`Server running 🚀 on http://localhost:${PORT}`);
});