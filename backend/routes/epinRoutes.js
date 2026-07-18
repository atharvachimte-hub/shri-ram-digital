const express = require("express");
const router = express.Router();
const Epin = require("../models/Epin");
const User = require("../models/User");

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin123";

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
      message: "Unauthorized admin access",
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
    const cleanUserId = String(authUserId).trim().toUpperCase();
    try {
      const userExists = await User.findOne({ userId: cleanUserId }).lean();
      if (userExists) {
        return next();
      }
    } catch (e) {
      console.error("anyAuthGuard DB error in epinRoutes:", e);
    }
  }

  return res.status(401).json({
    success: false,
    message: "Unauthorized access",
  });
}

// =========================
// GENERATE UNIQUE SD CODE
// =========================
async function generateUniqueSDCode() {
  let isUnique = false;
  let code = "";

  while (!isUnique) {
    const randomPart = Math.random().toString(36).substring(2, 10).toUpperCase();
    code = `SD${randomPart}`;
    const existing = await Epin.findOne({ code });
    if (!existing) isUnique = true;
  }

  return code;
}

// =========================
// GENERATE EPIN
// =========================
router.post("/generate", adminAuthGuard, async (req, res) => {
  try {
    const { count = 1, amount = 0, createdBy = "admin" } = req.body;

    const finalCount = Number(count);
    const finalAmount = Number(amount);

    if (!finalCount || finalCount < 1 || finalCount > 500) {
      return res.status(400).json({
        success: false,
        message: "Count must be between 1 and 500",
      });
    }

    if (finalAmount !== 500 && finalAmount !== 600) {
      return res.status(400).json({
        success: false,
        message: "EPIN amount must be either 500 or 600",
      });
    }

    const epins = [];

    for (let i = 0; i < finalCount; i++) {
      const code = await generateUniqueSDCode();
      epins.push({
        code,
        amount: finalAmount,
        createdBy,
      });
    }

    const saved = await Epin.insertMany(epins);

    res.json({
      success: true,
      message: `${saved.length} EPIN generated successfully`,
      data: saved,
    });
  } catch (error) {
    console.error("EPIN Generate Error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to generate EPIN",
    });
  }
});

// =========================
// LIST EPIN
// =========================
router.get("/", adminAuthGuard, async (req, res) => {
  try {
    const { status = "", search = "" } = req.query;

    const filter = {};

    if (status && ["unused", "used"].includes(status)) {
      filter.status = status;
    }

    if (search) {
      filter.code = { $regex: search, $options: "i" };
    }

    const epins = await Epin.find(filter).sort({ createdAt: -1 });

    res.json({
      success: true,
      count: epins.length,
      data: epins,
    });
  } catch (error) {
    console.error("EPIN List Error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch EPIN list",
    });
  }
});

// =========================
// STATS
// =========================
router.get("/stats", adminAuthGuard, async (req, res) => {
  try {
    const total = await Epin.countDocuments();
    const unused = await Epin.countDocuments({ status: "unused" });
    const used = await Epin.countDocuments({ status: "used" });

    const totalAmountAgg = await Epin.aggregate([
      {
        $group: {
          _id: null,
          totalAmount: { $sum: "$amount" },
        },
      },
    ]);

    const usedAmountAgg = await Epin.aggregate([
      { $match: { status: "used" } },
      {
        $group: {
          _id: null,
          totalAmount: { $sum: "$amount" },
        },
      },
    ]);

    res.json({
      success: true,
      data: {
        total,
        unused,
        used,
        totalAmount: totalAmountAgg[0]?.totalAmount || 0,
        usedAmount: usedAmountAgg[0]?.totalAmount || 0,
      },
    });
  } catch (error) {
    console.error("EPIN Stats Error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch EPIN stats",
    });
  }
});

// =========================
// USE EPIN (🔥 FINAL STABLE VERSION)
// =========================
router.post("/use", anyAuthGuard, async (req, res) => {
  try {
    console.log("EPIN USE BODY:", req.body);

    const { code, userId = "", usedFor = "account_activation" } = req.body;

    if (!code || !userId) {
      return res.status(400).json({
        success: false,
        message: "EPIN code and userId required",
      });
    }

    const cleanCode = String(code).trim().toUpperCase();
    const cleanUserId = String(userId).trim().toUpperCase();

    // 🔥 FIND EPIN
    const epin = await Epin.findOne({ code: cleanCode });

    if (!epin) {
      return res.status(400).json({
        success: false,
        message: "Invalid EPIN code",
      });
    }

    if (epin.status === "used") {
      return res.status(400).json({
        success: false,
        message: "EPIN already used",
      });
    }

    // 🔥 FIND USER (STRICT FIX)
    const user = await User.findOne({ userId: cleanUserId });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    // =========================
    // 🔥 CORE MONEY LOGIC SAFE
    // =========================
    const amount = Number(epin.amount || 0);

    user.walletBalance = Number(user.walletBalance || 0) + amount;

    if (!Array.isArray(user.incomeLogs)) {
      user.incomeLogs = [];
    }

    user.incomeLogs.push({
      type: "epin",
      amount: amount,
      description: `EPIN recharge ₹${amount}`,
      source: "epin",
      date: new Date(),
    });

    // 🔥 EXTRA TRACKING (NEW SAFE ADD)
    user.totalEpinUsed = Number(user.totalEpinUsed || 0) + 1;
    user.lastEpinAmount = amount;

    // Save user before activation to ensure status starts fresh
    await user.save();

    // Trigger full binary MLM calculations upline
    const { processUserActivation } = require("../utils/mlmCalc");
    await processUserActivation(cleanUserId, amount);

    // =========================
    // UPDATE EPIN
    // =========================
    epin.status = "used";
    epin.usedBy = cleanUserId;
    epin.usedFor = usedFor;
    epin.usedAt = new Date();

    await epin.save();

    return res.json({
      success: true,
      message: "EPIN used successfully 💰",
      walletBalance: user.walletBalance,
    });

  } catch (error) {
    console.error("🔥 EPIN FINAL ERROR:", error);

    return res.status(500).json({
      success: false,
      message: error.message || "Server error",
    });
  }
});

module.exports = router;