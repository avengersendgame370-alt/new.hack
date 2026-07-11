require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const path = require('path');
const connectDB = require('./config/db');
const apiRoutes = require('./routes/api');
const streamHandler = require('./socket/streamHandler');

// Connect to Database
connectDB();

const app = express();
const server = http.createServer(app);

// Enable CORS for API routes
app.use(cors({
    origin: '*', // In production, replace with specific frontend client domain URL
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

// Expose API routes
app.use('/api', apiRoutes);

// Optional: Serve frontend static assets directly in full-stack setup
app.use(express.static(path.join(__dirname, '../frontend')));
app.get('*', (req, res) => {
    res.sendFile(path.resolve(__dirname, '../frontend', 'index.html'));
});

// Configure Socket.io
const io = socketIo(server, {
    cors: {
        origin: '*', // In production, specify frontend client domain URL
        methods: ['GET', 'POST']
    }
});

// Hook up WebSockets streaming logic
streamHandler(io);

// Start server listening
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
    console.log(`[Server] VitalSense engine active on port ${PORT} in ${process.env.NODE_ENV} mode`);
});
