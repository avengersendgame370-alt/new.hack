# VitalSense AI — Contactless Health Monitoring Platform

VitalSense AI is a premium, full-stack healthcare prototype inspired by cyber HUD styles. It uses a standard webcam to extract physiological signals contactlessly via remote photoplethysmography (rPPG) — reading subtle, invisible color changes in facial skin caused by blood flow — plus real-time facial-landmark tracking, and streams them over a Node.js + Express + Socket.IO + MongoDB backend.

---

## Technical Architecture

```text
               +----------------------------------------+
               |                CLIENT                  |
               |  (MediaPipe FaceMesh, HTML5 Canvas)     |
               +-------------------+--------------------+
                                   |
                       Frame Average RGB Signals
                      (WebSockets: stream_frame_data)
                                   v
               +-------------------+--------------------+
               |                SERVER                  |
               | (Detrending, Moving Avg, DFT Engine)   |
               +---------+--------------------+---------+
                         |                    |
                         |                    |
                  Vitals telemetry     Session persistence
                 (vitals_update)       (MongoDB Atlas)
                         |                    |
                         v                    v
               +---------+---------+   +------+------+
               |      DASHBOARD    |   | VitalLog DB |
               +-------------------+   +-------------+
```

---

## Folder Structure

```text
vitalsense-project/
├── backend/
│   ├── config/
│   │   └── db.js              # Database connection pool helper
│   ├── controllers/
│   │   ├── authController.js   # JWT & bcrypt User accounts transactions
│   │   ├── vitalController.js  # Telemetry logger endpoints
│   │   └── reportController.js # PDF compilation controller using PDFKit
│   ├── models/
│   │   ├── User.js            # User mongoose schema
│   │   └── VitalLog.js        # Health log schema
│   ├── services/
│   │   └── signalProcessor.js # DFT mathematical frequency analyzer
│   ├── routes/
│   │   └── api.js             # Router mapping file
│   ├── socket/
│   │   └── streamHandler.js   # Client buffer & WS streaming manager
│   ├── .env                   # Configuration keys
│   ├── package.json           # Server dependencies list
│   └── server.js              # Server entry point
├── frontend/
│   ├── css/
│   │   └── style.css          # Cyber HUD visual layouts
│   ├── js/
│   │   ├── socket-client.js   # Socket communication listeners
│   │   └── app.js             # WebRTC video frame tracking
│   ├── index.html             # UI Dashboard structure
│   └── package.json           # Frontend server configurations
└── README.md
```

---

## Getting Started

### Prerequisites
- Node.js (v16+)
- MongoDB (Running locally on `mongodb://127.0.0.1:27017/vitalsense` or a MongoDB Atlas URI)

### Setup & Run
1. **Clone the directory** and open your terminal inside it.
2. **Start the Backend Server**:
   ```bash
   cd backend
   npm install
   npm start
   ```
   The backend will start listening on port `5000`.

3. **Start the Frontend Client**:
   Open a separate terminal window at the project root and run:
   ```bash
   cd frontend
   npm install
   npm start
   ```
   The client will serve index.html locally on port `8000`. Open `http://localhost:8000` in Chrome or Edge.

---

## API Endpoints

- `POST /api/auth/register` - Create user credentials and returns JWT session
- `POST /api/auth/login` - Validate user credentials and returns JWT session
- `POST /api/vitals/log` - Store a vital signs log record (Protected)
- `GET /api/vitals/history` - Retrieve historical session telemetry entries (Protected)
- `GET /api/vitals/latest` - Retrieve most recent vital sign log (Protected)
- `GET /api/report?token=<JWT>` - Download clinical report PDF (Protected)
