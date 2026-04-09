const express = require("express");
const router = express.Router();
const User = require("../models/User");

async function buildTree(userId, depth = 5) {
  if (!userId || depth <= 0) return null;

  const user = await User.findOne({ userId }).lean();
  if (!user) return null;

  const node = {
    _id: user._id,
    userId: user.userId,
    fullName: user.fullName || "",
    isActive: user.isActive,
    status: user.isActive ? "active" : "inactive",
    sponsorId: user.sponsorId || null,
    parentId: user.parentId || null,
    position: user.position || null,
    left: null,
    right: null,
  };

  if (user.left && depth > 1) {
    node.left = await buildTree(user.left, depth - 1);
  }

  if (user.right && depth > 1) {
    node.right = await buildTree(user.right, depth - 1);
  }

  return node;
}

// root user tree by userId
router.get("/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    const depth = parseInt(req.query.depth || "5", 10);

    const safeDepth = Math.max(1, Math.min(depth, 10));
    const tree = await buildTree(userId.toUpperCase(), safeDepth);

    if (!tree) {
      return res.status(404).json({
        success: false,
        message: "Tree root user not found",
      });
    }

    res.json({
      success: true,
      depth: safeDepth,
      tree,
    });
  } catch (error) {
    console.error("Tree fetch error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch tree",
      error: error.message,
    });
  }
});

// optional: dashboard helper
router.get("/single/:userId", async (req, res) => {
  try {
    const user = await User.findOne({ userId: req.params.userId.toUpperCase() }).lean();

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    res.json({
      success: true,
      user: {
        userId: user.userId,
        fullName: user.fullName || "",
        isActive: user.isActive,
        status: user.isActive ? "active" : "inactive",
        sponsorId: user.sponsorId,
        parentId: user.parentId,
        position: user.position,
        left: user.left,
        right: user.right,
      },
    });
  } catch (error) {
    console.error("Single user fetch error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch user",
      error: error.message,
    });
  }
});

module.exports = router;