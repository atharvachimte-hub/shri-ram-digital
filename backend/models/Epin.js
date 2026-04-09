const mongoose = require("mongoose");

const epinSchema = new mongoose.Schema(
  {
    code: {
      type: String,
      required: true,
      unique: true,
      index: true,
      uppercase: true,
      trim: true,
    },
    amount: {
      type: Number,
      required: true,
      min: 0,
    },
    status: {
      type: String,
      enum: ["unused", "used"],
      default: "unused",
      index: true,
    },
    createdBy: {
      type: String,
      default: "admin",
      trim: true,
    },
    usedBy: {
      type: String,
      default: "",
      trim: true,
    },
    usedFor: {
      type: String,
      default: "",
      trim: true,
    },
    usedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Epin", epinSchema);