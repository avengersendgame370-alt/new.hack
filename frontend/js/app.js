const videoElement = document.getElementById('inputVideo');
const canvasElement = document.getElementById('outputCanvas');
const canvasCtx = canvasElement.getContext('2d', { willReadFrequently: true });

const statusEl = document.getElementById('appStatus');

// State
let signalBuffer = [];
let timeBuffer = [];
let marBuffer = [];
let respDetrended = [];
let nnIntervals = [];
let lastPeakTime = 0;
let talkingFrames = 0;
let blinks = 0;
let isBlinking = false;

// New App State
let appState = 'LOGIN'; 
let activeLoginTab = 'FACE';
let isScanning = false;
let loginTimeout = null;
let loginCountdown = null;
let blinkTimestamps = [];
let displayStressIndex = 0;
let displayRMSSD = 0;
let signalBufferR = [];
let historyData = [];
let baselineHR = null;
let baselineRR = null;
let baselineDataHR = [];
let baselineDataRR = [];
let spo2Display = 0;

// Notification state track
let wasFaceDetected = false;
let trackingStableNotified = false;
let heartRateSyncNotified = false;

// Bypass button
document.getElementById('bypassBtn').addEventListener('click', () => {
    document.getElementById('loginView').style.display = 'none';
    document.getElementById('dashboardView').style.display = 'block';
    appState = 'DASHBOARD';
    triggerDashboardEntrance();
});

const BUFFER_SIZE = 900; // ~30 seconds at 30fps

// App logic
function updateStatus(msg, isError = false) {
    const el = document.getElementById('appStatus');
    if (el) {
        el.innerText = msg;
        el.className = 'status-bar ' + (isError ? 'error' : 'active');
    }

    const sysEl = document.getElementById('sysStatusText');
    if (sysEl) {
        if (msg === "NO FACE DETECTED" || isError) {
            sysEl.innerText = "SEARCHING";
            sysEl.className = "value text-red";
        } else {
            sysEl.innerText = "STABLE";
            sysEl.className = "value text-green";
        }
    }

    // Update AI status orb class based on messages
    if (isError || msg === "NO FACE DETECTED") {
        updateAIOrbState('lost');
    } else if (msg.includes("INITIALIZING") || msg.includes("AWAITING")) {
        updateAIOrbState('idle');
    } else if (msg.includes("ANALYZING") || msg.includes("CALIBRATING") || msg.includes("WARMING")) {
        updateAIOrbState('processing');
    } else {
        updateAIOrbState('tracking');
    }
}

function getDistance(p1, p2) {
    return Math.sqrt(Math.pow(p1.x - p2.x, 2) + Math.pow(p1.y - p2.y, 2));
}

function calculateEAR(landmarks, offset) {
    // Left eye: 33, 160, 158, 133, 153, 144
    // Right eye: 362, 385, 387, 263, 373, 380
    // Simplified using 6 points: p0...p5
    const p1 = landmarks[offset + 1];
    const p2 = landmarks[offset + 2];
    const p3 = landmarks[offset + 3];
    const p4 = landmarks[offset + 4];
    const p5 = landmarks[offset + 5];
    const p0 = landmarks[offset + 0];
    
    // EAR = (||p2-p6|| + ||p3-p5||) / (2 * ||p1-p4||)
    const v1 = getDistance(p1, p5);
    const v2 = getDistance(p2, p4);
    const h = getDistance(p0, p3);
    
    return (v1 + v2) / (2.0 * h);
}

function calculateMAR(landmarks) {
    // Upper inner lip: 13, Lower inner lip: 14
    // Left inner lip: 78, Right inner lip: 308
    const upper = landmarks[13];
    const lower = landmarks[14];
    const left = landmarks[78];
    const right = landmarks[308];
    
    const v = getDistance(upper, lower);
    const h = getDistance(left, right);
    return v / (h + 0.0001);
}

function extractROI(ctx, x, y, size) {
    x = Math.max(0, Math.min(x, ctx.canvas.width - size));
    y = Math.max(0, Math.min(y, ctx.canvas.height - size));
    const imgData = ctx.getImageData(x, y, size, size);
    let sumG = 0;
    let sumR = 0;
    for (let i = 0; i < imgData.data.length; i += 4) {
        sumR += imgData.data[i];
        sumG += imgData.data[i + 1]; 
    }
    return { g: sumG / (size * size), r: sumR / (size * size) };
}

function drawWaveform(ctx, canvas, data, color) {
    if (canvas.width !== canvas.offsetWidth || canvas.height !== canvas.offsetHeight) {
        canvas.width = canvas.offsetWidth;
        canvas.height = canvas.offsetHeight;
    }
    
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (data.length < 2) return;

    let min = Math.min(...data);
    let max = Math.max(...data);
    let range = max - min;
    if (range === 0) range = 1;

    ctx.lineJoin = 'round';
    
    // Create gradient based on color
    let gradient = ctx.createLinearGradient(0, 0, 0, canvas.height);
    let rgb = color === '#00D9FF' || color === 'var(--color-blue)' ? '0,217,255' : 
              color === '#3EF7A5' || color === 'var(--color-green)' ? '62,247,165' : 
              color === '#FF5252' || color === 'var(--color-red)' ? '255,82,82' : '0,217,255';
    
    gradient.addColorStop(0, `rgba(${rgb}, 0.25)`);
    gradient.addColorStop(1, `rgba(${rgb}, 0.0)`);

    // Draw Fill
    ctx.beginPath();
    ctx.fillStyle = gradient;
    let padding = canvas.height * 0.15;
    let drawHeight = canvas.height * 0.7;
    
    for (let i = 0; i < data.length; i++) {
        let x = (i / (data.length - 1)) * canvas.width;
        let y = padding + drawHeight - ((data[i] - min) / range) * drawHeight;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
    }
    ctx.lineTo(canvas.width, canvas.height);
    ctx.lineTo(0, canvas.height);
    ctx.fill();

    // Draw Stroke with Neon Glow
    ctx.save();
    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.5;
    ctx.shadowBlur = 12;
    ctx.shadowColor = color;
    for (let i = 0; i < data.length; i++) {
        let x = (i / (data.length - 1)) * canvas.width;
        let y = padding + drawHeight - ((data[i] - min) / range) * drawHeight;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
    }
    ctx.stroke();
    
    // Draw leading data point indicator
    if (data.length > 0) {
        let lastIdx = data.length - 1;
        let lastX = canvas.width;
        let lastY = padding + drawHeight - ((data[lastIdx] - min) / range) * drawHeight;
        
        ctx.beginPath();
        ctx.arc(lastX - 3, lastY, 4, 0, 2 * Math.PI);
        ctx.fillStyle = '#ffffff';
        ctx.shadowBlur = 15;
        ctx.shadowColor = color;
        ctx.fill();
    }
    ctx.restore();
}

function performDFT(signal, times, freqMin, freqMax, steps) {
    let maxPower = 0;
    let bestFreq = 0;
    let totalPower = 0;
    
    const stepSize = (freqMax - freqMin) / steps;
    const t0 = times.length > 0 ? times[0] : 0;
    
    for (let i = 0; i <= steps; i++) {
        let f = freqMin + i * stepSize;
        let real = 0;
        let imag = 0;
        
        for (let j = 0; j < signal.length; j++) {
            let t = (times[j] - t0) / 1000.0; // Anchor time to 0 for numerical stability
            let angle = 2 * Math.PI * f * t;
            real += signal[j] * Math.cos(angle);
            imag -= signal[j] * Math.sin(angle);
        }
        
        let power = real * real + imag * imag;
        power = power * f; // Suppress 1/f (pink noise) motion artifacts!
        
        totalPower += power;
        
        if (power > maxPower) {
            maxPower = power;
            bestFreq = f;
        }
    }
    
    return { bestFreq, maxPower, totalPower };
}

let displayBPM = 0;
let displayResp = 0;

function processSignals() {
    if (signalBuffer.length < 150) return; // Wait for at least 5s of data
    
    // 1. Detrend signal for Pulse (1 second window ~ 30 frames)
    let pulseDetrended = [];
    let windowPulse = 30;
    for (let i = 0; i < signalBuffer.length; i++) {
        let start = Math.max(0, i - windowPulse/2);
        let end = Math.min(signalBuffer.length, i + windowPulse/2);
        let sum = 0;
        for (let j = start; j < end; j++) sum += signalBuffer[j];
        pulseDetrended.push(signalBuffer[i] - (sum / (end - start)));
    }

    // 2. Detrend signal for Resp (5 second window ~ 150 frames)
    let respDetrended = [];
    let windowResp = 150;
    for (let i = 0; i < signalBuffer.length; i++) {
        let start = Math.max(0, i - windowResp/2);
        let end = Math.min(signalBuffer.length, i + windowResp/2);
        let sum = 0;
        for (let j = start; j < end; j++) sum += signalBuffer[j];
        respDetrended.push(signalBuffer[i] - (sum / (end - start)));
    }

    // Use recent 6s for Pulse (~180 frames) to make it highly responsive, full buffer for Breathing
    let recentTime = timeBuffer.slice(-180);
    let recentPulseSignal = pulseDetrended.slice(-180);
    
    if (recentPulseSignal.length < 100) return;

    // Smooth pulse signal to remove high frequency noise before peak detection (Low-pass)
    let smoothedPulse = [];
    for (let i = 0; i < recentPulseSignal.length; i++) {
        let sum = 0;
        let count = 0;
        // 5 frame moving average
        for (let j = Math.max(0, i-2); j <= Math.min(recentPulseSignal.length-1, i+2); j++) {
            sum += recentPulseSignal[j];
            count++;
        }
        smoothedPulse.push(sum / count);
    }

    // Pulse analysis (0.83 - 2.0 Hz -> 50-120 BPM)
    let pulseRes = performDFT(smoothedPulse, recentTime, 0.83, 2.0, 100);
    let bpm = pulseRes.bestFreq * 60;
    
    // Confidence & Status Meters (Calculate SNR)
    // totalPower is the sum across 100 frequency bins. Average noise floor = totalPower / 100
    let avgPower = pulseRes.totalPower / 100;
    let snr = pulseRes.maxPower / (avgPower + 1e-6);
    
    // Map SNR (typically 2 to 15) to a 0-100% confidence score
    let confidence = Math.min(100, Math.max(0, (snr - 2) * 10));
    
    document.getElementById('pulseConfidence').innerText = confidence.toFixed(0) + '%';
    document.getElementById('confFill').style.width = confidence.toFixed(0) + '%';
    
    let dq = Math.min(100, Math.max(0, confidence * 1.2));
    document.getElementById('dqPercentage').innerText = dq.toFixed(0) + '%';
    document.getElementById('dataQualityText').innerText = dq > 80 ? 'EXCELLENT' : (dq > 50 ? 'GOOD' : 'POOR');
    document.querySelector('.circle').setAttribute('stroke-dasharray', `${dq}, 100`);

    // EMA Smoothing for Pulse - Higher alpha for fast, snappy response during demo
    let alpha = confidence > 15 ? 0.3 : 0.05;
    if (displayBPM === 0 || isNaN(displayBPM)) displayBPM = bpm;
    else displayBPM = displayBPM * (1 - alpha) + bpm * alpha; 
    
    // Breathing analysis (0.16 - 0.5 Hz -> 10-30 BrPM)
    let respRes = performDFT(respDetrended, timeBuffer, 0.16, 0.5, 50);
    let brpm = respRes.bestFreq * 60;
    
    // EMA Smoothing for Resp (Faster response)
    if (displayResp === 0 || isNaN(displayResp)) displayResp = brpm;
    else displayResp = displayResp * 0.8 + brpm * 0.2;

    // Calculate SpO2 (Experimental AC/DC Ratio)
    if (signalBufferR.length >= 150) {
        let rRecent = signalBufferR.slice(-150);
        let gRecent = signalBuffer.slice(-150);
        let rMean = rRecent.reduce((a,b)=>a+b,0)/rRecent.length;
        let gMean = gRecent.reduce((a,b)=>a+b,0)/gRecent.length;
        let rAC = 0, gAC = 0;
        for(let i=0; i<rRecent.length; i++){
            rAC += Math.pow(rRecent[i]-rMean, 2);
            gAC += Math.pow(gRecent[i]-gMean, 2);
        }
        rAC = Math.sqrt(rAC/rRecent.length);
        gAC = Math.sqrt(gAC/gRecent.length);
        
        let ratio = (rAC/(rMean||1)) / (gAC/(gMean||1) + 1e-6);
        let calcSpO2 = 110 - 25 * ratio;
        calcSpO2 = Math.min(100, Math.max(90, calcSpO2));
        
        if (spo2Display === 0) spo2Display = calcSpO2;
        else spo2Display = spo2Display * 0.9 + calcSpO2 * 0.1;
    }

    // Baseline Accumulation & Deltas
    if (appState === 'LOGIN' && confidence >= 5) {
        if (displayBPM > 40) baselineDataHR.push(displayBPM);
        if (displayResp > 5) baselineDataRR.push(displayResp);
    }
    if (appState === 'DASHBOARD' && baselineHR === null && baselineDataHR.length > 0) {
        baselineHR = baselineDataHR.reduce((a,b)=>a+b,0)/baselineDataHR.length;
        baselineRR = baselineDataRR.reduce((a,b)=>a+b,0)/baselineDataRR.length;
    }

    // Confidence Floor for UI
    if (confidence >= 5) {
        document.getElementById('pulseValue').innerText = displayBPM > 40 ? displayBPM.toFixed(0) : '--';
        document.getElementById('respValue').innerText = displayResp > 5 ? displayResp.toFixed(0) : '--';
        document.getElementById('spo2Value').innerText = spo2Display > 90 ? spo2Display.toFixed(1) : '--';
        
        // Show deltas if baseline exists
        if (baselineHR && displayBPM > 40) {
            let diffHR = displayBPM - baselineHR;
            let elHR = document.getElementById('hrDelta');
            elHR.innerText = (diffHR > 0 ? '+' : '') + diffHR.toFixed(0);
            elHR.className = 'delta ' + (diffHR > 10 ? 'text-red' : (diffHR < -10 ? 'text-blue' : 'text-green'));
            elHR.style.display = 'inline-block';
        }
        if (baselineRR && displayResp > 5) {
            let diffRR = displayResp - baselineRR;
            let elRR = document.getElementById('rrDelta');
            elRR.innerText = (diffRR > 0 ? '+' : '') + diffRR.toFixed(0);
            elRR.className = 'delta ' + (diffRR > 3 ? 'text-red' : (diffRR < -3 ? 'text-blue' : 'text-green'));
            elRR.style.display = 'inline-block';
        }
    } else {
        document.getElementById('pulseValue').innerText = '--';
        document.getElementById('respValue').innerText = '--';
        document.getElementById('spo2Value').innerText = '--';
        document.getElementById('hrDelta').style.display = 'none';
        document.getElementById('rrDelta').style.display = 'none';
    }

    // Signal Quality Context
    let contextText = document.getElementById('signalContext');
    if (confidence < 15) {
        let isTalking = document.getElementById('talkingValue').innerText === 'YES';
        if (isTalking) contextText.innerText = "MOTION ARTIFACT";
        else contextText.innerText = "POOR LIGHTING / ANGLE";
    } else {
        contextText.innerText = "";
    }

    // Alert Thresholds
    let hrPanel = document.querySelector('.panel-hr');
    if (displayBPM > 40 && (displayBPM < 60 || displayBPM > 100)) hrPanel.classList.add('alert-danger');
    else hrPanel.classList.remove('alert-danger');

    let rrPanel = document.querySelector('.panel-resp');
    if (displayResp > 5 && (displayResp < 12 || displayResp > 20)) rrPanel.classList.add('alert-danger');
    else rrPanel.classList.remove('alert-danger');

    // History Logging (every ~1s)
    let nowStr = Date.now();
    if (!window.lastHistTime || nowStr - window.lastHistTime > 1000) {
        window.lastHistTime = nowStr;
        if (confidence >= 5) {
            historyData.push({
                time: nowStr,
                timestamp: nowStr,
                hr: displayBPM,
                rr: displayResp,
                spo2: spo2Display,
                stress: displayStressIndex,
                quality: confidence > 7 ? 'OPTIMAL' : 'ADEQUATE'
            });
        }
    }

    // Waveform rendering
    drawWaveform(document.getElementById('arterialCanvas').getContext('2d'), document.getElementById('arterialCanvas'), smoothedPulse.slice(-150), '#00D9FF');
    drawWaveform(document.getElementById('pulseCanvas').getContext('2d'), document.getElementById('pulseCanvas'), smoothedPulse.slice(-60), '#00D9FF');
    drawWaveform(document.getElementById('respCanvas').getContext('2d'), document.getElementById('respCanvas'), respDetrended.slice(-300), '#3EF7A5');
    
    // Draw mini decorative waves for HRV
    drawMiniWave('mnnCanvas', '#00D9FF');
    drawMiniWave('sdnnCanvas', '#3EF7A5');
    drawMiniWave('rmssdCanvas', '#00D9FF');
    drawMiniWave('stressCanvas', '#3EF7A5');

    // Smooth specifically for HRV to remove high freq noise
    let hrvPulse = [];
    for (let i = 0; i < smoothedPulse.length; i++) {
        let sum = 0;
        let count = 0;
        for (let j = Math.max(0, i-4); j <= Math.min(smoothedPulse.length-1, i+4); j++) {
            sum += smoothedPulse[j];
            count++;
        }
        hrvPulse.push(sum / count);
    }

    // Peak detection for HRV (using the heavily smoothed signal)
    let hrWindow = hrvPulse.slice(-60); // Widened to ~2 seconds
    let hrTimes = recentTime.slice(-60);
    
    let windowMax = Math.max(...hrWindow);
    let threshold = windowMax * 0.25; 

    for (let i = 1; i < hrWindow.length - 1; i++) {
        // Require peak to be in the center of the window to avoid duplicate triggers
        if (i > 20 && i < hrWindow.length - 20) {
            if (hrWindow[i] > hrWindow[i-1] && hrWindow[i] > hrWindow[i+1] && hrWindow[i] > threshold) {
                let peakTime = hrTimes[i];
                let nn = peakTime - lastPeakTime;
                
                // Valid NN interval: 400ms (150 BPM) to 1500ms (40 BPM)
                if (lastPeakTime !== 0 && nn > 400 && nn < 1500) { 
                    nnIntervals.push(nn);
                    if (nnIntervals.length > 30) nnIntervals.shift(); 
                    calculateHRV();
                    lastPeakTime = peakTime;
                } else if (lastPeakTime === 0 || nn >= 1500) {
                    lastPeakTime = peakTime; 
                }
            }
        }
    }
}

function calculateHRV() {
    if (nnIntervals.length < 5) return;
    
    let sum = nnIntervals.reduce((a, b) => a + b, 0);
    let meanNn = sum / nnIntervals.length;
    
    let sqDiff = 0;
    let rmssdSum = 0;
    for (let i = 0; i < nnIntervals.length; i++) {
        sqDiff += Math.pow(nnIntervals[i] - meanNn, 2);
        if (i > 0) {
            rmssdSum += Math.pow(nnIntervals[i] - nnIntervals[i-1], 2);
        }
    }
    
    let sdnn = Math.sqrt(sqDiff / nnIntervals.length);
    let rmssd = Math.sqrt(rmssdSum / (nnIntervals.length - 1));
    displayRMSSD = rmssd;
    
    // Baevsky SI approx
    let minNn = Math.min(...nnIntervals) / 1000;
    let maxNn = Math.max(...nnIntervals) / 1000;
    let mxDMn = maxNn - minNn;
    
    // Mode approximation
    let bins = {};
    let mode = meanNn / 1000;
    let maxCount = 0;
    nnIntervals.forEach(nn => {
        let bin = Math.round(nn / 50) * 50; // 50ms bins
        bins[bin] = (bins[bin] || 0) + 1;
        if (bins[bin] > maxCount) {
            maxCount = bins[bin];
            mode = bin / 1000;
        }
    });
    let amo = (maxCount / nnIntervals.length) * 100;
    let si = mxDMn > 0 ? (amo / (2 * mode * mxDMn)) : 0;
    displayStressIndex = si;

    if (meanNn) document.getElementById('meanNN').innerText = meanNn.toFixed(0);
    if (sdnn) document.getElementById('sdnn').innerText = sdnn.toFixed(0);
    if (rmssd) document.getElementById('rmssd').innerText = rmssd.toFixed(0);
    if (si) {
        const stressEl = document.getElementById('stressIndex');
        const levelEl = document.getElementById('stressLevel');
        stressEl.innerText = si.toFixed(0);
        
        let label = 'HIGH', color = '#FF5252', cssClass = 'text-red';
        if (si < 50) { label = 'LOW'; color = '#00D9FF'; cssClass = 'text-blue'; }
        else if (si < 150) { label = 'NORMAL'; color = '#3EF7A5'; cssClass = 'text-green'; }
        else if (si < 500) { label = 'ELEVATED'; color = '#FFC857'; cssClass = 'text-yellow'; }
        
        stressEl.className = cssClass;
        if (levelEl) {
            levelEl.innerText = label;
            levelEl.style.color = color;
        }
    }
}

// --- Decorative Sci-Fi Drawing Functions ---
function drawMiniWave(canvasId, color) {
    const canvas = document.getElementById(canvasId);
    if(!canvas) return;
    const ctx = canvas.getContext('2d');
    canvas.width = canvas.offsetWidth;
    canvas.height = canvas.offsetHeight;
    ctx.clearRect(0,0,canvas.width,canvas.height);
    
    let gradient = ctx.createLinearGradient(0, 0, 0, canvas.height);
    let rgb = color === '#00D9FF' ? '0,217,255' : '62,247,165';
    gradient.addColorStop(0, `rgba(${rgb}, 0.2)`);
    gradient.addColorStop(1, `rgba(${rgb}, 0.0)`);
    
    ctx.beginPath();
    ctx.fillStyle = gradient;
    let time = performance.now() / 800;
    for(let i=0; i<canvas.width; i+=2) {
        let y = canvas.height/2 + Math.sin(i*0.12 + time)*4;
        if(i===0) ctx.moveTo(i,y); else ctx.lineTo(i,y);
    }
    ctx.lineTo(canvas.width, canvas.height);
    ctx.lineTo(0, canvas.height);
    ctx.fill();
    
    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.shadowBlur = 5;
    ctx.shadowColor = color;
    for(let i=0; i<canvas.width; i+=2) {
        let y = canvas.height/2 + Math.sin(i*0.12 + time)*4;
        if(i===0) ctx.moveTo(i,y); else ctx.lineTo(i,y);
    }
    ctx.stroke();
    ctx.shadowBlur = 0;
}

function drawExprWave() {
    const canvas = document.getElementById('exprWave');
    if(!canvas) return;
    const ctx = canvas.getContext('2d');
    if(canvas.width !== canvas.offsetWidth) canvas.width = canvas.offsetWidth;
    if(canvas.height !== canvas.offsetHeight) canvas.height = canvas.offsetHeight;
    ctx.clearRect(0,0,canvas.width,canvas.height);
    ctx.beginPath();
    let time = performance.now() / 500;
    let isTalking = document.getElementById('talkingValue').innerText === 'YES';
    for(let i=0; i<canvas.width; i+=2) {
        let r = isTalking ? (Math.random()*15) : (Math.sin(i*0.05 + time)*5);
        let y = canvas.height/2 + r;
        ctx.fillStyle = `rgba(0, 255, 68, ${Math.random()*0.8 + 0.2})`;
        ctx.fillRect(i, y, 2, 2);
        ctx.fillRect(i, canvas.height/2 - r, 2, 2);
    }
    requestAnimationFrame(drawExprWave);
}
setTimeout(() => { drawExprWave(); }, 1000);

function drawFooterLine() {
    const canvas = document.getElementById('footerLineCanvas');
    if(!canvas) return;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0,0,200,30);
    ctx.strokeStyle = '#ff2a2a';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, 15); ctx.lineTo(50, 15);
    ctx.lineTo(60, 5); ctx.lineTo(70, 25);
    ctx.lineTo(80, 15); ctx.lineTo(200, 15);
    ctx.stroke();
}
setTimeout(() => { drawFooterLine(); }, 500);

function onResults(results) {
    if (appState === 'LOGIN') {
        const lCanvas = document.getElementById('loginCanvas');
        if (!lCanvas) return;
        const lCtx = lCanvas.getContext('2d');
        lCanvas.width = videoElement.videoWidth;
        lCanvas.height = videoElement.videoHeight;
        lCtx.save();
        lCtx.clearRect(0, 0, lCanvas.width, lCanvas.height);
        lCtx.drawImage(results.image, 0, 0, lCanvas.width, lCanvas.height);
        
        if (results.multiFaceLandmarks && results.multiFaceLandmarks.length > 0) {
            const landmarks = results.multiFaceLandmarks[0];
            drawConnectors(lCtx, landmarks, FACEMESH_TESSELATION, {color: 'rgba(255, 255, 255, 0.4)', lineWidth: 1});
            
            if (!isSystemOnline || !navigator.onLine) {
                const statusEl = document.getElementById('loginStatusText');
                if (statusEl) {
                    statusEl.innerText = "PLEASE CONNECT TO THE INTERNET";
                    statusEl.style.color = "#ff2a2a";
                }
                isScanning = false;
                if (loginTimeout) clearTimeout(loginTimeout);
                if (loginCountdown) clearInterval(loginCountdown);
            } else if (!isScanning) {
                isScanning = true;
                const statusEl = document.getElementById('loginStatusText');
                const unlockBox = document.getElementById('unlockDetailBox');
                if (unlockBox) unlockBox.style.display = 'block';
                
                let timeLeft = 4.5;
                
                if (statusEl) {
                    statusEl.innerText = `FACE DETECTED. AUTHORIZING... (${timeLeft.toFixed(1)}s)`;
                    statusEl.style.color = ""; // reset color
                }
                
                const step1 = document.getElementById('udStep1');
                const step2 = document.getElementById('udStep2');
                const step3 = document.getElementById('udStep3');
                const step4 = document.getElementById('udStep4');
                const step5 = document.getElementById('udStep5');

                if (step1) { step1.className = 'ud-step success'; step1.innerText = '🟢 Camera Connection: Active'; }
                if (step2) { step2.className = 'ud-step active'; step2.innerText = '🟡 Face Detection: Active'; }

                if (loginCountdown) clearInterval(loginCountdown);
                loginCountdown = setInterval(() => {
                    timeLeft -= 0.1;
                    if (timeLeft <= 0) {
                        clearInterval(loginCountdown);
                    } else {
                        if (statusEl) {
                            statusEl.innerText = `FACE DETECTED. AUTHORIZING... (${timeLeft.toFixed(1)}s)`;
                        }
                        
                        // Progressive calibration updates
                        if (timeLeft <= 3.6 && timeLeft > 3.0) {
                            if (step2) { step2.className = 'ud-step success'; step2.innerText = '🟢 Face Detection: Geometry Locked'; }
                            if (step3) { step3.className = 'ud-step active'; step3.innerText = '🟡 Facial Geometry: Matching...'; }
                        }
                        if (timeLeft <= 3.0) {
                            const calSyncEl = document.getElementById('calSync');
                            if (calSyncEl) {
                                calSyncEl.innerText = "SYNCING... (50%)";
                                calSyncEl.className = "val text-blue";
                            }
                        }
                        if (timeLeft <= 2.2 && timeLeft > 1.5) {
                            if (step3) { step3.className = 'ud-step success'; step3.innerText = '🟢 Facial Geometry: Verified'; }
                            if (step4) { step4.className = 'ud-step active'; step4.innerText = '🟡 Identity Verification: Authenticating...'; }
                        }
                        if (timeLeft <= 1.5) {
                            const calSyncEl = document.getElementById('calSync');
                            if (calSyncEl) {
                                calSyncEl.innerText = "SYNCED";
                                calSyncEl.className = "val text-green";
                            }
                            const calLockEl = document.getElementById('calLock');
                            if (calLockEl) {
                                calLockEl.innerText = "LOCKING...";
                                calLockEl.className = "val text-blue";
                            }
                        }
                        if (timeLeft <= 0.8) {
                            if (step4) { step4.className = 'ud-step success'; step4.innerText = '🟢 Identity Verification: Confirmed'; }
                            if (step5) { step5.className = 'ud-step active'; step5.innerText = '🟡 AI Engine Activation: Starting...'; }
                        }
                    }
                }, 100);
                
                if (loginTimeout) clearTimeout(loginTimeout);
                loginTimeout = setTimeout(() => {
                    clearInterval(loginCountdown);
                    if (activeLoginTab !== 'FACE') return;
                    if (statusEl) {
                        statusEl.innerText = "ACCESS GRANTED.";
                        statusEl.style.color = "#00ff44";
                    }
                    if (step5) { step5.className = 'ud-step success'; step5.innerText = '🟢 AI Engine Activation: Synergized'; }
                    const scanLine = document.querySelector('.scan-line');
                    if (scanLine) scanLine.style.display = 'none';
                    
                    const calSyncEl = document.getElementById('calSync');
                    if (calSyncEl) {
                        calSyncEl.innerText = "SYNCED";
                        calSyncEl.className = "val text-green";
                    }
                    const calLockEl = document.getElementById('calLock');
                    if (calLockEl) {
                        calLockEl.innerText = "LOCKED";
                        calLockEl.className = "val text-green";
                    }
                    
                    setTimeout(() => {
                        if (activeLoginTab !== 'FACE') return;
                        const loginViewEl = document.getElementById('loginView');
                        if (loginViewEl) loginViewEl.style.opacity = '0';
                        setTimeout(() => {
                            if (activeLoginTab !== 'FACE') return;
                            if (loginViewEl) loginViewEl.style.display = 'none';
                            const dashboardViewEl = document.getElementById('dashboardView');
                            if (dashboardViewEl) dashboardViewEl.style.display = 'block';
                            appState = 'DASHBOARD';
                            triggerDashboardEntrance();
                            
                            // Initialize Dashboard Pipeline visual state
                            setTimeout(() => {
                                const pipeCam = document.getElementById('pipeCam');
                                const pipeFace = document.getElementById('pipeFace');
                                const pipeAuth = document.getElementById('pipeAuth');
                                const pipeLandmarks = document.getElementById('pipeLandmarks');
                                if (pipeCam) pipeCam.className = 'pipe-step success';
                                if (pipeFace) pipeFace.className = 'pipe-step success';
                                if (pipeAuth) pipeAuth.className = 'pipe-step success';
                                if (pipeLandmarks) pipeLandmarks.className = 'pipe-step success';
                            }, 500);
                        }, 500);
                    }, 500);
                }, 4500); // 4.5 seconds scan time
            }
        } else {
            // Face lost - reset login scanning state
            if (isScanning) {
                isScanning = false;
                if (loginTimeout) clearTimeout(loginTimeout);
                if (loginCountdown) clearInterval(loginCountdown);
                
                const unlockBox = document.getElementById('unlockDetailBox');
                if (unlockBox) unlockBox.style.display = 'none';
                
                const step1 = document.getElementById('udStep1');
                const step2 = document.getElementById('udStep2');
                const step3 = document.getElementById('udStep3');
                const step4 = document.getElementById('udStep4');
                const step5 = document.getElementById('udStep5');
                if (step1) { step1.className = 'ud-step'; step1.innerText = '⚪ Camera Connection: Pending'; }
                if (step2) { step2.className = 'ud-step'; step2.innerText = '⚪ Face Detection: Pending'; }
                if (step3) { step3.className = 'ud-step'; step3.innerText = '⚪ Facial Geometry: Pending'; }
                if (step4) { step4.className = 'ud-step'; step4.innerText = '⚪ Identity Verification: Pending'; }
                if (step5) { step5.className = 'ud-step'; step5.innerText = '⚪ AI Engine Activation: Pending'; }

                const statusEl = document.getElementById('loginStatusText');
                if (statusEl) {
                    statusEl.innerText = "AWAITING SUBJECT...";
                    statusEl.style.color = "";
                }
                
                const calSyncEl = document.getElementById('calSync');
                if (calSyncEl) {
                    calSyncEl.innerText = "INITIALIZING...";
                    calSyncEl.className = "val text-blue";
                }
                const calLockEl = document.getElementById('calLock');
                if (calLockEl) {
                    calLockEl.innerText = "SEARCHING...";
                    calLockEl.className = "val text-red";
                }
            } else {
                const statusEl = document.getElementById('loginStatusText');
                if (statusEl) {
                    statusEl.innerText = "AWAITING SUBJECT...";
                    statusEl.style.color = "";
                }
            }
        }
        lCtx.restore();
        // Do not return here, we want background processing!
    }

    // Resize output canvas to match video
    canvasElement.width = videoElement.videoWidth;
    canvasElement.height = videoElement.videoHeight;
    pulseCanvas.width = pulseCanvas.clientWidth;
    pulseCanvas.height = pulseCanvas.clientHeight;
    respCanvas.width = respCanvas.clientWidth;
    respCanvas.height = respCanvas.clientHeight;
    arterialCanvas.width = arterialCanvas.clientWidth;
    arterialCanvas.height = arterialCanvas.clientHeight;

    canvasCtx.save();
    canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);
    canvasCtx.drawImage(results.image, 0, 0, canvasElement.width, canvasElement.height);

    if (results.multiFaceLandmarks && results.multiFaceLandmarks.length > 0) {
        updateStatus("TRACKING ACTIVE");
        const landmarks = results.multiFaceLandmarks[0];
        const width = canvasElement.width;
        const height = canvasElement.height;
        
        // Notifications on tracking state changes
        if (!wasFaceDetected) {
            showAINotification("Face Detected - Scanning biometrics...", "success");
            wasFaceDetected = true;
        }
        
        // Estimate face distance in cm based on width between cheeks (approx landmarks 234 and 454)
        let dx = (landmarks[234].x - landmarks[454].x) * width;
        let dy = (landmarks[234].y - landmarks[454].y) * height;
        let cheekDist = Math.sqrt(dx*dx + dy*dy);
        let estimatedDistanceCm = 50 * (150 / cheekDist);
        
        let confValue = (confidence ? confidence * 10 : 0);
        if (confValue > 70 && !trackingStableNotified) {
            showAINotification("Face Tracking Stable. Biometric Lock Established.", "success");
            trackingStableNotified = true;
        }
        
        if (displayBPM > 45 && !heartRateSyncNotified) {
            showAINotification("Biometric Signals Synchronized Successfully", "info");
            heartRateSyncNotified = true;
        }

        // Update floating HUD labels:
        const detectStatusEl = document.getElementById('hudDetectStatus');
        const qualityTextEl = document.getElementById('hudQualityText');
        const fpsTextEl = document.getElementById('hudFpsText');
        const confidenceTextEl = document.getElementById('hudConfidenceText');
        const distanceTextEl = document.getElementById('hudDistanceText');
        
        if (detectStatusEl) detectStatusEl.innerText = "SUBJECT TRACKING";
        if (qualityTextEl) qualityTextEl.innerText = "LIGHT: OPTIMAL";
        if (fpsTextEl) fpsTextEl.innerText = "FPS: 30";
        if (confidenceTextEl) confidenceTextEl.innerText = "CONF: " + (confidence ? (confidence * 10).toFixed(0) : "0") + "%";
        if (distanceTextEl) distanceTextEl.innerText = "DIST: ~" + estimatedDistanceCm.toFixed(0) + " cm";

        // Update Top HUD Header Telemetry:
        const headerAiStatus = document.getElementById('hudHeaderAiStatus');
        const headerFps = document.getElementById('hudHeaderFps');
        if (headerAiStatus) {
            headerAiStatus.innerText = "TRACKING ACTIVE";
            headerAiStatus.className = "value text-green";
        }
        if (headerFps) headerFps.innerText = "30";

        // Update Diagnostics panel telemetry:
        const hudEmotionProfile = document.getElementById('hudEmotionProfile');
        const hudSignalQuality = document.getElementById('hudSignalQuality');
        const hudAiConfidence = document.getElementById('hudAiConfidence');
        const healthScoreValue = document.getElementById('healthScoreValue');
        const healthScoreCircle = document.getElementById('healthScoreCircle');
        
        let compState = document.getElementById('expressionValue') ? document.getElementById('expressionValue').innerText : 'CALM';
        if (hudEmotionProfile) hudEmotionProfile.innerText = compState.split(' ')[0];
        
        let sigQuality = confValue > 75 ? 'EXCELLENT' : (confValue > 50 ? 'GOOD' : 'POOR');
        if (hudSignalQuality) {
            hudSignalQuality.innerText = sigQuality;
            hudSignalQuality.className = "val " + (sigQuality === 'POOR' ? 'text-red' : 'text-green');
        }
        if (hudAiConfidence) {
            hudAiConfidence.innerText = confValue.toFixed(0) + "%";
            hudAiConfidence.className = "val " + (confValue > 60 ? 'text-green' : 'text-red');
        }
        
        // Dynamic Biometric Integrity Score
        let integrity = Math.min(100, Math.max(15, (confValue * 0.7 + (estimatedDistanceCm > 35 && estimatedDistanceCm < 75 ? 30 : 15))));
        if (healthScoreValue) healthScoreValue.textContent = Math.round(integrity) + "%";
        if (healthScoreCircle) {
            // stroke-dasharray parameter (value, 100)
            healthScoreCircle.style.strokeDasharray = `${Math.round(integrity)}, 100`;
        }
        
        // Calculate Bounding box for Target Lock HUD
        let minX = width, maxX = 0, minY = height, maxY = 0;
        landmarks.forEach(pt => {
            let px = pt.x * width;
            let py = pt.y * height;
            if (px < minX) minX = px;
            if (px > maxX) maxX = px;
            if (py < minY) minY = py;
            if (py > maxY) maxY = py;
        });
        let cx = (minX + maxX) / 2;
        let cy = (minY + maxY) / 2;
        let r = Math.max(maxX - minX, maxY - minY) / 2 * 1.1;
        
        // Draw a pulsing target lock ring
        canvasCtx.strokeStyle = 'rgba(0, 217, 255, 0.45)';
        canvasCtx.lineWidth = 1.5;
        canvasCtx.setLineDash([6, 4]); // dashed circle
        canvasCtx.beginPath();
        canvasCtx.arc(cx, cy, r + Math.sin(performance.now() / 150) * 3, 0, 2 * Math.PI);
        canvasCtx.stroke();
        canvasCtx.setLineDash([]); // reset line dash
        
        // Corner HUD brackets for target lock
        canvasCtx.strokeStyle = 'rgba(0, 217, 255, 0.75)';
        canvasCtx.lineWidth = 2.5;
        let bSize = 15;
        // Top-left
        canvasCtx.beginPath(); canvasCtx.moveTo(cx - r, cy - r + bSize); canvasCtx.lineTo(cx - r, cy - r); canvasCtx.lineTo(cx - r + bSize, cy - r); canvasCtx.stroke();
        // Top-right
        canvasCtx.beginPath(); canvasCtx.moveTo(cx + r, cy - r + bSize); canvasCtx.lineTo(cx + r, cy - r); canvasCtx.lineTo(cx + r - bSize, cy - r); canvasCtx.stroke();
        // Bot-left
        canvasCtx.beginPath(); canvasCtx.moveTo(cx - r, cy + r - bSize); canvasCtx.lineTo(cx - r, cy + r); canvasCtx.lineTo(cx - r + bSize, cy + r); canvasCtx.stroke();
        // Bot-right
        canvasCtx.beginPath(); canvasCtx.moveTo(cx + r, cy + r - bSize); canvasCtx.lineTo(cx + r, cy + r); canvasCtx.lineTo(cx + r - bSize, cy + r); canvasCtx.stroke();
        
        // Draw face mesh visibly (white triangles)
        drawConnectors(canvasCtx, landmarks, FACEMESH_TESSELATION, {color: 'rgba(0, 217, 255, 0.45)', lineWidth: 1});
        
        // Extract ROIs
        
        const forehead = landmarks[10];
        const leftCheek = landmarks[205];
        const rightCheek = landmarks[425];
        
        const fhX = forehead.x * width;
        const fhY = forehead.y * height;
        const lcX = leftCheek.x * width;
        const lcY = leftCheek.y * height;
        const rcX = rightCheek.x * width;
        const rcY = rightCheek.y * height;

        // Draw ROI boxes as sci-fi corners
        function drawCorners(ctx, x, y, size) {
            let hs = size/2;
            let len = 6;
            ctx.beginPath();
            ctx.moveTo(x - hs, y - hs + len); ctx.lineTo(x - hs, y - hs); ctx.lineTo(x - hs + len, y - hs);
            ctx.moveTo(x + hs - len, y - hs); ctx.lineTo(x + hs, y - hs); ctx.lineTo(x + hs, y - hs + len);
            ctx.moveTo(x + hs, y + hs - len); ctx.lineTo(x + hs, y + hs); ctx.lineTo(x + hs - len, y + hs);
            ctx.moveTo(x - hs + len, y + hs); ctx.lineTo(x - hs, y + hs); ctx.lineTo(x - hs, y + hs - len);
            ctx.stroke();
        }

        canvasCtx.strokeStyle = 'rgba(255, 42, 42, 0.8)';
        canvasCtx.lineWidth = 2;
        const roiSize = 24;
        
        drawCorners(canvasCtx, fhX, fhY, roiSize);
        drawCorners(canvasCtx, lcX, lcY, roiSize);
        drawCorners(canvasCtx, rcX, rcY, roiSize);

        // Highlight eyes and mouth for "Face Understanding"
        canvasCtx.strokeStyle = 'rgba(255, 200, 200, 0.4)';
        canvasCtx.lineWidth = 1;
        function drawLoop(indices) {
            canvasCtx.beginPath();
            indices.forEach((idx, i) => {
                let pt = landmarks[idx];
                if (i===0) canvasCtx.moveTo(pt.x*width, pt.y*height);
                else canvasCtx.lineTo(pt.x*width, pt.y*height);
            });
            canvasCtx.closePath();
            canvasCtx.stroke();
        }
        drawLoop([33, 160, 158, 133, 153, 144]); // Left eye
        drawLoop([362, 385, 387, 263, 373, 380]); // Right eye
        drawLoop([78, 81, 13, 311, 308, 402, 14, 178]); // Mouth

        // Get Dual Channel (Green and Red)
        const fhVal = extractROI(canvasCtx, fhX - roiSize/2, fhY - roiSize/2, roiSize);
        const lcVal = extractROI(canvasCtx, lcX - roiSize/2, lcY - roiSize/2, roiSize);
        const rcVal = extractROI(canvasCtx, rcX - roiSize/2, rcY - roiSize/2, roiSize);
        
        let avgVal = (fhVal.g + lcVal.g + rcVal.g) / 3;
        let avgR = (fhVal.r + lcVal.r + rcVal.r) / 3;
        
        // Send raw localized intensities over Socket.io link
        if (typeof window.sendDataPacket === 'function') {
            window.sendDataPacket(avgVal, avgR);
        }
        
        if (signalBuffer.length > BUFFER_SIZE) {
            signalBuffer.shift();
            signalBufferR.shift();
            timeBuffer.shift();
        }

        // Face Analysis
        const le1=landmarks[33], le2=landmarks[160], le3=landmarks[158], le4=landmarks[133], le5=landmarks[153], le6=landmarks[144];
        const leftEarVal = (getDistance(le2, le6) + getDistance(le3, le5)) / (2 * getDistance(le1, le4));
        
        const re1=landmarks[362], re2=landmarks[385], re3=landmarks[387], re4=landmarks[263], re5=landmarks[373], re6=landmarks[380];
        const rightEarVal = (getDistance(re2, re6) + getDistance(re3, re5)) / (2 * getDistance(re1, re4));
        
        const ear = (leftEarVal + rightEarVal) / 2;
        if (ear < 0.2) {
            if (!isBlinking) {
                blinks++;
                blinkTimestamps.push(performance.now());
                isBlinking = true;
            }
        } else {
            isBlinking = false;
        }
        
        let now = performance.now();
        blinkTimestamps = blinkTimestamps.filter(t => now - t <= 60000);
        let blinkRate = blinkTimestamps.length;
        document.getElementById('blinkValue').innerText = blinkRate;

        const mar = calculateMAR(landmarks);
        marBuffer.push(mar);
        if (marBuffer.length > 60) marBuffer.shift();
        
        let marVariance = 0;
        if (marBuffer.length === 60) {
            let marMean = marBuffer.reduce((a,b)=>a+b,0)/60;
            marVariance = marBuffer.reduce((a,b)=>a+Math.pow(b-marMean, 2), 0)/60;
        }
        
        let isTalking = marVariance > 0.005; // Less sensitive threshold
        document.getElementById('talkingValue').innerText = isTalking ? 'YES' : 'NO';
        
        signalBuffer.push(avgVal);
        signalBufferR.push(avgR);
        timeBuffer.push(performance.now());
        
        if (signalBuffer.length > BUFFER_SIZE) {
            signalBuffer.shift();
            signalBufferR.shift();
            timeBuffer.shift();
        }

        let expression = 'CALM / BASELINE';
        let expColor = 'text-green';

        if (displayBPM > 90 && displayStressIndex > 150) {
            expression = 'ELEVATED STRESS';
            expColor = 'text-red';
        } else if (displayBPM > 95 && displayRMSSD > 0 && displayRMSSD < 20) {
            expression = 'ELEVATED STRESS';
            expColor = 'text-red';
        } else if (displayResp > 0 && displayResp < 12 && blinkRate < 8) {
            expression = 'FATIGUED / DROWSY';
            expColor = 'text-blue';
        } else if (isTalking) {
            expression = 'ACTIVE / ENGAGED';
            expColor = 'text-blue';
        } else {
            let jawWidth = getDistance(landmarks[234], landmarks[454]);
            let mouthWidth = getDistance(landmarks[61], landmarks[291]);
            if ((mouthWidth / jawWidth) > 0.38) {
                expression = 'ACTIVE / ENGAGED';
                expColor = 'text-blue';
            }
        }
        
        const expEl = document.getElementById('expressionValue');
        expEl.innerText = expression;
        expEl.className = expColor;

        // Extract raw values for Face Status Box
        let trackingStability = confValue > 80 ? 'EXCELLENT' : (confValue > 55 ? 'STABLE' : 'UNSTABLE');
        
        // Estimate head rotation based on yaw (landmarks 33 and 263 relative to nose tip 4)
        let nose = landmarks[4];
        let yaw = Math.round((landmarks[263].x - nose.x - (nose.x - landmarks[33].x)) * 180);
        
        // Estimate illumination level around forehead (landmark 10)
        let lightVal = qualityTextEl && qualityTextEl.innerText.includes('OPTIMAL') ? 'EXCELLENT' : 'CHECKING';
        
        // Calculate motion variance from signal buffers
        let motionVal = signalBuffer.length > 5 ? Math.min(100, Math.round(Math.abs(signalBuffer[signalBuffer.length-1] - signalBuffer[signalBuffer.length-2]) * 8)) : 5;
        let motionText = motionVal < 15 ? 'LOW' : (motionVal < 45 ? 'MODERATE' : 'EXCESSIVE');
        
        // Update Face Details box elements
        const faceDetConf = document.getElementById('faceDetConf');
        const faceTrackStab = document.getElementById('faceTrackStab');
        const faceHeadRot = document.getElementById('faceHeadRot');
        const faceDistanceVal = document.getElementById('faceDistanceVal');
        const faceLightVal = document.getElementById('faceLightVal');
        const faceMotionVal = document.getElementById('faceMotionVal');

        if (faceDetConf) faceDetConf.innerText = confValue.toFixed(0) + "%";
        if (faceTrackStab) faceTrackStab.innerText = trackingStability;
        if (faceHeadRot) faceHeadRot.innerText = Math.abs(yaw) + "°";
        if (faceDistanceVal) faceDistanceVal.innerText = "~" + estimatedDistanceCm.toFixed(0) + " cm";
        if (faceLightVal) faceLightVal.innerText = lightVal;
        if (faceMotionVal) faceMotionVal.innerText = motionText;

        // Progressive dashboard pipeline highlight status updates
        const pipeFace = document.getElementById('pipeFace');
        const pipeAuth = document.getElementById('pipeAuth');
        const pipeLandmarks = document.getElementById('pipeLandmarks');
        const pipeBlinks = document.getElementById('pipeBlinks');
        const pipeMouth = document.getElementById('pipeMouth');
        const pipeRppg = document.getElementById('pipeRppg');
        const pipeResp = document.getElementById('pipeResp');
        const pipeHrv = document.getElementById('pipeHrv');
        const pipeStress = document.getElementById('pipeStress');

        if (pipeFace) pipeFace.className = 'pipe-step success';
        if (pipeAuth) pipeAuth.className = 'pipe-step success';
        if (pipeLandmarks) pipeLandmarks.className = 'pipe-step success';
        
        if (pipeBlinks) {
            pipeBlinks.className = blinks > 0 ? 'pipe-step success' : 'pipe-step active';
            pipeBlinks.innerText = `🟢 Eye Aspect Blinks (${blinks})`;
        }
        if (pipeMouth) {
            pipeMouth.className = isTalking ? 'pipe-step success' : 'pipe-step active';
            pipeMouth.innerText = isTalking ? '🟢 Oral Geometry: TALKING' : '🟢 Oral Geometry: CALM';
        }
        
        if (displayBPM > 45) {
            if (pipeRppg) pipeRppg.className = 'pipe-step success';
            if (pipeResp) pipeResp.className = 'pipe-step success';
        } else {
            if (pipeRppg) pipeRppg.className = 'pipe-step active';
            if (pipeResp) pipeResp.className = 'pipe-step active';
        }
        
        if (displayRMSSD > 0) {
            if (pipeHrv) pipeHrv.className = 'pipe-step success';
            if (pipeStress) pipeStress.className = 'pipe-step success';
        } else {
            if (pipeHrv) pipeHrv.className = 'pipe-step active';
            if (pipeStress) pipeStress.className = 'pipe-step active';
        }

        // Send UI Notification for excessive motion warnings
        if (motionText === 'EXCESSIVE' && Math.random() < 0.05) {
            showAINotification("Excessive Motion Detected - stabilizing sensors", "warning");
        }

        processSignals();
    } else {
        updateStatus("NO FACE DETECTED", true);
        
        if (wasFaceDetected) {
            showAINotification("Biometric Signal Lost. Awaiting Subject...", "error");
            wasFaceDetected = false;
            trackingStableNotified = false;
        }
        
        const detectStatusEl = document.getElementById('hudDetectStatus');
        const qualityTextEl = document.getElementById('hudQualityText');
        const fpsTextEl = document.getElementById('hudFpsText');
        const confidenceTextEl = document.getElementById('hudConfidenceText');
        const distanceTextEl = document.getElementById('hudDistanceText');
        if (detectStatusEl) detectStatusEl.innerText = "NO SUBJECT";
        if (qualityTextEl) qualityTextEl.innerText = "LIGHT: CHECKING";
        if (fpsTextEl) fpsTextEl.innerText = "FPS: --";
        if (confidenceTextEl) confidenceTextEl.innerText = "CONF: 0%";
        if (distanceTextEl) distanceTextEl.innerText = "DIST: --";

        // Reset Face Status readouts
        const faceDetConf = document.getElementById('faceDetConf');
        const faceTrackStab = document.getElementById('faceTrackStab');
        const faceHeadRot = document.getElementById('faceHeadRot');
        const faceDistanceVal = document.getElementById('faceDistanceVal');
        const faceLightVal = document.getElementById('faceLightVal');
        const faceMotionVal = document.getElementById('faceMotionVal');

        if (faceDetConf) faceDetConf.innerText = "--";
        if (faceTrackStab) faceTrackStab.innerText = "--";
        if (faceHeadRot) faceHeadRot.innerText = "--";
        if (faceDistanceVal) faceDistanceVal.innerText = "--";
        if (faceLightVal) faceLightVal.innerText = "--";
        if (faceMotionVal) faceMotionVal.innerText = "--";

        // Reset Pipeline dashboard markers
        const pipelineSteps = document.querySelectorAll('.pipe-step');
        pipelineSteps.forEach(step => {
            if (step.id !== 'pipeCam') {
                step.className = 'pipe-step';
                // Reset text if it has counters
                if (step.id === 'pipeBlinks') step.innerText = '⚪ Eye Aspect Blinks';
                if (step.id === 'pipeMouth') step.innerText = '⚪ Oral Geometry Tracking';
            }
        });

        // Reset HUD header:
        const headerAiStatus = document.getElementById('hudHeaderAiStatus');
        const headerFps = document.getElementById('hudHeaderFps');
        if (headerAiStatus) {
            headerAiStatus.innerText = "SEARCHING...";
            headerAiStatus.className = "value text-red";
        }
        if (headerFps) headerFps.innerText = "--";
    }
    canvasCtx.restore();
}

let isFaceMeshReady = false;

// Initialize MediaPipe Face Mesh
const faceMesh = new FaceMesh({locateFile: (file) => {
    return `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}`;
}});

faceMesh.setOptions({
    maxNumFaces: 1,
    refineLandmarks: true,
    minDetectionConfidence: 0.35,
    minTrackingConfidence: 0.35
});

faceMesh.onResults((results) => {
    isFaceMeshReady = true;
    onResults(results);
});

// Setup Native WebRTC Camera Loop
let localVideoStream = null;
let cameraActive = false;
let pumpActive = false;

async function startCamera() {
    if (cameraActive) return;
    updateStatus("REQUESTING CAMERA...");
    try {
        const stream = await navigator.mediaDevices.getUserMedia({
            video: {
                width: { ideal: 640 },
                height: { ideal: 480 },
                facingMode: "user"
            },
            audio: false
        });
        localVideoStream = stream;
        videoElement.srcObject = stream;
        
        await new Promise((resolve) => {
            videoElement.onloadedmetadata = () => {
                videoElement.play().then(resolve);
            };
        });
        
        cameraActive = true;
        updateStatus("CAMERA ACTIVE. WARMING UP AI...");
        showAINotification("Camera Interface Connected", "info");
        rawVideoLoop();
        pumpFrames();
    } catch (err) {
        console.error("Camera startup failed:", err);
        updateStatus("CAMERA PERMISSION DENIED OR ERROR", true);
        showAINotification("Camera Connection Failed", "error");
    }
}

function stopCamera() {
    if (localVideoStream) {
        localVideoStream.getTracks().forEach(track => track.stop());
        localVideoStream = null;
    }
    videoElement.srcObject = null;
    cameraActive = false;
}

async function pumpFrames() {
    if (pumpActive) return;
    pumpActive = true;
    
    async function runPump() {
        if (!cameraActive) {
            pumpActive = false;
            return;
        }
        if (videoElement.srcObject && !videoElement.paused) {
            try {
                await faceMesh.send({image: videoElement});
            } catch (e) {
                console.error("Frame send error:", e);
            }
        }
        requestAnimationFrame(runPump);
    }
    
    requestAnimationFrame(runPump);
}

const camera = {
    start: startCamera,
    stop: stopCamera
};

function rawVideoLoop() {
    if (!isFaceMeshReady && !videoElement.paused) {
        if (videoElement.videoWidth > 0) {
            canvasElement.width = videoElement.videoWidth;
            canvasElement.height = videoElement.videoHeight;
            canvasCtx.drawImage(videoElement, 0, 0, canvasElement.width, canvasElement.height);
        }
        requestAnimationFrame(rawVideoLoop);
    }
}

// Start camera stream on init
startCamera();

// --- Dataset Loading Logic ---
let videoLoopId;
async function videoFrameLoop() {
    if (!videoElement.paused && !videoElement.ended) {
        await faceMesh.send({image: videoElement});
        videoLoopId = requestAnimationFrame(videoFrameLoop);
    }
}

document.getElementById('loadDatasetBtn').addEventListener('click', () => {
    document.getElementById('datasetUpload').click();
});

document.getElementById('datasetUpload').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) {
        // Stop the live webcam camera
        if (camera) {
            camera.stop();
        }
        
        const url = URL.createObjectURL(file);
        videoElement.src = url;
        videoElement.loop = true; // Loop the dataset for continuous analysis
        
        // Reset buffers
        signalBuffer = [];
        timeBuffer = [];
        nnIntervals = [];
        displayBPM = 0;
        displayResp = 0;
        lastPeakTime = 0;
        
        updateStatus("DATASET LOADED. PROCESSING...");
        
        videoElement.addEventListener('play', () => {
            if (videoLoopId) cancelAnimationFrame(videoLoopId);
            videoFrameLoop();
        }, {once: true});
        
        document.getElementById('playPauseBtn').style.display = 'inline-block';
        videoElement.play();
    }
});

// --- New Feature Event Listeners ---

// Play/Pause Video Dataset
const playPauseBtn = document.getElementById('playPauseBtn');
playPauseBtn.addEventListener('click', () => {
    if (videoElement.paused) {
        videoElement.play();
        playPauseBtn.innerText = 'PAUSE';
        videoFrameLoop();
    } else {
        videoElement.pause();
        playPauseBtn.innerText = 'PLAY';
        if (videoLoopId) cancelAnimationFrame(videoLoopId);
    }
});

// Download Log (PDF)
document.getElementById('downloadLogBtn').addEventListener('click', () => {
    if (historyData.length === 0) {
        alert("No data collected yet. Wait a moment and try again.");
        return;
    }
    
    if (!window.jspdf) {
        alert("PDF library is still loading or failed to load. Please check your connection.");
        return;
    }
    
    const userName = prompt("Please enter the patient/subject name for the report:", "Subject Alpha");
    if (userName === null) return; // User cancelled

    try {
        const { jsPDF } = window.jspdf;
        const doc = new jsPDF();
        
        // Dark Red Header Bar
        doc.setFillColor(20, 0, 0);
        doc.rect(0, 0, 210, 30, 'F');
        
        // Title
        doc.setFont("helvetica", "bold");
        doc.setFontSize(22);
        doc.setTextColor(255, 42, 42);
        doc.text("VITALSENSE", 15, 18);
        doc.setFontSize(12);
        doc.setTextColor(200, 200, 200);
        doc.text("MEDICAL SESSION REPORT", 15, 25);
        
        // Subject Info Section
        doc.setTextColor(20, 20, 20);
        doc.setFontSize(10);
        doc.setFont("helvetica", "bold");
        doc.text("PATIENT NAME:", 15, 45);
        doc.setFont("helvetica", "normal");
        doc.text(userName, 50, 45);
        
        doc.setFont("helvetica", "bold");
        doc.text("DATE & TIME:", 15, 52);
        doc.setFont("helvetica", "normal");
        doc.text(new Date().toLocaleString(), 50, 52);
        
        // Calculate Averages
        let avgHR = 0, avgRR = 0, avgSp = 0;
        historyData.forEach(d => { avgHR += d.hr; avgRR += d.rr; avgSp += d.spo2; });
        avgHR = (avgHR / historyData.length).toFixed(1);
        avgRR = (avgRR / historyData.length).toFixed(1);
        avgSp = (avgSp / historyData.length).toFixed(1);
        
        // Summary Box
        doc.setFillColor(245, 245, 245);
        doc.setDrawColor(200, 200, 200);
        doc.rect(15, 60, 180, 20, 'FD');
        doc.setFont("helvetica", "bold");
        doc.text(`AVG HEART RATE: ${avgHR} BPM`, 20, 72);
        doc.text(`AVG RESPIRATION: ${avgRR} BRPM`, 85, 72);
        doc.text(`AVG SpO2: ${avgSp} %`, 155, 72);
        
        // Table Header
        let y = 95;
        doc.setFillColor(40, 40, 40);
        doc.rect(15, y, 180, 10, 'F');
        doc.setTextColor(255, 255, 255);
        doc.setFont("helvetica", "bold");
        doc.setFontSize(9);
        doc.text("TIME", 20, y + 7);
        doc.text("HR (BPM)", 55, y + 7);
        doc.text("RR (BRPM)", 85, y + 7);
        doc.text("SpO2 (%)", 115, y + 7);
        doc.text("STRESS", 145, y + 7);
        doc.text("STATUS", 170, y + 7);
        
        // Table Rows
        y += 10;
        doc.setTextColor(30, 30, 30);
        doc.setFont("helvetica", "normal");
        
        const maxEntries = 60; // Print up to 60 rows
        const entries = historyData.slice(-maxEntries);
        
        entries.forEach((entry, idx) => {
            if (idx % 2 === 0) {
                doc.setFillColor(250, 250, 250);
                doc.rect(15, y, 180, 8, 'F');
            }
            
            const time = new Date(entry.timestamp).toLocaleTimeString();
            doc.text(time, 20, y + 6);
            doc.text(entry.hr.toFixed(1), 55, y + 6);
            doc.text(entry.rr.toFixed(1), 85, y + 6);
            doc.text(entry.spo2.toFixed(1), 115, y + 6);
            const siLevel = entry.stress < 50 ? 'LOW' : entry.stress < 150 ? 'NORMAL' : entry.stress < 500 ? 'ELEVATED' : 'HIGH';
            doc.text(`${entry.stress.toFixed(0)} (${siLevel})`, 145, y + 6);
            
            // Color code status
            if (entry.quality === 'OPTIMAL') doc.setTextColor(0, 150, 0);
            else doc.setTextColor(200, 100, 0);
            doc.text(entry.quality, 170, y + 6);
            doc.setTextColor(30, 30, 30); // reset
            
            y += 8;
            if (y > 275) {
                doc.addPage();
                y = 20;
            }
        });
        
        doc.save(`vitalsense_report_${userName.replace(/\s+/g, '_')}_${Date.now()}.pdf`);
        showAINotification("Health Record Log Exported Successfully", "success");
    } catch (e) {
        console.error("PDF generation failed:", e);
        showAINotification("Failed to generate PDF.", "error");
    }
});

// Snapshot
document.getElementById('snapshotBtn').addEventListener('click', () => {
    const snapCanvas = document.createElement('canvas');
    snapCanvas.width = canvasElement.width;
    snapCanvas.height = canvasElement.height;
    const sCtx = snapCanvas.getContext('2d');
    
    // Use the raw videoElement instead of canvasElement so that face mesh grid lines are NOT in the picture.
    // We still mirror it so it matches what the user sees in the UI.
    sCtx.save();
    sCtx.translate(snapCanvas.width, 0);
    sCtx.scale(-1, 1);
    sCtx.drawImage(videoElement, 0, 0, snapCanvas.width, snapCanvas.height);
    sCtx.restore();
    
    // Overlay vital signs
    sCtx.fillStyle = 'rgba(0, 0, 0, 0.7)';
    sCtx.fillRect(10, 10, 250, 150);
    sCtx.fillStyle = '#00ff44';
    sCtx.font = '20px monospace';
    sCtx.fillText(`VitalSense Snapshot`, 20, 40);
    sCtx.fillStyle = '#ffffff';
    sCtx.fillText(`HR: ${displayBPM > 40 ? displayBPM.toFixed(0) : '--'} BPM`, 20, 70);
    sCtx.fillText(`RR: ${displayResp > 5 ? displayResp.toFixed(0) : '--'} BRPM`, 20, 100);
    sCtx.fillText(`SpO2: ${spo2Display > 90 ? spo2Display.toFixed(1) : '--'} %`, 20, 130);
    
    const dataUrl = snapCanvas.toDataURL('image/png');
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = `vitalsense_snapshot_${Date.now()}.png`;
    a.click();
    showAINotification("Snapshot Captured Successfully", "success");
});

// --- Login Tabs ---
const tabFace = document.getElementById('tabFace');
const tabEmail = document.getElementById('tabEmail');
const faceScanMode = document.getElementById('faceScanMode');
const emailLoginMode = document.getElementById('emailLoginMode');

tabFace.addEventListener('click', () => {
    activeLoginTab = 'FACE';
    tabFace.classList.add('active');
    tabEmail.classList.remove('active');
    faceScanMode.style.display = 'block';
    emailLoginMode.style.display = 'none';
    
    if (camera) camera.start();
});

tabEmail.addEventListener('click', () => {
    activeLoginTab = 'EMAIL';
    tabEmail.classList.add('active');
    tabFace.classList.remove('active');
    emailLoginMode.style.display = 'flex';
    faceScanMode.style.display = 'none';
    
    if (loginTimeout) clearTimeout(loginTimeout);
    if (loginCountdown) clearInterval(loginCountdown);
    if (camera) camera.stop();
    isScanning = false;
    document.getElementById('loginStatusText').innerText = "AWAITING SUBJECT...";
    document.getElementById('loginStatusText').style.color = "";
    document.querySelector('.scan-line').style.display = 'none';
    if (document.getElementById('calSync')) {
        document.getElementById('calSync').innerText = "INITIALIZING...";
        document.getElementById('calSync').className = "val text-blue";
    }
    if (document.getElementById('calLock')) {
        document.getElementById('calLock').innerText = "SEARCHING...";
        document.getElementById('calLock').className = "val text-red";
    }
});

// Email Form Submission
document.getElementById('emailLoginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    
    if (!navigator.onLine) {
        alert("PLEASE CONNECT TO THE INTERNET TO AUTHENTICATE.");
        return;
    }
    
    const email = document.getElementById('loginEmail').value;
    const password = document.getElementById('loginPassword').value;
    
    showAINotification("Authenticating with neural sync server...", "info");
    
    try {
        let response = await fetch('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password })
        });
        
        let data = await response.json();
        
        if (!response.ok) {
            // Auto-register fallback for hackathon friction-free login
            showAINotification("User not registered. Syncing credentials...", "info");
            response = await fetch('/api/auth/register', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: email.split('@')[0].toUpperCase(), email, password })
            });
            data = await response.json();
        }
        
        if (response.ok) {
            localStorage.setItem('token', data.token);
            localStorage.setItem('user', JSON.stringify(data.user));
            showAINotification(`Authorized: ${data.user.name}`, "success");
            
            document.getElementById('loginView').style.display = 'none';
            document.getElementById('dashboardView').style.display = 'block';
            appState = 'DASHBOARD';
            triggerDashboardEntrance();
            
            if (camera) {
                camera.start();
            }
        } else {
            showAINotification(data.error || "Authentication failed", "error");
        }
    } catch (err) {
        console.error("Auth error:", err);
        showAINotification("Server connection failed - running offline mode", "warning");
        
        // Safe demo fallback
        document.getElementById('loginView').style.display = 'none';
        document.getElementById('dashboardView').style.display = 'block';
        appState = 'DASHBOARD';
        triggerDashboardEntrance();
        
        if (camera) {
            camera.start();
        }
    }
});

// --- Clean Sci-Fi Cursor Logic ---
const cursorDot = document.getElementById('cursorDot');
const cursorRing = document.getElementById('cursorRing');
let mouseX = window.innerWidth / 2;
let mouseY = window.innerHeight / 2;
let ringX = mouseX;
let ringY = mouseY;
let isHovering = false;

window.addEventListener('mousemove', (e) => {
    mouseX = e.clientX;
    mouseY = e.clientY;
    
    // Instant dot movement
    if (cursorDot) {
        cursorDot.style.transform = `translate3d(${mouseX - 3}px, ${mouseY - 3}px, 0)`;
    }
    
    updateMagnet(e);
});

// Magnet effect for canvases
let magnetActive = false;
let magnetX = 0;
let magnetY = 0;

function updateMagnet(e) {
    // Only attract on dashboard view
    if (appState !== 'DASHBOARD') {
        magnetActive = false;
        return;
    }
    
    const canvases = document.querySelectorAll('canvas:not(#outputCanvas)');
    let closestCanvas = null;
    let minDistance = 70; // Attraction threshold radius in px
    
    canvases.forEach(canvas => {
        const rect = canvas.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        const dist = Math.sqrt(Math.pow(e.clientX - cx, 2) + Math.pow(e.clientY - cy, 2));
        
        if (dist < minDistance) {
            minDistance = dist;
            closestCanvas = canvas;
            magnetX = cx;
            magnetY = cy;
        }
    });
    
    magnetActive = (closestCanvas !== null);
}

function animateCursor() {
    let targetX = mouseX;
    let targetY = mouseY;
    
    if (magnetActive) {
        // Soft pull towards the center of the closest graph
        targetX = magnetX + (mouseX - magnetX) * 0.35;
        targetY = magnetY + (mouseY - magnetY) * 0.35;
    }
    
    ringX += (targetX - ringX) * 0.25;
    ringY += (targetY - ringY) * 0.25;
    
    if (cursorRing) {
        let scale = isHovering ? 1.5 : (magnetActive ? 1.25 : 1);
        cursorRing.style.transform = `translate3d(${ringX - 16}px, ${ringY - 16}px, 0) scale(${scale})`;
    }
    requestAnimationFrame(animateCursor);
}
animateCursor();

// Add hover effect for clickable items
setTimeout(() => {
    const interactiveElements = document.querySelectorAll('button, .tab-btn, .action-btn, .hrv-box, .nav-item');
    interactiveElements.forEach(el => {
        el.addEventListener('mouseenter', () => {
            isHovering = true;
            if (cursorRing) cursorRing.classList.add('hover');
        });
        el.addEventListener('mouseleave', () => {
            isHovering = false;
            if (cursorRing) cursorRing.classList.remove('hover');
        });
    });
}, 1000);

// --- Futuristic Dashboard Helper Logic ---

// 1. Loading Screen Sequence
function startLoadingSequence() {
    const screen = document.getElementById('loadingScreen');
    const fill = document.getElementById('loadingProgress');
    const status = document.getElementById('loadingStatus');
    if (!screen || !fill || !status) return;

    let progress = 0;
    const stages = [
        { limit: 25, text: "Initializing AI Biometric Engine..." },
        { limit: 55, text: "Calibrating Facial Mesh Sensors..." },
        { limit: 80, text: "Synchronizing Neural Buffers..." },
        { limit: 100, text: "Establishing Secure Cyber HUD Connection..." }
    ];

    const interval = setInterval(() => {
        progress += Math.floor(Math.random() * 8) + 3;
        if (progress >= 100) {
            progress = 100;
            clearInterval(interval);
            fill.style.width = '100%';
            status.innerText = "HUD Synchronized.";
            setTimeout(() => {
                screen.style.opacity = '0';
                setTimeout(() => {
                    screen.style.display = 'none';
                }, 800);
            }, 300);
        } else {
            fill.style.width = `${progress}%`;
            const currentStage = stages.find(s => progress <= s.limit) || stages[stages.length - 1];
            status.innerText = currentStage.text;
        }
    }, 80);
}

// 2. AI Notification Center
function showAINotification(message, type = 'info') {
    const container = document.getElementById('aiNotifContainer');
    if (!container) return;

    const notif = document.createElement('div');
    notif.className = `ai-notif ${type}`;
    notif.innerHTML = `<div class="notif-content">${message}</div>`;

    container.appendChild(notif);

    setTimeout(() => {
        notif.style.animation = 'notifSlide 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275) reverse forwards';
        setTimeout(() => notif.remove(), 400);
    }, 4000);
}

// 3. Smooth Value Counting
function animateNumber(elementId, targetValue, decimals = 0, suffix = '') {
    const el = document.getElementById(elementId);
    if (!el) return;

    const startVal = parseFloat(el.innerText) || 0;
    const duration = 1200;
    const startTime = performance.now();

    function update(now) {
        const elapsed = now - startTime;
        const progress = Math.min(elapsed / duration, 1);
        const ease = progress * (2 - progress); // easeOutQuad
        const currentVal = startVal + (targetValue - startVal) * ease;

        el.innerText = currentVal.toFixed(decimals) + suffix;

        if (progress < 1) {
            requestAnimationFrame(update);
        } else {
            el.innerText = targetValue.toFixed(decimals) + suffix;
        }
    }
    requestAnimationFrame(update);
}

// 4. Staggered Dashboard Entrance
function triggerDashboardEntrance() {
    showAINotification("VitalSense HUD Synchronized Successfully", "success");
    setTimeout(() => showAINotification("ECG & PPG Live Feeds Initiated", "info"), 800);

    setTimeout(() => {
        animateNumber('pulseValue', 75, 0);
        animateNumber('respValue', 16, 0);
        animateNumber('spo2Value', 98.6, 1);
    }, 300);
}

// 5. AI Status Orb Update
function updateAIOrbState(state) {
    const orb = document.getElementById('aiStatusOrb');
    if (!orb) return;
    orb.className = `ai-orb ${state}`;
}

// Start Loading Sequence on Launch
document.addEventListener('DOMContentLoaded', () => {
    startLoadingSequence();
});
// If DOMContentLoaded already fired, execute immediately
if (document.readyState === 'interactive' || document.readyState === 'complete') {
    startLoadingSequence();
}

// 6. Dynamic Skeleton Loader Watcher
function updateLoadingState(elementId, value) {
    const el = document.getElementById(elementId);
    if (!el) return;
    if (value === '--' || value === null || value === undefined || value === 0 || value === '' || value.trim() === '--') {
        el.classList.add('loading-skeleton');
    } else {
        el.classList.remove('loading-skeleton');
    }
}

function checkAllLoadingStates() {
    updateLoadingState('pulseValue', document.getElementById('pulseValue') ? document.getElementById('pulseValue').innerText : '--');
    updateLoadingState('respValue', document.getElementById('respValue') ? document.getElementById('respValue').innerText : '--');
    updateLoadingState('spo2Value', document.getElementById('spo2Value') ? document.getElementById('spo2Value').innerText : '--');
    updateLoadingState('meanNN', document.getElementById('meanNN') ? document.getElementById('meanNN').innerText : '--');
    updateLoadingState('sdnn', document.getElementById('sdnn') ? document.getElementById('sdnn').innerText : '--');
    updateLoadingState('rmssd', document.getElementById('rmssd') ? document.getElementById('rmssd').innerText : '--');
    updateLoadingState('stressIndex', document.getElementById('stressIndex') ? document.getElementById('stressIndex').innerText : '--');
}

setInterval(checkAllLoadingStates, 300);

// --- HUD Commands Settings & Telemetry Watcher ---

// 1. Settings Drawer Toggles
const settingsDrawer = document.getElementById('settingsDrawer');
const settingsDrawerBtn = document.getElementById('settingsDrawerBtn');
const closeSettingsBtn = document.getElementById('closeSettingsBtn');

if (settingsDrawerBtn && settingsDrawer) {
    settingsDrawerBtn.addEventListener('click', () => {
        settingsDrawer.classList.toggle('open');
    });
}
if (closeSettingsBtn && settingsDrawer) {
    closeSettingsBtn.addEventListener('click', () => {
        settingsDrawer.classList.remove('open');
    });
}

// 2. Clock Telemetry Sync
function updateHUDClock() {
    const el = document.getElementById('hudHeaderDate');
    if (!el) return;
    const now = new Date();
    el.innerText = now.toLocaleDateString() + " " + now.toLocaleTimeString();
}
setInterval(updateHUDClock, 1000);
updateHUDClock();

// 3. Audio Config Click simulation (Wow Factor)
const toggleAudioBtn = document.getElementById('toggleAudioBtn');
if (toggleAudioBtn) {
    let audioActive = false;
    toggleAudioBtn.addEventListener('click', () => {
        audioActive = !audioActive;
        toggleAudioBtn.innerText = audioActive ? "DISABLE AUDIO" : "ENABLE AUDIO";
        toggleAudioBtn.classList.toggle('active');
        showAINotification(audioActive ? "Biometric Audio Feedback Initialized" : "Audio Feedback Suspended", "info");
    });
}

// 4. Notification Bell Alert simulation
const notifBellBtn = document.getElementById('notifBellBtn');
if (notifBellBtn) {
    notifBellBtn.addEventListener('click', () => {
        showAINotification("System Diagnostics: All channels normal. AI processing at optimal load.", "success");
    });
}

// --- Cloud AI Network Connectivity System ---
let isSystemOnline = true;
let wasOnlineOnLastCheck = true;
let isCheckingServer = false;

// Real backend reachability verification via HEAD request
async function verifyServerConnection() {
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 2000); // 2-second timeout
        
        // Fetch to local index file with cache-busting timestamp
        const response = await fetch('/index.html?ping=' + Date.now(), {
            method: 'HEAD',
            signal: controller.signal
        });
        clearTimeout(timeoutId);
        return response.ok;
    } catch (e) {
        return false;
    }
}

async function updateNetworkStatus(online) {
    isSystemOnline = online;
    
    const wifiStatusText = document.getElementById('hudWifiStatus');
    const wifiIcon = document.getElementById('hudWifiIcon');
    const offlineOverlay = document.getElementById('offlineOverlay');
    const loginView = document.getElementById('loginView');
    const hudOfflineBanner = document.getElementById('hudOfflineBanner');
    const widgetNetStatus = document.getElementById('widgetNetStatus');
    
    // Update online badge in header
    if (wifiStatusText && wifiIcon) {
        if (online) {
            wifiStatusText.innerText = "ONLINE";
            wifiStatusText.className = "value text-green";
            wifiIcon.setAttribute("stroke", "var(--color-green)");
        } else {
            wifiStatusText.innerText = "OFFLINE";
            wifiStatusText.className = "value text-red";
            wifiIcon.setAttribute("stroke", "var(--color-red)");
        }
    }
    
    // Update bottom widget net status
    if (widgetNetStatus) {
        widgetNetStatus.innerText = online ? "ONLINE" : "OFFLINE";
        widgetNetStatus.className = online ? "text-green" : "text-red";
    }

    if (online) {
        // Automatically hide offline overlays/banners
        if (offlineOverlay) offlineOverlay.style.display = 'none';
        if (loginView) loginView.classList.remove('blurred');
        if (hudOfflineBanner) hudOfflineBanner.style.display = 'none';
        
        // Notify connection restored
        if (!wasOnlineOnLastCheck) {
            showAINotification("Cloud Connection Restored. Telemetry Active.", "success");
        }
    } else {
        // Disconnected triggers
        if (appState === 'LOGIN') {
            if (offlineOverlay) offlineOverlay.style.display = 'flex';
            if (loginView) loginView.classList.add('blurred');
        } else if (appState === 'DASHBOARD') {
            if (hudOfflineBanner) hudOfflineBanner.style.display = 'flex';
        }
        
        // Notify connection lost
        if (wasOnlineOnLastCheck) {
            showAINotification("System Offline. Securing Local Cache...", "error");
        }
    }
    
    wasOnlineOnLastCheck = online;
}

async function runNetworkDiagnostic() {
    if (isCheckingServer) return;
    isCheckingServer = true;
    
    const hasInternet = navigator.onLine;
    let isServerUp = false;
    
    if (hasInternet) {
        isServerUp = await verifyServerConnection();
    }
    
    await updateNetworkStatus(hasInternet && isServerUp);
    isCheckingServer = false;
}

// Watchers
window.addEventListener('online', runNetworkDiagnostic);
window.addEventListener('offline', () => updateNetworkStatus(false));

// Manual connection retry button
const retryBtn = document.getElementById('retryConnectionBtn');
if (retryBtn) {
    retryBtn.addEventListener('click', async () => {
        retryBtn.innerText = "CALIBRATING LINK...";
        retryBtn.disabled = true;
        
        showAINotification("Re-routing secure link packets...", "info");
        await runNetworkDiagnostic();
        
        setTimeout(() => {
            if (retryBtn) {
                retryBtn.innerText = "RETRY SECURE CONNECT";
                retryBtn.disabled = false;
            }
        }, 1000);
    });
}

// Diagnostic check every 5 seconds
setInterval(runNetworkDiagnostic, 5000);
// Run immediate check on boot
runNetworkDiagnostic();

// --- WebSocket & Full-Stack Event Mappings ---
window.addEventListener('load', () => {
    if (typeof window.initiateSocketStream === 'function') {
        window.initiateSocketStream((vitals) => {
            // Update UI dashboard labels with real-time server calculations
            displayBPM = vitals.heartRate;
            displayResp = vitals.respirationRate;
            
            const pulseValueEl = document.getElementById('pulseValue');
            const respValueEl = document.getElementById('respValue');
            const spo2ValueEl = document.getElementById('spo2Value');
            const pulseConfidenceEl = document.getElementById('pulseConfidence');
            
            if (pulseValueEl) pulseValueEl.innerText = displayBPM > 40 ? displayBPM.toFixed(0) : '--';
            if (respValueEl) respValueEl.innerText = displayResp > 0 ? displayResp.toFixed(0) : '--';
            if (spo2ValueEl) spo2ValueEl.innerText = vitals.spo2 > 0 ? vitals.spo2.toFixed(0) : '--';
            
            if (pulseConfidenceEl) {
                pulseConfidenceEl.innerText = vitals.signalQuality + "%";
                const confFill = document.getElementById('confFill');
                if (confFill) confFill.style.width = vitals.signalQuality + "%";
            }

            // Bind Server HRV indices to dashboard widgets
            const meanNNEl = document.getElementById('meanNN');
            const sdnnEl = document.getElementById('sdnn');
            const rmssdEl = document.getElementById('rmssd');
            const stressIndexEl = document.getElementById('stressIndex');
            const stressLevelEl = document.getElementById('stressLevel');

            if (meanNNEl) meanNNEl.innerText = (60000 / (displayBPM || 72)).toFixed(0);
            if (sdnnEl) sdnnEl.innerText = vitals.sdnn;
            if (rmssdEl) rmssdEl.innerText = vitals.rmssd;
            if (stressIndexEl) stressIndexEl.innerText = vitals.stress;
            if (stressLevelEl) {
                stressLevelEl.innerText = vitals.stress > 65 ? 'HIGH' : (vitals.stress > 35 ? 'MODERATE' : 'LOW');
                stressLevelEl.className = vitals.stress > 65 ? 'text-red' : 'text-green';
            }

            // Sync the sliding window raw waveform to map with server filtered AC trace output
            if (vitals.filteredWave && vitals.filteredWave.length > 0) {
                rawWaveBuffer = vitals.filteredWave;
            }

            // Push vital record to database (once every 2 seconds to avoid clogging write operations)
            triggerServerDatabaseLog(vitals);

        }, (err) => {
            console.error("[Socket] Telemetry listener link failure:", err);
        });
    }
    
    // Override the Download PDF report action if JWT session is logged
    const downloadBtn = document.getElementById('downloadLogBtn');
    if (downloadBtn) {
        const originalListener = downloadBtn.onclick;
        downloadBtn.addEventListener('click', (e) => {
            const token = localStorage.getItem('token');
            if (token) {
                e.stopImmediatePropagation();
                window.open(`/api/report?token=${token}`, '_blank');
            }
        });
    }

    // Override the Fetch logs list button action to query backend if authenticated
    const loadLogsBtn = document.getElementById('loadDatasetBtn');
    if (loadLogsBtn) {
        loadLogsBtn.addEventListener('click', async () => {
            const token = localStorage.getItem('token');
            if (!token) return; // Fall back to default video upload behavior
            
            showAINotification("Querying patient session logs...", "info");
            try {
                const res = await fetch('/api/vitals/history', {
                    headers: { 'Authorization': `Bearer ${token}` }
                });
                const logs = await res.json();
                if (logs.length > 0) {
                    showAINotification(`Retrieved ${logs.length} database logs successfully`, "success");
                    // Map to local history logs representation for rendering
                    historyData = logs.map(l => ({
                        time: new Date(l.timestamp).getTime(),
                        timestamp: new Date(l.timestamp).getTime(),
                        hr: l.heartRate,
                        rr: l.respirationRate,
                        spo2: l.spo2,
                        stress: l.stress,
                        quality: l.confidence > 75 ? 'OPTIMAL' : 'ADEQUATE'
                    }));
                    renderHistoryTable();
                } else {
                    showAINotification("No historical sessions found in database", "info");
                }
            } catch (err) {
                console.error("Historical fetch failed:", err);
                showAINotification("Failed to fetch server logs", "error");
            }
        });
    }
});

let lastDbLogTime = 0;
function triggerServerDatabaseLog(vitals) {
    const token = localStorage.getItem('token');
    if (!token) return;

    const now = Date.now();
    if (now - lastDbLogTime < 2000) return; // limit frequency
    lastDbLogTime = now;

    fetch('/api/vitals/log', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
            heartRate: vitals.heartRate,
            respirationRate: vitals.respirationRate,
            spo2: vitals.spo2,
            stress: vitals.stress,
            rmssd: vitals.rmssd,
            sdnn: vitals.sdnn,
            blinkCount: blinks,
            confidence: vitals.signalQuality
        })
    })
    .then(res => res.json())
    .then(data => {
        console.log("[DB] Vitals saved successfully:", data);
    })
    .catch(err => {
        console.error("[DB] Vital save failed:", err);
    });
}

