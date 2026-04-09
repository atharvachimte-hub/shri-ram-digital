const mongoose = require("mongoose");

const userSchema = new mongoose.Schema(
  {
    userId: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      uppercase: true,
    },

    fullName: {
      type: String,
      default: "No Name",
      trim: true,
    },

    email: {
      type: String,
      default: "",
      trim: true,
      lowercase: true,
    },

    mobile: {
      type: String,
      default: "",
      trim: true,
    },

    password: {
      type: String,
      required: true,
    },

    profilePic: {
      type: String,
      default: "",
      trim: true,
    },

    sponsorId: {
      type: String,
      default: null,
      trim: true,
      uppercase: true,
    },

    parentId: {
      type: String,
      default: null,
      trim: true,
      uppercase: true,
    },

    position: {
      type: String,
      enum: ["L", "R", null],
      default: null,
    },

    left: {
      type: String,
      default: null,
      trim: true,
      uppercase: true,
    },

    right: {
      type: String,
      default: null,
      trim: true,
      uppercase: true,
    },

    isActive: {
      type: Boolean,
      default: false,
    },

    status: {
      type: String,
      enum: ["inactive", "active"],
      default: "inactive",
    },

    leftCount: {
      type: Number,
      default: 0,
    },

    rightCount: {
      type: Number,
      default: 0,
    },

    totalIncome: {
      type: Number,
      default: 0,
    },

    todayIncome: {
      type: Number,
      default: 0,
    },

    directIncome: {
      type: Number,
      default: 0,
    },

    pairIncome: {
      type: Number,
      default: 0,
    },

    carryLeft: {
      type: Number,
      default: 0,
    },

    carryRight: {
      type: Number,
      default: 0,
    },

    // 🔥 WALLET SYSTEM (UNCHANGED + SAFE)
    walletBalance: {
      type: Number,
      default: 0,
    },

    totalWithdrawn: {
      type: Number,
      default: 0,
    },

    // 🔥 NEW ADD (SAFE TRACKING – IMPORTANT)
    totalEpinUsed: {
      type: Number,
      default: 0,
    },

    lastEpinAmount: {
      type: Number,
      default: 0,
    },

    // 🔥 BANK / UPI DETAILS
    bankName: {
      type: String,
      default: "",
    },

    accountNumber: {
      type: String,
      default: "",
    },

    ifscCode: {
      type: String,
      default: "",
    },

    upiId: {
      type: String,
      default: "",
    },

    // 🔥 WITHDRAW REQUESTS
    withdrawRequests: [
      {
        amount: Number,
        status: {
          type: String,
          enum: ["pending", "approved", "rejected"],
          default: "pending",
        },
        requestDate: {
          type: Date,
          default: Date.now,
        },
        processedDate: Date,
      },
    ],

    // 🔥 INCOME LOGS (ENHANCED)
    incomeLogs: [
      {
        type: {
          type: String,
          enum: ["direct", "pair", "admin", "bonus", "epin"], // 🔥 added epin
        },
        amount: Number,
        description: String,
        source: {
          type: String,
          default: "system", // 🔥 NEW (tracking)
        },
        date: {
          type: Date,
          default: Date.now,
        },
      },
    ],

    // 🔥 NEW: ACCOUNT META (future SaaS features)
    role: {
      type: String,
      enum: ["user", "admin"],
      default: "user",
    },

    isBlocked: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true }
);

// 🔥 AUTO STATUS SYNC (UNCHANGED)
userSchema.pre("save", function (next) {
  this.status = this.isActive ? "active" : "inactive";
  next();
});

module.exports = mongoose.model("User", userSchema);