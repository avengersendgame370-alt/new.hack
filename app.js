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
let isScanning = false;
let blinkTimestamps = [];
let displayStressIndex = 0;
let displayRMSSD = 0;

// Bypass button
document.getElementById('bypassBtn').addEventListener('click', () => {
    document.getElementById('loginView').style.display = 'none';
    document.getElementById('dashboardView').style.display = 'block';
    appState = 'DASHBOARD';
});

const BUFFER_SIZE = 900; // ~30 seconds at 30fps

// App logic
function updateStatus(msg, isError = false) {
    const el = document.getElementById('appStatus');
    el.innerText = msg;
    el.className = 'status-bar ' + (isError ? 'error' : 'active');

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
    for (let i = 0; i < imgData.data.length; i += 4) {
        sumG += imgData.data[i + 1]; // Green channel (most robust for basic webcams)
    }
    return sumG / (size * size);
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
    let rgb = color === '#00aaff' ? '0,170,255' : 
              color === '#00ff44' ? '0,255,68' : '255,179,71';
    gradient.addColorStop(0, `rgba(${rgb}, 0.3)`);
    gradient.addColorStop(1, `rgba(${rgb}, 0.0)`);

    // Draw Fill
    ctx.beginPath();
    ctx.fillStyle = gradient;
    let padding = canvas.height * 0.1;
    let drawHeight = canvas.height * 0.8;
    
    for (let i = 0; i < data.length; i++) {
        let x = (i / (data.length - 1)) * canvas.width;
        let y = padding + drawHeight - ((data[i] - min) / range) * drawHeight;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
    }
    ctx.lineTo(canvas.width, canvas.height);
    ctx.lineTo(0, canvas.height);
    ctx.fill();

    // Draw Stroke
    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.5;
    for (let i = 0; i < data.length; i++) {
        let x = (i / (data.length - 1)) * canvas.width;
        let y = padding + drawHeight - ((data[i] - min) / range) * drawHeight;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
    }
    ctx.stroke();
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

    // Confidence Floor for UI
    if (confidence >= 5) {
        document.getElementById('pulseValue').innerText = displayBPM > 40 ? displayBPM.toFixed(0) : '--';
        document.getElementById('respValue').innerText = displayResp > 5 ? displayResp.toFixed(0) : '--';
    } else {
        document.getElementById('pulseValue').innerText = '--';
        document.getElementById('respValue').innerText = '--';
    }

    // Waveform rendering
    drawWaveform(document.getElementById('arterialCanvas').getContext('2d'), document.getElementById('arterialCanvas'), smoothedPulse.slice(-150), '#00aaff');
    drawWaveform(document.getElementById('pulseCanvas').getContext('2d'), document.getElementById('pulseCanvas'), smoothedPulse.slice(-60), '#00aaff');
    drawWaveform(document.getElementById('respCanvas').getContext('2d'), document.getElementById('respCanvas'), respDetrended.slice(-300), '#00ff44');
    
    // Draw mini decorative waves for HRV
    drawMiniWave('mnnCanvas', '#00aaff');
    drawMiniWave('sdnnCanvas', '#00ff44');
    drawMiniWave('rmssdCanvas', '#00aaff');
    drawMiniWave('stressCanvas', '#00ff44');

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
                    if (nnIntervals.length > 60) nnIntervals.shift(); 
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
    if (si) document.getElementById('stressIndex').innerText = si.toFixed(0);
}

// --- Decorative Sci-Fi Drawing Functions ---
function drawMiniWave(canvasId, color) {
    const canvas = document.getElementById(canvasId);
    if(!canvas) return;
    const ctx = canvas.getContext('2d');
    canvas.width = canvas.offsetWidth;
    canvas.height = canvas.offsetHeight;
    ctx.clearRect(0,0,canvas.width,canvas.height);
    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    let time = performance.now() / 1000;
    for(let i=0; i<canvas.width; i+=2) {
        let y = canvas.height/2 + Math.sin(i*0.1 + time)*5 * Math.random();
        if(i===0) ctx.moveTo(i,y); else ctx.lineTo(i,y);
    }
    ctx.stroke();
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
            
            if (!isScanning) {
                isScanning = true;
                const statusEl = document.getElementById('loginStatusText');
                statusEl.innerText = "FACE DETECTED. ESTABLISHING BASELINE...";
                document.querySelector('.scan-line').style.display = 'block';
                
                // Update new aesthetic data readouts
                if (document.getElementById('calSync')) document.getElementById('calSync').innerText = "SYNCING...";
                if (document.getElementById('calLock')) document.getElementById('calLock').innerText = "ACQUIRING...";
                
                setTimeout(() => {
                    statusEl.innerText = "BASELINE SECURED.";
                    statusEl.style.color = "#00ff44";
                    document.querySelector('.scan-line').style.display = 'none';
                    
                    if (document.getElementById('calSync')) {
                        document.getElementById('calSync').innerText = "SYNCED";
                        document.getElementById('calSync').className = "val text-green";
                    }
                    if (document.getElementById('calLock')) {
                        document.getElementById('calLock').innerText = "LOCKED";
                        document.getElementById('calLock').className = "val text-green";
                    }
                    
                    setTimeout(() => {
                        document.getElementById('loginView').style.opacity = '0';
                        setTimeout(() => {
                            document.getElementById('loginView').style.display = 'none';
                            document.getElementById('dashboardView').style.display = 'block';
                            appState = 'DASHBOARD';
                        }, 1000);
                    }, 1000);
                }, 2500);
            }
        } else if (!isScanning) {
            document.getElementById('loginStatusText').innerText = "AWAITING SUBJECT...";
        }
        lCtx.restore();
        return; 
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
        
        // Draw face mesh visibly (white triangles)
        drawConnectors(canvasCtx, landmarks, FACEMESH_TESSELATION, {color: 'rgba(255, 255, 255, 0.25)', lineWidth: 1});
        
        // Extract ROIs
        const width = canvasElement.width;
        const height = canvasElement.height;
        
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

        // Get Dual Channel (Green-minus-Red approx)
        const fhVal = extractROI(canvasCtx, fhX - roiSize/2, fhY - roiSize/2, roiSize);
        const lcVal = extractROI(canvasCtx, lcX - roiSize/2, lcY - roiSize/2, roiSize);
        const rcVal = extractROI(canvasCtx, rcX - roiSize/2, rcY - roiSize/2, roiSize);
        
        let avgVal = (fhVal + lcVal + rcVal) / 3;
        
        if (signalBuffer.length > BUFFER_SIZE) {
            signalBuffer.shift();
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
        timeBuffer.push(performance.now());
        
        if (signalBuffer.length > BUFFER_SIZE) {
            signalBuffer.shift();
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

        processSignals();
    } else {
        updateStatus("NO FACE DETECTED", true);
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
    minDetectionConfidence: 0.5,
    minTrackingConfidence: 0.5
});

faceMesh.onResults((results) => {
    isFaceMeshReady = true;
    onResults(results);
});

// Setup Camera
const camera = new Camera(videoElement, {
    onFrame: async () => {
        await faceMesh.send({image: videoElement});
    },
    width: 640,
    height: 480
});

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

// Start
updateStatus("REQUESTING CAMERA...");
camera.start().then(() => {
    updateStatus("CAMERA ACTIVE. WARMING UP AI...");
    rawVideoLoop();
}).catch(err => {
    console.error(err);
    updateStatus("CAMERA PERMISSION DENIED OR ERROR", true);
});

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
        
        videoElement.play();
    }
});
