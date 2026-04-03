'use strict';

// ---------------------------------------------------------------------------
// AudioModule — plays a 600 Hz sine tone while transmitting
// ---------------------------------------------------------------------------
const AudioModule = (() => {
  let ctx = null;
  let oscillator = null;
  let gainNode = null;

  function ensureContext() {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
  }

  function start() {
    ensureContext();
    if (oscillator) return; // already playing
    oscillator = ctx.createOscillator();
    gainNode = ctx.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.value = 600;
    gainNode.gain.setValueAtTime(0, ctx.currentTime);
    gainNode.gain.linearRampToValueAtTime(0.3, ctx.currentTime + 0.005);
    oscillator.connect(gainNode);
    gainNode.connect(ctx.destination);
    oscillator.start();
  }

  function stop() {
    if (!oscillator) return;
    const now = ctx.currentTime;
    gainNode.gain.setValueAtTime(gainNode.gain.value, now);
    gainNode.gain.linearRampToValueAtTime(0, now + 0.005);
    const osc = oscillator;
    oscillator = null;
    gainNode = null;
    setTimeout(() => osc.stop(), 10);
  }

  return { start, stop };
})();

// ---------------------------------------------------------------------------
// VibrationModule — vibrates while transmitting (Android only)
// ---------------------------------------------------------------------------
const VibrationModule = (() => {
  const supported = 'vibrate' in navigator;

  function start() {
    if (supported) navigator.vibrate([3000]);
  }

  function stop() {
    if (supported) navigator.vibrate(0);
  }

  return { supported, start, stop };
})();

// ---------------------------------------------------------------------------
// DisplayModule — canvas timeline of signals, one row per time window
// ---------------------------------------------------------------------------
const DisplayModule = (() => {
  const PIXELS_PER_MS = 0.12;
  const ROW_HEIGHT = 40;
  const SIGNAL_THICKNESS = 16;
  const BASELINE_THICKNESS = 2;
  const PADDING_LEFT = 8;
  const GAP_THRESHOLD_MS = 3000; // new row after 3s of silence
  const WRAP_MARGIN_MS = 1000;   // preemptively wrap when <1s of canvas space remains

  const canvas = document.getElementById('display');
  const dpr = window.devicePixelRatio || 1;

  // rows: [{ startTime, segments: [{ start_ms, end_ms|null, clientId }] }]
  // Per-client active segment: Map<clientId, { rowIndex, activeSegmentIdx }>
  const rows = [];
  const clientState = new Map();
  let lastGlobalEndTime = null;
  let lastStartSenderId = null;

  // Assign hues by always picking the midpoint of the largest gap in the circle.
  // This guarantees each new color is as distinct as possible from all existing ones.
  // Sequence: 0°, 180°, 90°, 270°, 45°, 135°, 225°, 315°, ...
  const colorMap = new Map();
  const assignedHues = [];

  function colorFor(clientId) {
    if (!colorMap.has(clientId)) {
      let hue;
      if (assignedHues.length === 0) {
        hue = 0;
      } else {
        const sorted = [...assignedHues].sort((a, b) => a - b);
        let maxGap = 0;
        let bestHue = 0;
        for (let i = 0; i < sorted.length; i++) {
          const curr = sorted[i];
          const next = sorted[(i + 1) % sorted.length];
          const gap = i === sorted.length - 1
            ? (sorted[0] + 360 - curr)   // wrap-around gap
            : (next - curr);
          if (gap > maxGap) {
            maxGap = gap;
            bestHue = (curr + gap / 2) % 360;
          }
        }
        hue = bestHue;
      }
      assignedHues.push(hue);
      colorMap.set(clientId, `hsl(${Math.round(hue)}, 100%, 62%)`);
    }
    return colorMap.get(clientId);
  }

  function resize() {
    const rect = canvas.parentElement.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    // CSS (position: absolute, width/height 100%) controls display size — no style assignment here
  }

  // True if the time cursor in `row` is within WRAP_MARGIN_MS of the canvas right edge
  function isNearEdge(row) {
    const logicalWidth = canvas.width / dpr;
    const currentPx = PADDING_LEFT + (Date.now() - row.startTime) * PIXELS_PER_MS;
    return currentPx > logicalWidth - WRAP_MARGIN_MS * PIXELS_PER_MS;
  }

  function signalStart(clientId) {
    const now = Date.now();
    const lastRow = rows[rows.length - 1];
    const gapTooLong = !lastRow || lastGlobalEndTime === null || (now - lastGlobalEndTime) > GAP_THRESHOLD_MS;
    const nearEdge = lastRow && isNearEdge(lastRow);
    const differentSender = lastRow && lastStartSenderId !== clientId;

    if (gapTooLong || nearEdge || differentSender) {
      rows.push({ startTime: now, segments: [] });
    }

    lastStartSenderId = clientId;

    const rowIndex = rows.length - 1;
    const row = rows[rowIndex];
    const segIdx = row.segments.length;
    row.segments.push({ start_ms: now - row.startTime, end_ms: null, clientId });

    clientState.set(clientId, { rowIndex, activeSegmentIdx: segIdx });
  }

  function signalEnd(clientId) {
    const now = Date.now();
    const state = clientState.get(clientId);
    if (!state) return;

    const row = rows[state.rowIndex];
    if (!row) return;
    const seg = row.segments[state.activeSegmentIdx];
    if (seg && seg.end_ms === null) {
      seg.end_ms = now - row.startTime;
    }

    lastGlobalEndTime = now;
    clientState.delete(clientId);
  }

  function draw() {
    const ctx = canvas.getContext('2d');
    const W = canvas.width;
    const H = canvas.height;
    const now = Date.now();

    ctx.clearRect(0, 0, W, H);

    const totalRows = rows.length;
    const totalHeight = totalRows * ROW_HEIGHT;
    // Scroll so the newest row is always at the bottom
    const offsetY = Math.max(0, totalHeight * dpr - H);

    rows.forEach((row, ri) => {
      const rowY = (ri * ROW_HEIGHT * dpr) - offsetY + (ROW_HEIGHT * dpr / 2);

      // Baseline
      ctx.fillStyle = '#333';
      ctx.fillRect(PADDING_LEFT * dpr, rowY - (BASELINE_THICKNESS * dpr / 2), W - PADDING_LEFT * dpr, BASELINE_THICKNESS * dpr);

      // Segments — each colored by its sender
      row.segments.forEach((seg) => {
        const x0 = PADDING_LEFT * dpr + seg.start_ms * PIXELS_PER_MS * dpr;
        const endMs = seg.end_ms !== null ? seg.end_ms : (now - row.startTime);
        const x1 = PADDING_LEFT * dpr + endMs * PIXELS_PER_MS * dpr;
        const w = Math.max(x1 - x0, 2 * dpr);

        ctx.fillStyle = colorFor(seg.clientId);
        ctx.fillRect(x0, rowY - (SIGNAL_THICKNESS * dpr / 2), w, SIGNAL_THICKNESS * dpr);
      });
    });

    requestAnimationFrame(draw);
  }

  new ResizeObserver(resize).observe(canvas.parentElement);
  resize();
  requestAnimationFrame(draw);

  return { signalStart, signalEnd };
})();

// ---------------------------------------------------------------------------
// Settings — persisted to localStorage
// ---------------------------------------------------------------------------
const muteAudioCheckbox = document.getElementById('mute-audio');
const enableVibrateCheckbox = document.getElementById('enable-vibrate');
const vibrateNote = document.getElementById('vibrate-note');

if (!VibrationModule.supported) {
  enableVibrateCheckbox.disabled = true;
  vibrateNote.textContent = '(Android only)';
}

muteAudioCheckbox.checked = localStorage.getItem('muteAudio') === 'true';
enableVibrateCheckbox.checked = localStorage.getItem('enableVibrate') === 'true';

muteAudioCheckbox.addEventListener('change', () => {
  localStorage.setItem('muteAudio', muteAudioCheckbox.checked);
});
enableVibrateCheckbox.addEventListener('change', () => {
  localStorage.setItem('enableVibrate', enableVibrateCheckbox.checked);
});

function isMuted() { return muteAudioCheckbox.checked; }
function isVibrateOn() { return VibrationModule.supported && enableVibrateCheckbox.checked; }

// ---------------------------------------------------------------------------
// WSModule — WebSocket connection with exponential backoff reconnect
// ---------------------------------------------------------------------------
const WSModule = (() => {
  const wsUrl = location.hostname === 'localhost' || location.hostname === '127.0.0.1'
    ? `ws://${location.host}`
    : `wss://${location.host}`;

  let ws = null;
  let myClientId = null;
  let reconnectDelay = 500;
  const othersCountEl = document.getElementById('others-count');

  function connect() {
    ws = new WebSocket(wsUrl);

    ws.addEventListener('open', () => {
      reconnectDelay = 500;
    });

    ws.addEventListener('message', (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }

      if (msg.type === 'init') {
        myClientId = msg.clientId;
        othersCountEl.textContent = msg.count - 1;
        return;
      }

      if (msg.type === 'user_count') {
        othersCountEl.textContent = msg.count - 1;
        return;
      }

      const isOwn = msg.clientId === myClientId;

      if (msg.type === 'signal_start') {
        DisplayModule.signalStart(msg.clientId);
        if (!isOwn) {
          // Remote signal — play audio + vibration
          if (!isMuted()) AudioModule.start();
          if (isVibrateOn()) VibrationModule.start();
        }
        // Own signal — audio/vibration already started locally on pointerdown
      }

      if (msg.type === 'signal_end') {
        DisplayModule.signalEnd(msg.clientId);
        if (!isOwn) {
          AudioModule.stop();
          VibrationModule.stop();
        } else if (transmitting) {
          // Server safety-timeout fired — stop local output without re-sending signal_end
          stopLocalOutput();
        }
      }
    });

    ws.addEventListener('close', () => {
      ws = null;
      setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, 10000);
    });

    ws.addEventListener('error', () => {
      ws?.close();
    });
  }

  function send(data) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ ...data, clientId: myClientId }));
    }
  }

  function getClientId() { return myClientId; }

  connect();
  return { send, getClientId };
})();

// ---------------------------------------------------------------------------
// Transmit button — pointer events
// ---------------------------------------------------------------------------
const transmitBtn = document.getElementById('transmit');
let transmitting = false;

transmitBtn.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  if (transmitting) return;
  transmitting = true;
  transmitBtn.classList.add('active');

  // Immediately start local audio + vibration (no server round-trip)
  if (!isMuted()) AudioModule.start();
  if (isVibrateOn()) VibrationModule.start();

  WSModule.send({ type: 'signal_start' });
});

function stopLocalOutput() {
  if (!transmitting) return;
  transmitting = false;
  transmitBtn.classList.remove('active');
  AudioModule.stop();
  VibrationModule.stop();
}

function endTransmit() {
  if (!transmitting) return;
  stopLocalOutput();
  WSModule.send({ type: 'signal_end' });
}

window.addEventListener('pointerup', endTransmit);
window.addEventListener('pointercancel', endTransmit);

// ---------------------------------------------------------------------------
// Spacebar support for desktop users
// ---------------------------------------------------------------------------
window.addEventListener('keydown', (e) => {
  if (e.code !== 'Space') return;
  // Don't interfere with inputs, checkboxes, buttons, etc.
  if (e.target !== document.body && e.target !== document.documentElement) return;
  if (e.repeat) return; // ignore key-repeat auto-fire
  e.preventDefault(); // prevent page scroll

  if (transmitting) return;
  transmitting = true;
  transmitBtn.classList.add('active');

  if (!isMuted()) AudioModule.start();
  if (isVibrateOn()) VibrationModule.start();

  WSModule.send({ type: 'signal_start' });
});

window.addEventListener('keyup', (e) => {
  if (e.code !== 'Space') return;
  endTransmit();
});
