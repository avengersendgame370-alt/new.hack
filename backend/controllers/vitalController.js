const VitalLog = require('../models/VitalLog');

// Save a vital sign log entry
exports.saveSessionLog = async (req, res) => {
    if (!global.dbConnected) {
        return res.status(503).json({ error: "Database offline. Session log saved locally only." });
    }
    try {
        const { heartRate, respirationRate, spo2, stress, rmssd, sdnn, blinkCount, confidence } = req.body;
        
        if (
            heartRate === undefined || 
            respirationRate === undefined || 
            spo2 === undefined || 
            stress === undefined || 
            rmssd === undefined || 
            sdnn === undefined || 
            blinkCount === undefined || 
            confidence === undefined
        ) {
            return res.status(400).json({ error: "Missing required vital metrics parameters" });
        }

        const log = new VitalLog({
            userId: req.userId,
            heartRate,
            respirationRate,
            spo2,
            stress,
            rmssd,
            sdnn,
            blinkCount,
            confidence
        });

        await log.save();
        return res.status(201).json({ message: "Vitals logged successfully", log });
    } catch (err) {
        console.error("Vitals log save error:", err);
        return res.status(500).json({ error: "Internal server vital logger error" });
    }
};

// Get last 50 entries for historic trends
exports.getHistoricalTrends = async (req, res) => {
    if (!global.dbConnected) {
        return res.status(503).json({ error: "Database offline. Cannot query trends." });
    }
    try {
        const trends = await VitalLog.find({ userId: req.userId })
            .sort({ timestamp: -1 })
            .limit(50);
        return res.json(trends);
    } catch (err) {
        console.error("Historical trends fetch error:", err);
        return res.status(500).json({ error: "Internal server trends query error" });
    }
};

// Get the latest vital signs log
exports.getLatestVitals = async (req, res) => {
    if (!global.dbConnected) {
        return res.status(503).json({ error: "Database offline. Cannot query latest vitals." });
    }
    try {
        const latest = await VitalLog.findOne({ userId: req.userId })
            .sort({ timestamp: -1 });
        if (!latest) {
            return res.status(404).json({ error: "No telemetry records found for this user" });
        }
        return res.json(latest);
    } catch (err) {
        console.error("Latest vitals fetch error:", err);
        return res.status(500).json({ error: "Internal server vital query error" });
    }
};
