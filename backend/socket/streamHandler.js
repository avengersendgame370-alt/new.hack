const signalProcessor = require('../services/signalProcessor');

// Store buffers in memory keyed by socket ID
const activeSessions = new Map();
const BUFFER_SIZE = 250; // Approx 8.3 seconds of data at 30 FPS

module.exports = (io) => {
    io.on('connection', (socket) => {
        console.log(`[Socket.io] Client connected: ${socket.id}`);

        // Initialize session buffers
        activeSessions.set(socket.id, {
            greenBuffer: [],
            redBuffer: [],
            timestamps: []
        });

        // Handle streaming frame data
        socket.on('stream_frame_data', (data) => {
            const session = activeSessions.get(socket.id);
            if (!session) return;

            const { greenVal, redVal } = data;
            if (greenVal === undefined || redVal === undefined) return;

            // Push to rolling buffers
            session.greenBuffer.push(greenVal);
            session.redBuffer.push(redVal);
            session.timestamps.push(Date.now());

            if (session.greenBuffer.length > BUFFER_SIZE) {
                session.greenBuffer.shift();
                session.redBuffer.shift();
                session.timestamps.shift();
            }

            // Perform DSP analysis when we have a full rolling buffer (e.g., minimum 100 points)
            if (session.greenBuffer.length >= 100) {
                const results = signalProcessor.processSignal(
                    session.greenBuffer,
                    session.redBuffer,
                    30 // 30 Hz standard camera frame rate idealization
                );

                // Calculate secondary metrics on the server (like HRV parameters)
                const hrvData = calculateHRV(session.timestamps);

                socket.emit('vitals_update', {
                    heartRate: results.heartRate,
                    respirationRate: results.respirationRate,
                    spo2: results.spo2,
                    signalQuality: results.signalQuality,
                    filteredWave: results.filteredWave.slice(-100), // send last 100 values to plot
                    rmssd: hrvData.rmssd,
                    sdnn: hrvData.sdnn,
                    stress: hrvData.stress
                });
            }
        });

        // Clean up on client disconnect
        socket.on('disconnect', () => {
            activeSessions.delete(socket.id);
            console.log(`[Socket.io] Client disconnected: ${socket.id}`);
        });
    });
};

// Local helper to approximate HRV parameters in real time based on timestamp intervals
function calculateHRV(timestamps) {
    const N = timestamps.length;
    if (N < 20) {
        return { rmssd: 45, sdnn: 50, stress: 35 }; // Baselines
    }

    // Convert timestamps into intervals (RR intervals)
    const rrIntervals = [];
    for (let i = 1; i < N; i++) {
        const diff = timestamps[i] - timestamps[i - 1];
        // Filter out extreme noise spikes
        if (diff > 400 && diff < 1500) {
            rrIntervals.push(diff);
        }
    }

    const rrCount = rrIntervals.length;
    if (rrCount < 10) {
        return { rmssd: 45, sdnn: 50, stress: 35 };
    }

    // Mean NN
    const sum = rrIntervals.reduce((a, b) => a + b, 0);
    const meanNN = sum / rrCount;

    // SDNN
    const sumSqDiff = rrIntervals.reduce((a, b) => a + Math.pow(b - meanNN, 2), 0);
    const sdnn = Math.round(Math.sqrt(sumSqDiff / rrCount));

    // RMSSD
    let sumSqSuccessiveDiff = 0;
    for (let i = 1; i < rrCount; i++) {
        sumSqSuccessiveDiff += Math.pow(rrIntervals[i] - rrIntervals[i - 1], 2);
    }
    const rmssd = Math.round(Math.sqrt(sumSqSuccessiveDiff / (rrCount - 1)));

    // Stress Index approximation based on SDNN/RMSSD balance
    const balance = sdnn / (rmssd || 1);
    const stress = Math.min(100, Math.max(10, Math.round(balance * 45)));

    return { rmssd, sdnn, stress };
}
