/**
 * Client-Side Socket.IO Connector for VitalSense AI
 */

let socket = null;

window.initiateSocketStream = (onUpdateCallback, onErrorCallback) => {
    // Detect environment to point to backend server
    const serverUrl = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
        ? 'http://127.0.0.1:5000'
        : window.location.origin;

    console.log(`[Socket] Connecting to server at: ${serverUrl}`);

    socket = io(serverUrl, {
        transports: ['websocket', 'polling'],
        reconnectionDelayMax: 10000,
        timeout: 20000
    });

    socket.on('connect', () => {
        console.log('[Socket] WebRTC-to-Socket telemetry link active');
        if (window.showAINotification) {
            window.showAINotification("Telemetry Secure Link Established", "success");
        }
    });

    socket.on('vitals_update', (data) => {
        if (onUpdateCallback) onUpdateCallback(data);
    });

    socket.on('connect_error', (err) => {
        console.error('[Socket] Connection failure:', err);
        if (onErrorCallback) onErrorCallback(err);
    });

    socket.on('disconnect', (reason) => {
        console.warn(`[Socket] Link disconnected: ${reason}`);
        if (window.showAINotification) {
            window.showAINotification("Telemetry Server Disconnected", "error");
        }
    });
};

window.sendDataPacket = (greenVal, redVal) => {
    if (socket && socket.connected) {
        socket.emit('stream_frame_data', { greenVal, redVal });
    }
};

window.closeSocketStream = () => {
    if (socket) {
        socket.disconnect();
        socket = null;
        console.log('[Socket] Telemetry link terminated by user request');
    }
};
