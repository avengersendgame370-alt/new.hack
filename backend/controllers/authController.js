const User = require('../models/User');
const jwt = require('jsonwebtoken');

// Register a new user
exports.register = async (req, res) => {
    if (!global.dbConnected) {
        return res.status(503).json({ error: "Database offline. Falling back to local offline demo mode." });
    }
    try {
        const { name, email, password } = req.body;
        if (!name || !email || !password) {
            return res.status(400).json({ error: "Missing required registration parameters" });
        }

        // Check if user exists
        let user = await User.findOne({ email });
        if (user) {
            return res.status(400).json({ error: "User already exists with this email address" });
        }

        user = new User({ name, email, password });
        await user.save();

        // Sign token
        const token = jwt.sign({ userId: user._id }, process.env.JWT_SECRET, { expiresIn: '7d' });
        return res.status(201).json({ token, user: { name: user.name, email: user.email } });
    } catch (err) {
        console.error("Registration error:", err);
        return res.status(500).json({ error: "Internal server registry error" });
    }
};

// Login user
exports.login = async (req, res) => {
    if (!global.dbConnected) {
        return res.status(503).json({ error: "Database offline. Falling back to local offline demo mode." });
    }
    try {
        const { email, password } = req.body;
        if (!email || !password) {
            return res.status(400).json({ error: "Missing email or password" });
        }

        const user = await User.findOne({ email });
        if (!user) {
            return res.status(401).json({ error: "Invalid credentials" });
        }

        const isMatch = await user.comparePassword(password);
        if (!isMatch) {
            return res.status(401).json({ error: "Invalid credentials" });
        }

        // Sign token
        const token = jwt.sign({ userId: user._id }, process.env.JWT_SECRET, { expiresIn: '7d' });
        return res.json({ token, user: { name: user.name, email: user.email } });
    } catch (err) {
        console.error("Login error:", err);
        return res.status(500).json({ error: "Internal login verification error" });
    }
};

// JWT Verification Middleware
exports.verifyToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    let token = authHeader && authHeader.split(' ')[1];
    
    // Fallback to query parameter token (crucial for window.open PDF downloads)
    if (!token && req.query.token) {
        token = req.query.token;
    }

    if (!token) {
        return res.status(401).json({ error: "Authentication token is missing" });
    }

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.userId = decoded.userId;
        next();
    } catch (err) {
        return res.status(403).json({ error: "Authentication token is invalid or expired" });
    }
};
