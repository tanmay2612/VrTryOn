require("dotenv").config({ path: __dirname + "/.env" });

const express = require("express");
const cors = require("cors");
const connectDB = require("./config/db");

const app = express();

app.use(cors());
app.use(express.json());

let db;

// Connect DB
connectDB()
  .then((database) => {
    db = database;
    console.log("✅ MongoDB connected");
  })
  .catch((err) => {
    console.error("❌ DB connection failed:", err);
    process.exit(1);
  });

// Root
app.get("/", (req, res) => {
  res.send("Backend running 🚀");
});

// GET users
app.get("/api/users", async (req, res) => {
  try {
    if (!db) return res.status(500).json({ error: "DB not connected" });

    const users = await db.collection("users").find().toArray();
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST user
app.post("/api/users", async (req, res) => {
  try {
    if (!db) return res.status(500).json({ error: "DB not connected" });

    const { name, image } = req.body;

    if (!name || !image) {
      return res.status(400).json({ error: "Name and image are required" });
    }

    const result = await db.collection("users").insertOne({
      name,
      image,
      createdAt: new Date(),
    });

    res.json({
      message: "User added ✅",
      id: result.insertedId,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Start server
app.listen(5000, () => {
  console.log("🚀 Server running on port 5000");
});