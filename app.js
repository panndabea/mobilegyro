/**
 * MobileGyro – app.js
 *
 * Architecture:
 *  - SensorManager  : requests permissions, attaches/detaches browser events
 *  - Visualizer     : maps sensor angles to CSS 3D transform via rAF loop
 *  - UI             : updates DOM text values and status indicators
 *
 * Sensor → 3D mapping:
 *  DeviceOrientationEvent gives:
 *    alpha = rotation around device Z axis (compass heading 0–360°)
 *    beta  = rotation around device X axis (front-back tilt -180–180°)
 *    gamma = rotation around device Y axis (left-right tilt -90–90°)
 *  These map directly to CSS rotateZ / rotateX / rotateY of the device scene.
 *  Smoothing: exponential moving average (factor α=0.12) prevents jitter.
 */

/* ============================================================
   State
   ============================================================ */
const state = {
  active: false,
  hasOrientation: false,
  hasMotion: false,

  // Smoothed target angles (degrees)
  alpha: 0,
  beta:  0,
  gamma: 0,

  // Raw rotation rates (°/s)
  rateX: null,
  rateY: null,
  rateZ: null,

  // Acceleration (m/s²)
  accX: null,
  accY: null,
  accZ: null,

  // Current rendered angles (for smooth interpolation)
  _renderAlpha: 0,
  _renderBeta:  0,
  _renderGamma: 0,
};

// Smoothing factor: 0 = no update, 1 = instant snap
const SMOOTH = 0.12;

/* ============================================================
   DOM refs
   ============================================================ */
const el = {
  btnEnable:         document.getElementById('btnEnable'),
  enableWrap:        document.getElementById('enableWrap'),
  statusBar:         document.getElementById('statusBar'),
  statusDot:         document.getElementById('statusDot'),
  statusText:        document.getElementById('statusText'),
  deviceScene:       document.getElementById('deviceScene'),

  valAlpha:          document.getElementById('valAlpha'),
  valBeta:           document.getElementById('valBeta'),
  valGamma:          document.getElementById('valGamma'),
  badgeOrientation:  document.getElementById('badgeOrientation'),

  valRateX:          document.getElementById('valRateX'),
  valRateY:          document.getElementById('valRateY'),
  valRateZ:          document.getElementById('valRateZ'),
  badgeRotation:     document.getElementById('badgeRotation'),

  valAccX:           document.getElementById('valAccX'),
  valAccY:           document.getElementById('valAccY'),
  valAccZ:           document.getElementById('valAccZ'),
  badgeAccel:        document.getElementById('badgeAccel'),
};

/* ============================================================
   Utility helpers
   ============================================================ */

/** Round to one decimal place; return "—" if value is null/undefined */
function fmt(v) {
  return (v == null) ? '—' : v.toFixed(1);
}

/** Shortest-path interpolation for angles that wrap at 360° */
function lerpAngle(current, target, factor) {
  let delta = ((target - current + 540) % 360) - 180;
  return current + delta * factor;
}

/** Simple linear interpolation */
function lerp(a, b, t) {
  return a + (b - a) * t;
}

/* ============================================================
   UI module
   ============================================================ */
const UI = {
  setStatus(text, mode /* 'idle' | 'active' | 'error' */) {
    el.statusText.textContent = text;
    el.statusBar.className = 'status-bar' + (mode === 'active' ? ' active' : mode === 'error' ? ' error' : '');
  },

  setBadge(badgeEl, available) {
    badgeEl.textContent = available ? 'Available' : 'Not available';
    badgeEl.className = 'card-badge ' + (available ? 'on' : 'off');
  },

  /** Flash a data-value element briefly when it changes significantly */
  flashValue(elem) {
    elem.classList.add('flash');
    setTimeout(() => elem.classList.remove('flash'), 150);
  },

  updateOrientation(alpha, beta, gamma) {
    el.valAlpha.textContent = fmt(alpha);
    el.valBeta.textContent  = fmt(beta);
    el.valGamma.textContent = fmt(gamma);
  },

  updateRotationRate(x, y, z) {
    el.valRateX.textContent = fmt(x);
    el.valRateY.textContent = fmt(y);
    el.valRateZ.textContent = fmt(z);
  },

  updateAcceleration(x, y, z) {
    el.valAccX.textContent = fmt(x);
    el.valAccY.textContent = fmt(y);
    el.valAccZ.textContent = fmt(z);
  },
};

/* ============================================================
   Sensor module
   ============================================================ */
const SensorManager = {
  _orientationHandler: null,
  _motionHandler: null,

  /** Check basic feature support */
  isOrientationSupported() {
    return 'DeviceOrientationEvent' in window;
  },
  isMotionSupported() {
    return 'DeviceMotionEvent' in window;
  },

  /**
   * Request permission on iOS 13+ (DeviceOrientationEvent.requestPermission).
   * On all other platforms the promise resolves immediately with 'granted'.
   */
  async requestPermission() {
    if (typeof DeviceOrientationEvent !== 'undefined' &&
        typeof DeviceOrientationEvent.requestPermission === 'function') {
      try {
        const result = await DeviceOrientationEvent.requestPermission();
        return result === 'granted';
      } catch {
        return false;
      }
    }
    // Android / desktop – no explicit permission required
    return true;
  },

  /** Start listening to orientation + motion events */
  start() {
    this._orientationHandler = (e) => {
      // alpha wraps 0–360, beta -180–180, gamma -90–90
      if (e.alpha != null) {
        state.alpha = e.alpha;
        state.beta  = e.beta  ?? 0;
        state.gamma = e.gamma ?? 0;
        state.hasOrientation = true;
      }
    };

    this._motionHandler = (e) => {
      const rr = e.rotationRate;
      if (rr) {
        state.rateX = rr.alpha; // rotation around Z (alpha axis of rotationRate)
        state.rateY = rr.beta;
        state.rateZ = rr.gamma;
        state.hasMotion = true;
      }

      // Prefer acceleration without gravity; fall back to accelerationIncludingGravity
      const acc = e.acceleration || e.accelerationIncludingGravity;
      if (acc) {
        state.accX = acc.x;
        state.accY = acc.y;
        state.accZ = acc.z;
      }
    };

    window.addEventListener('deviceorientation', this._orientationHandler, true);
    window.addEventListener('devicemotion',      this._motionHandler,      true);
    state.active = true;
  },

  /** Remove all event listeners */
  stop() {
    if (this._orientationHandler) {
      window.removeEventListener('deviceorientation', this._orientationHandler, true);
      this._orientationHandler = null;
    }
    if (this._motionHandler) {
      window.removeEventListener('devicemotion', this._motionHandler, true);
      this._motionHandler = null;
    }
    state.active = false;
  },
};

/* ============================================================
   Visualizer module
   ============================================================ */
const Visualizer = {
  _rafId: null,

  /** Apply CSS 3D transform to the device scene */
  applyTransform(alpha, beta, gamma) {
    // Sensor → CSS 3D rotation mapping:
    //   rotateX(beta)  : tilts the phone top/bottom (pitch)
    //   rotateY(gamma) : tilts the phone left/right (roll) – note: inverted feels natural
    //   rotateZ(-alpha): compass rotation around screen's own axis (yaw)
    el.deviceScene.style.transform =
      `rotateX(${beta.toFixed(2)}deg) rotateY(${(-gamma).toFixed(2)}deg) rotateZ(${(-alpha).toFixed(2)}deg)`;
  },

  /** Animation loop: smoothly interpolate toward target sensor values */
  _loop() {
    if (state.active && state.hasOrientation) {
      // Smooth toward sensor targets using lerp / lerpAngle
      state._renderAlpha = lerpAngle(state._renderAlpha, state.alpha, SMOOTH);
      state._renderBeta  = lerp(state._renderBeta,  state.beta,  SMOOTH);
      state._renderGamma = lerp(state._renderGamma, state.gamma, SMOOTH);

      this.applyTransform(state._renderAlpha, state._renderBeta, state._renderGamma);

      // Update orientation text values
      UI.updateOrientation(state.alpha, state.beta, state.gamma);
    }

    // Update rotation rate and acceleration regardless of orientation
    if (state.hasMotion) {
      UI.updateRotationRate(state.rateX, state.rateY, state.rateZ);
      UI.updateAcceleration(state.accX, state.accY, state.accZ);
    }

    this._rafId = requestAnimationFrame(() => this._loop());
  },

  start() {
    if (!this._rafId) this._loop();
  },

  stop() {
    if (this._rafId) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
  },
};

/* ============================================================
   Feature detection & status update loop
   ============================================================ */
let _statusCheckCount = 0;

/** Called once per second after activation to update availability badges */
function checkAvailability() {
  _statusCheckCount++;

  const hasOri = state.hasOrientation;
  const hasMot = state.hasMotion;
  const hasAcc = (state.accX != null || state.accY != null || state.accZ != null);

  UI.setBadge(el.badgeOrientation, hasOri);
  UI.setBadge(el.badgeRotation, hasMot);
  UI.setBadge(el.badgeAccel, hasAcc);

  if (!hasOri && !hasMot && _statusCheckCount < 5) {
    UI.setStatus('Waiting for sensor data…', 'active');
  } else if (!hasOri && !hasMot) {
    UI.setStatus('No sensor data received – sensor may be unavailable on this device', 'error');
  } else {
    const parts = [];
    if (hasOri) parts.push('Orientation');
    if (hasMot) parts.push('Motion');
    if (hasAcc) parts.push('Acceleration');
    UI.setStatus('Active · ' + parts.join(' · '), 'active');
  }
}

/* ============================================================
   Enable button handler
   ============================================================ */
el.btnEnable.addEventListener('click', async () => {
  el.btnEnable.disabled = true;
  UI.setStatus('Requesting sensor permission…', 'idle');

  if (!SensorManager.isOrientationSupported() && !SensorManager.isMotionSupported()) {
    UI.setStatus('DeviceOrientation / DeviceMotion not supported in this browser', 'error');
    el.btnEnable.disabled = false;
    return;
  }

  const granted = await SensorManager.requestPermission();
  if (!granted) {
    UI.setStatus('Permission denied – please allow motion access in Settings', 'error');
    el.btnEnable.disabled = false;
    return;
  }

  // Start sensors and visualizer
  SensorManager.start();
  Visualizer.start();

  // Hide the button after successful start
  el.enableWrap.classList.add('hidden');
  el.enableWrap.style.display = 'none';

  UI.setStatus('Sensors starting…', 'active');
  _statusCheckCount = 0;

  // Poll availability every second for the first 10 s, then every 3 s
  let slowInterval = null;
  const fastInterval = setInterval(() => {
    checkAvailability();
    if (_statusCheckCount >= 10) {
      clearInterval(fastInterval);
      // After initial phase, check less frequently
      slowInterval = setInterval(checkAvailability, 3000);
    }
  }, 1000);
});

/* ============================================================
   Initial setup
   ============================================================ */
(function init() {
  // Show feature availability in badge immediately (before activation)
  const oriSupported = SensorManager.isOrientationSupported();
  const motSupported = SensorManager.isMotionSupported();

  if (!oriSupported && !motSupported) {
    UI.setStatus('Sensors not supported in this browser', 'error');
    el.btnEnable.disabled = true;
  }

  // Start the idle animation on the 3D device (gentle default rotation)
  let idleAngle = 0;
  let idleRafId = requestAnimationFrame(function idleLoop() {
    if (state.active) return; // stop idle once real data starts
    idleAngle += 0.3;
    const beta  = Math.sin(idleAngle * Math.PI / 180) * 15;
    const gamma = Math.cos(idleAngle * Math.PI / 180 * 0.7) * 20;
    el.deviceScene.style.transform =
      `rotateX(${(20 + beta).toFixed(2)}deg) rotateY(${gamma.toFixed(2)}deg) rotateZ(0deg)`;
    idleRafId = requestAnimationFrame(idleLoop);
  });
})();
