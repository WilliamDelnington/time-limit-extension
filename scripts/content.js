// ─────────────────────────────────────────────
//  content.js  –  Activity Observer + Enforcer
//  Injected into every page.
//  1. Detects user activity and reports to background.
//  2. Listens for LIMIT_STATUS messages and renders
//     warning toasts or triggers a block redirect.
// ─────────────────────────────────────────────

const ACTIVITY_EVENTS = ["mousemove", "keydown", "scroll", "click", "touchstart"];
const HEARTBEAT_INTERVAL_MS = 30_000;

let activityTimeout = null;
let heartbeatTimer  = null;
let isActive        = false;

// ─── Visibility Change ─────────────────────────
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    notifyBackground("PAGE_HIDDEN");
    stopHeartbeat();
  } else {
    notifyBackground("PAGE_VISIBLE");
    startHeartbeat();
  }
});

// ─── User Activity Detection ───────────────────
const INACTIVITY_TIMEOUT_MS = 60_000;

function onUserActivity() {
  if (!isActive) {
    isActive = true;
    notifyBackground("USER_ACTIVE");
    startHeartbeat();
  }
  clearTimeout(activityTimeout);
  activityTimeout = setTimeout(() => {
    isActive = false;
    notifyBackground("USER_IDLE");
    stopHeartbeat();
  }, INACTIVITY_TIMEOUT_MS);
}

ACTIVITY_EVENTS.forEach((evt) =>
  document.addEventListener(evt, onUserActivity, { passive: true })
);

// ─── Heartbeat ─────────────────────────────────
function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    notifyBackground("HEARTBEAT");
  }, HEARTBEAT_INTERVAL_MS);
}

function stopHeartbeat() {
  clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}

// ─── Communicate with background ──────────────
function notifyBackground(type) {
  chrome.runtime.sendMessage({ type, url: location.href }).catch(() => {});
}

// ─── Limit Status Listener ─────────────────────
// Receives LIMIT_STATUS broadcasts from background.js
// whenever a session is saved and the domain has a limit.

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type !== "LIMIT_STATUS") return;

  const { status, domain, remainingMs, spentMs, limitMs } = msg;

  if (status === "exceeded") {
    handleExceeded(domain, spentMs, limitMs, msg.isGroup, msg.groupDomains);
    return;
  }

  if (status === "warning_5min" || status === "warning_10min" || status === "warning_10pct") {
    showWarningToast(domain, remainingMs, status, msg.isGroup);
  }
});

// ─── Warning Toast ─────────────────────────────

let activeToast = null;

function showWarningToast(domain, remainingMs, status, isGroup = false) {
  if (activeToast) activeToast.remove();

  const mins = Math.ceil(remainingMs / 60_000);
  const isUrgent = status === "warning_5min" || status === "warning_10pct";

  const toast = document.createElement("div");
  toast.id = "tl-warning-toast";
  toast.setAttribute("role", "alert");
  toast.innerHTML = `
    <div class="tl-toast-inner ${isUrgent ? "tl-urgent" : ""}">
      <span class="tl-icon">${isUrgent ? "⚠️" : "🕐"}</span>
      <div class="tl-toast-body">
        <strong>Time check</strong>
        <span>${mins} minute${mins !== 1 ? "s" : ""} left${isGroup ? " in your group budget" : ` on ${domain}`} today.</span>
      </div>
      <button class="tl-toast-close" aria-label="Dismiss">✕</button>
    </div>
  `;

  injectStyles();
  document.body.appendChild(toast);
  activeToast = toast;

  toast.querySelector(".tl-toast-close").addEventListener("click", () => {
    toast.classList.add("tl-toast-out");
    setTimeout(() => toast.remove(), 300);
    activeToast = null;
  });

  const autoDismiss = isUrgent ? 30_000 : 15_000;
  setTimeout(() => {
    if (document.contains(toast)) {
      toast.classList.add("tl-toast-out");
      setTimeout(() => toast.remove(), 300);
      if (activeToast === toast) activeToast = null;
    }
  }, autoDismiss);
}

// ─── Exceeded: Overlay + Redirect ──────────────
// When the limit tips over mid-session (user was already on the
// page), show a full-page overlay with a countdown before
// redirecting — gives them a moment to save any work.

let overlayShown = false;

function handleExceeded(domain, spentMs, limitMs, isGroup = false, groupDomains = []) {
  if (overlayShown) return;
  overlayShown = true;

  stopHeartbeat();

  const overlay = document.createElement("div");
  overlay.id = "tl-exceeded-overlay";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", "Time limit reached");

  const spentMin = Math.round(spentMs / 60_000);
  const limitMin = Math.round(limitMs / 60_000);
  const heading = isGroup ? `Group budget reached` : `Time's up on ${domain}`;

  overlay.innerHTML = `
    <div class="tl-overlay-box">
      <div class="tl-overlay-icon">⏰</div>
      <h2>${heading}</h2>
      <p>You've used <strong>${spentMin} of ${limitMin} minutes</strong> today.</p>
      <p class="tl-overlay-sub">Redirecting in <span id="tl-countdown">5</span>s.</p>
      <div class="tl-overlay-actions">
        <button id="tl-btn-continue">Continue anyway</button>
        <button id="tl-btn-leave">Go somewhere else</button>
      </div>
      <p class="tl-continue-note">"Continue anyway" gives you 10 more minutes.</p>
    </div>
  `;

  injectStyles();
  document.body.appendChild(overlay);
  document.body.style.overflow = "hidden";

  // Countdown → auto-redirect
  let secs = 5;
  const countdownEl = overlay.querySelector("#tl-countdown");
  const countdownTimer = setInterval(() => {
    secs--;
    if (countdownEl) countdownEl.textContent = secs;
    if (secs <= 0) {
      clearInterval(countdownTimer);
      redirectToBlocked(domain, spentMs, limitMs);
    }
  }, 1000);

  const continueMsg = isGroup ? "CONTINUE_ANYWAY_GROUP" : "CONTINUE_ANYWAY";
  overlay.querySelector("#tl-btn-continue").addEventListener("click", () => {
    clearInterval(countdownTimer);
    chrome.runtime.sendMessage({ type: continueMsg, domain }, () => {
      if (chrome.runtime.lastError) { console.warn('content.js sendMessage:', chrome.runtime.lastError.message); }
      overlay.remove();
      document.body.style.overflow = "";
      overlayShown = false;
      startHeartbeat();
      showWarningToast(domain, 10 * 60_000, "warning_10min");
    });
  });

  overlay.querySelector("#tl-btn-leave").addEventListener("click", () => {
    clearInterval(countdownTimer);
    redirectToBlocked(domain, spentMs, limitMs);
  });
}

// ─── Style injection ───────────────────────────

let stylesInjected = false;

function injectStyles() {
  if (stylesInjected) return;
  stylesInjected = true;

  const style = document.createElement("style");
  style.textContent = `
    #tl-warning-toast {
      position: fixed;
      bottom: 24px;
      right: 24px;
      z-index: 2147483647;
      animation: tl-slide-in 0.3s ease;
    }
    #tl-warning-toast.tl-toast-out {
      animation: tl-slide-out 0.3s ease forwards;
    }
    .tl-toast-inner {
      display: flex;
      align-items: center;
      gap: 10px;
      background: #fff;
      border: 1px solid #e0e0e0;
      border-left: 4px solid #ff9800;
      border-radius: 8px;
      padding: 12px 14px;
      box-shadow: 0 4px 16px rgba(0,0,0,0.12);
      min-width: 260px;
      max-width: 340px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 13px;
      color: #1a1a1a;
    }
    .tl-toast-inner.tl-urgent { border-left-color: #f44336; background: #fff8f8; }
    .tl-toast-body { display: flex; flex-direction: column; gap: 2px; flex: 1; }
    .tl-toast-body strong { font-weight: 600; }
    .tl-toast-close {
      background: none; border: none; cursor: pointer;
      font-size: 12px; color: #999; padding: 2px 4px;
    }
    .tl-toast-close:hover { color: #333; }
    .tl-icon { font-size: 18px; line-height: 1; }

    @keyframes tl-slide-in {
      from { opacity: 0; transform: translateY(12px); }
      to   { opacity: 1; transform: translateY(0); }
    }
    @keyframes tl-slide-out {
      from { opacity: 1; transform: translateY(0); }
      to   { opacity: 0; transform: translateY(12px); }
    }

    #tl-exceeded-overlay {
      position: fixed;
      inset: 0;
      z-index: 2147483647;
      background: rgba(0,0,0,0.72);
      display: flex;
      align-items: center;
      justify-content: center;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      animation: tl-fade-in 0.25s ease;
    }
    .tl-overlay-box {
      background: #fff;
      border-radius: 16px;
      padding: 36px 40px;
      max-width: 420px;
      width: 90%;
      text-align: center;
      box-shadow: 0 8px 40px rgba(0,0,0,0.3);
    }
    .tl-overlay-icon { font-size: 48px; margin-bottom: 12px; }
    .tl-overlay-box h2 { font-size: 20px; font-weight: 600; color: #1a1a1a; margin-bottom: 8px; }
    .tl-overlay-box p { font-size: 14px; color: #444; margin-bottom: 6px; line-height: 1.5; }
    .tl-overlay-sub { color: #888; font-size: 13px; }
    .tl-overlay-actions {
      display: flex; gap: 10px; justify-content: center; margin: 20px 0 10px;
    }
    .tl-overlay-actions button {
      padding: 9px 20px; border-radius: 8px; border: none;
      font-size: 14px; font-weight: 500; cursor: pointer; transition: background 0.15s;
    }
    #tl-btn-continue { background: #fff3e0; color: #e65100; border: 1px solid #ffcc80; }
    #tl-btn-continue:hover { background: #ffe0b2; }
    #tl-btn-leave { background: #1565c0; color: #fff; }
    #tl-btn-leave:hover { background: #0d47a1; }
    .tl-continue-note { font-size: 11px; color: #aaa; margin-top: 4px; }

    @keyframes tl-fade-in {
      from { opacity: 0; }
      to   { opacity: 1; }
    }
  `;
  document.head.appendChild(style);
}

// ─── Init ──────────────────────────────────────
notifyBackground("PAGE_VISIBLE");
startHeartbeat();
onUserActivity();