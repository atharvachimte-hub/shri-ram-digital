const express = require("express");
const router = express.Router();
const Epin = require("../models/Epin");
const User = require("../models/User");

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
router.post("/generate", async (req, res) => {
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

    if (finalAmount < 0) {
      return res.status(400).json({
        success: false,
        message: "Amount cannot be negative",
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
router.get("/", async (req, res) => {
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
router.get("/stats", async (req, res) => {
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
router.post("/use", async (req, res) => {
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
    user.isActive = true;

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

    await user.save();

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