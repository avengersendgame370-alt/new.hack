# VitalSense Monitor

VitalSense is a working software prototype of a camera-based vital signs and cognitive/behavioral state monitor. It uses a standard webcam to extract physiological signals contactlessly via remote photoplethysmography (rPPG) — reading subtle, invisible color changes in facial skin caused by blood flow — plus real-time facial-landmark tracking. All processing runs entirely client-side in the browser; no video or biometric data is uploaded or stored anywhere.

## Features
- **Calibration screen**: on launch, the camera scans for a face and runs a short initialization sequence before entering the main dashboard.
- **Live camera feed** with real-time face-mesh overlay and region-of-interest (ROI) boxes.
- **Pulse rate** (50–120 BPM) and **breathing rate** (10–30 BrPM), each with a live confidence score.
- **Arterial pressure waveform** (relative morphology, not calibrated blood pressure).
- **HRV metrics**: Mean NN, RMSSD, SDNN, and a simplified Baevsky Stress Index.
- **Face analysis**: rolling 60-second blink rate, talking detection, and a smile/engagement cue.
- **Composite Cognitive & Behavioral State**: fuses heart rate, HRV, breathing rate, blink rate, and talking/expression cues into one live label — `CALM / BASELINE`, `ELEVATED STRESS`, `FATIGUED / DROWSY`, or `ACTIVE / ENGAGED` — instead of requiring the viewer to interpret five separate numbers.
- **Video dataset fallback**: a pre-recorded video file can be loaded and run through the exact same pipeline, as a backup if live webcam conditions are poor.
- **Clinical dashboard UI** with a phosphor-red sci-fi theme.

## Setup Instructions
This is a plain HTML/CSS/JS application with no build step required. To run it:
1. Open a terminal in this directory (`VitalSense`).
2. Run a local HTTP server. For example:
   ```bash
   python3 -m http.server
   ```
3. Open a browser (Chrome/Edge recommended) and go to `http://localhost:8000`.
4. Grant camera permissions when prompted.

## Algorithm Explanation
1. **Face Tracking**: MediaPipe Face Mesh (Google, loaded via CDN) tracks 468 facial landmarks in real time. This is the only pre-trained model in the pipeline — everything downstream is hand-written signal processing and rule-based logic.
2. **rPPG Signal Extraction**: The app isolates small ROIs on the forehead and both cheeks and extracts the mean green-channel pixel value across each, per frame. Green light is absorbed strongly by hemoglobin, so these fluctuations correlate with pulsatile blood volume.
3. **Signal Processing**:
   - Two moving averages (short window for pulse, longer window for breathing) are subtracted to detrend the signal and remove slow lighting drift.
   - A discrete-frequency (Goertzel-style) scan searches the pulse band (0.83–2.0 Hz → 50–120 BPM) and breathing band (0.16–0.5 Hz → 10–30 BrPM) for the dominant frequency, with a 1/f power correction applied to suppress low-frequency motion artifacts.
   - A confidence score is derived from the signal-to-noise ratio (peak power vs. average noise floor) in the frequency domain. Readings below a minimum confidence threshold are hidden rather than shown as unreliable numbers.
4. **HRV & Peak Detection**: Local maxima are detected on a smoothed pulse waveform to calculate beat-to-beat (NN) intervals, used to calculate Mean NN, SDNN, RMSSD, and an approximate Baevsky Stress Index.
5. **Face Analysis**: Eye Aspect Ratio (EAR) drives blink detection; Mouth Aspect Ratio (MAR) variance drives talking detection; landmark-distance ratios drive a simple smile/engagement cue.
6. **Composite State Engine**: A rule-based fusion layer combines BPM, HRV (RMSSD, Stress Index), breathing rate, blink rate, and talking/expression signals into a single interpretable state label, updated live.

## Known Limitations (CRITICAL)
- **Accuracy degrades with movement**: Sitting still gives the best signal. Talking or shifting introduces motion artifacts that can overwhelm the subtle rPPG signal.
- **Lighting dependent**: Poor, flickering, or uneven lighting will degrade signal quality significantly.
- **Relative arterial waveform**: The displayed arterial pressure waveform shows relative morphology only. It is **not** a calibrated blood-pressure measurement (mmHg).
- **Approximated Stress Index**: The Baevsky Stress Index calculation uses a simplified distribution model for demonstration purposes, not the full clinical method.
- **Composite state is a heuristic, not a diagnosis**: The Cognitive & Behavioral State label is produced by fixed rule-based thresholds on the metrics above. It is a demonstrative fusion of signals, not a clinically validated assessment of stress, fatigue, or emotion.
- **Calibration is an initialization sequence**: The startup scan detects a face and runs a timed sequence before entering the dashboard; it is not a biometric authentication or identity-verification system.
- **Not a medical device**: This is an educational hackathon prototype, not a certified medical device. It should never be used for diagnosis or monitoring of real health conditions.
"# hack.pro" 
"# hack.pro" 
