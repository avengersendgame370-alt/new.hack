const PDFDocument = require('pdfkit');
const VitalLog = require('../models/VitalLog');
const User = require('../models/User');

exports.generatePDFReport = async (req, res) => {
    if (!global.dbConnected) {
        return res.status(503).json({ error: "Database offline. Cannot compile PDF reports." });
    }
    try {
        const user = await User.findById(req.userId);
        if (!user) {
            return res.status(404).json({ error: "User not found" });
        }

        const logs = await VitalLog.find({ userId: req.userId })
            .sort({ timestamp: -1 })
            .limit(20);

        if (logs.length === 0) {
            return res.status(404).json({ error: "No biometric sessions logged. Run a telemetry scan first." });
        }

        const latest = logs[0];

        // Calculate averages
        let avgHR = 0, avgRR = 0, avgSpO2 = 0, avgStress = 0;
        logs.forEach(l => {
            avgHR += l.heartRate;
            avgRR += l.respirationRate;
            avgSpO2 += l.spo2;
            avgStress += l.stress;
        });
        avgHR = (avgHR / logs.length).toFixed(1);
        avgRR = (avgRR / logs.length).toFixed(1);
        avgSpO2 = (avgSpO2 / logs.length).toFixed(1);
        avgStress = (avgStress / logs.length).toFixed(1);

        const doc = new PDFDocument({ margin: 50 });

        // HTTP Headers for PDF download
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename=vitalsense_report_${user.name.replace(/\s+/g, '_')}.pdf`);
        doc.pipe(res);

        // Styling elements
        const primaryColor = '#0055ff';
        const darkColor = '#0f172a';
        const grayColor = '#64748b';

        // Header Title
        doc.fillColor(primaryColor)
           .font('Helvetica-Bold')
           .fontSize(24)
           .text('VITALSENSE AI PLATFORM', 50, 50);

        doc.fillColor(grayColor)
           .font('Helvetica')
           .fontSize(10)
           .text('CONFIDENTIAL CLINICAL ASSESSMENT REPORT', 50, 78);

        doc.strokeColor('#cbd5e1')
           .lineWidth(1)
           .moveTo(50, 95)
           .lineTo(560, 95)
           .stroke();

        // Patient Details Section
        doc.fillColor(darkColor)
           .font('Helvetica-Bold')
           .fontSize(12)
           .text('PATIENT IDENTIFICATION', 50, 115);

        doc.font('Helvetica')
           .fontSize(10)
           .text(`Name: ${user.name}`, 50, 135)
           .text(`Email: ${user.email}`, 50, 150)
           .text(`Date of Report: ${new Date().toLocaleString()}`, 300, 135)
           .text(`Reference: VS-${user._id.toString().substring(18).toUpperCase()}`, 300, 150);

        // Vitals Summary Panel Box
        doc.rect(50, 180, 510, 80)
           .fill('#f8fafc');

        doc.fillColor(darkColor)
           .font('Helvetica-Bold')
           .fontSize(10)
           .text('LATEST BIOMETRIC DATA LOCK', 65, 195);

        doc.font('Helvetica')
           .fontSize(9)
           .fillColor(grayColor)
           .text(`Heart Rate (BPM):`, 65, 220)
           .text(`Respiration (rpm):`, 200, 220)
           .text(`Blood Oxygen (SpO2):`, 330, 220)
           .text(`Stress index:`, 470, 220);

        doc.fillColor(primaryColor)
           .font('Helvetica-Bold')
           .fontSize(16)
           .text(`${latest.heartRate} BPM`, 65, 235)
           .text(`${latest.respirationRate} rpm`, 200, 235)
           .text(`${latest.spo2}%`, 330, 235)
           .text(`${latest.stress.toFixed(0)}`, 470, 235);

        // Vitals Statistics Trends
        doc.fillColor(darkColor)
           .font('Helvetica-Bold')
           .fontSize(12)
           .text('20-POINT METRIC HISTORICAL AVERAGES', 50, 290);

        doc.font('Helvetica')
           .fontSize(10)
           .text(`Average Heart Rate: ${avgHR} BPM`, 50, 315)
           .text(`Average Respiration Rate: ${avgRR} rpm`, 50, 335)
           .text(`Average SpO2 Integrity: ${avgSpO2}%`, 300, 315)
           .text(`Average Cognitive Stress Index: ${avgStress}`, 300, 335);

        // Telemetry Grid Header
        doc.strokeColor('#e2e8f0')
           .lineWidth(1)
           .moveTo(50, 375)
           .lineTo(560, 375)
           .stroke();

        doc.fillColor(darkColor)
           .font('Helvetica-Bold')
           .fontSize(11)
           .text('HISTORICAL DATA LOGS', 50, 395);

        // Draw logs table headers
        let y = 425;
        doc.fillColor(grayColor)
           .font('Helvetica-Bold')
           .fontSize(9)
           .text('TIMESTAMP', 55, y)
           .text('HR (BPM)', 180, y)
           .text('RR (rpm)', 250, y)
           .text('SpO2 (%)', 320, y)
           .text('STRESS', 390, y)
           .text('CONFIDENCE', 470, y);

        doc.strokeColor('#cbd5e1')
           .lineWidth(1)
           .moveTo(50, y + 12)
           .lineTo(560, y + 12)
           .stroke();

        y += 18;

        doc.font('Helvetica')
           .fillColor(darkColor);

        // Limit to last 10 rows for single page print format consistency
        const rowLogs = logs.slice(0, 12);
        rowLogs.forEach((log) => {
            const dateStr = new Date(log.timestamp).toLocaleString();
            doc.text(dateStr, 55, y)
               .text(`${log.heartRate}`, 180, y)
               .text(`${log.respirationRate}`, 250, y)
               .text(`${log.spo2}%`, 320, y)
               .text(`${log.stress.toFixed(0)}`, 390, y)
               .text(`${log.confidence}%`, 470, y);

            doc.strokeColor('#f1f5f9')
               .lineWidth(0.5)
               .moveTo(50, y + 12)
               .lineTo(560, y + 12)
               .stroke();

            y += 18;
        });

        // Sign off footer
        doc.fillColor(grayColor)
           .fontSize(8)
           .text('VitalSense Platform Assessment report. Generated automatically by cloud neural engine.', 50, 720, { align: 'center' });

        doc.end();
    } catch (err) {
        console.error("PDF generation failed:", err);
        return res.status(500).json({ error: "Internal server error during document compile" });
    }
};
