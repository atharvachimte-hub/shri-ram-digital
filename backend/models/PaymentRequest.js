const mongoose = require("mongoose");

const paymentRequestSchema = new mongoose.Schema(
  {
    userId: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
    },
    fullName: {
      type: String,
      default: "",
    },
    amount: {
      type: Number,
      required: true,
    },
    utr: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      uppercase: true,
    },
    screenshot: {
      type: String, // Base64 compressed image data URL
      default: "",
    },
    packageSelected: {
      type: Number,
      enum: [500, 600],
      required: true,
    },
    status: {
      type: String,
      enum: ["pending", "approved", "rejected"],
      default: "pending",
    },
    adminRemark: {
      type: String,
      default: "",
    },
    processedAt: {
      type: Date,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("PaymentRequest", paymentRequestSchema);
