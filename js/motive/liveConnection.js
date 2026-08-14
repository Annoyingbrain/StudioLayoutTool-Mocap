// Browser-side counterpart to server.py's WebSocket bridge: connects, and
// forwards each incoming frame's rigid body list to App.liveTracking, which
// owns what happens with it (assignment to a camera/prop, applying position
// + rotation). This module only owns the socket and connection status.
window.App = window.App || {};

(function () {
  let socket = null;
  let status = 'disconnected'; // 'disconnected' | 'connecting' | 'connected' | 'error'
  let lastError = null;
  const listeners = [];

  function emit() { listeners.forEach(fn => fn()); }
  function setStatus(s, err) { status = s; lastError = err || null; emit(); }

  function handleMessage(event) {
    let msg;
    try { msg = JSON.parse(event.data); } catch (e) { return; }
    if (msg && msg.type === 'frame' && Array.isArray(msg.rigidBodies)) {
      App.liveTracking.handleFrame(msg.rigidBodies);
    }
  }

  App.liveConnection = {
    getStatus() { return status; },
    getLastError() { return lastError; },
    subscribe(fn) { listeners.push(fn); return () => listeners.splice(listeners.indexOf(fn), 1); },

    connect(url) {
      if (socket) this.disconnect();
      setStatus('connecting');
      try {
        socket = new WebSocket(url);
      } catch (e) {
        setStatus('error', e.message);
        return;
      }
      socket.addEventListener('open', () => setStatus('connected'));
      socket.addEventListener('message', handleMessage);
      socket.addEventListener('close', () => { socket = null; setStatus('disconnected'); });
      socket.addEventListener('error', () => setStatus('error', "Couldn't reach the live bridge -- is server.py running?"));
    },

    disconnect() {
      if (socket) { socket.close(); socket = null; }
      setStatus('disconnected');
    },

    isConnected() { return status === 'connected'; }
  };
})();
