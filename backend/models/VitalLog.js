const mongoose = require('mongoose');

const VitalLogSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    timestamp: {
        type: Date,
        default: Date.now
    },
    heartRate: {
        type: Number,
        required: true
    },
    respirationRate: {
        type: Number,
        required: true
    },
    spo2: {
        type: Number,
        required: true
    },
    stress: {
        type: Number,
        required: true
    },
    rmssd: {
        type: Number,
        required: true
    },
    sdnn: {
        type: Number,
        required: true
    },
    blinkCount: {
        type: Number,
        required: true
    },
    confidence: {
        type: Number,
        required: true
    }
});

module.exports = mongoose.model('VitalLog', VitalLogSchema);
