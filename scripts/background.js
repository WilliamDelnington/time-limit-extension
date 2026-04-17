// ─────────────────────────────────────────────
//  background.js  –  Time Tracking Service Worker
//  Runs persistently. Owns all session logic.
// ─────────────────────────────────────────────

const MIN_SESSION_MS = 1000; // ignore sessions shorter than 1 s
const IDLE_THRESHOLD_SEC = 60; // seconds before treating user as AFK

// In-memory state (survives as long as the service worker is alive)
let currentSession = {
  domain: null,
  startTime: null,
  tabId: null,
};

// ─── Helpers ──────────────────────────────────

function extractDomain(url) {
  try {
    const { hostname } = new URL(url);
    // Strip "www." so www.youtube.com === youtube.com
    return hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

function todayKey() {
  // Returns "YYYY-MM-DD" in local time — used as the storage key
  return new Date().toLocaleDateString("en-CA"); // "en-CA" gives ISO format
}

async function getUsage() {
  const key = todayKey();
  const result = await chrome.storage.local.get(key);
  return result[key] ?? {};
}

async function saveUsage(usage) {
  const key = todayKey();
  await chrome.storage.local.set({ [key]: usage });
}

// ─── Session Management ────────────────────────

function startSession(domain, tabId) {
  if (!domain) return;

  // If there's already a running session, end it first
  if (currentSession.startTime !== null) {
    endSession();
  }

  currentSession = {
    domain,
    startTime: Date.now(),
    tabId,
  };

  startTicker();
  console.log(`[Tracker] Session started: ${domain}`);
}

async function endSession() {
  const { domain, startTime } = currentSession;

  // Nothing running — nothing to do
  if (!domain || startTime === null) return;

  const duration = Date.now() - startTime;

  // Discard very short sessions (tab flicks, AFK artefacts)
  if (duration >= MIN_SESSION_MS) {
    const usage = await getUsage();
    usage[domain] = (usage[domain] ?? 0) + duration;
    await saveUsage(usage);
    console.log(`[Tracker] Saved ${duration}ms for ${domain}`);
    // Check individual limit and group limit in parallel
    await Promise.all([
      checkLimitForDomain(domain),
      checkGroupLimit(domain),
    ]);
  } else {
    console.log(`[Tracker] Discarded short session (${duration}ms) for ${domain}`);
  }

  // Reset regardless
  stopTicker();
  currentSession = { domain: null, startTime: null, tabId: null };
}

// ─── Live Enforcement Ticker ──────────────────
// Checks limits every 10 s while a session is active.
// This catches the case where the limit is exceeded mid-session —
// enforceOnNavigation only fires on navigation, not while sitting on a page.

const TICKER_INTERVAL_MS = 10_000;
let tickerTimer = null;

function startTicker() {
  if (tickerTimer) return; // already running
  tickerTimer = setInterval(liveLimitCheck, TICKER_INTERVAL_MS);
}

function stopTicker() {
  clearInterval(tickerTimer);
  tickerTimer = null;
}

async function liveLimitCheck() {
  const { domain, startTime, tabId } = currentSession;
  if (!domain || startTime === null) { stopTicker(); return; }

  // Build a usage snapshot that includes the live elapsed time
  // of the current session (not yet written to storage).
  const savedUsage  = await getUsage();
  const liveElapsed = Date.now() - startTime;
  const liveUsage   = {
    ...savedUsage,
    [domain]: (savedUsage[domain] ?? 0) + liveElapsed,
  };

  const [limits, groupLimit] = await Promise.all([getLimits(), getGroupLimit()]);

  // ── Individual check ─────────────────────────
  const individualLimit = limits[domain];
  if (individualLimit != null && liveUsage[domain] >= individualLimit) {
    const graceActive = await isGracePeriodActive(domain);
    if (!graceActive) {
      console.log(`[Ticker] Individual limit exceeded for ${domain} — blocking tab ${tabId}`);
      await endSession(); // save what we have first
      const spentMs = (await getUsage())[domain] ?? 0;
      const blockedUrl = chrome.runtime.getURL(
        `blocked.html?domain=${encodeURIComponent(domain)}&spent=${spentMs}&limit=${individualLimit}&type=individual`
      );
      chrome.tabs.update(tabId, { url: blockedUrl });
      stopTicker();
      return;
    }
  }

  // ── Group check ──────────────────────────────
  if (groupLimit && groupLimit.domains.includes(domain) && groupLimit.limitMs) {
    const groupSpentMs = groupLimit.domains.reduce(
      (sum, d) => sum + (liveUsage[d] ?? 0), 0
    );
    if (groupSpentMs >= groupLimit.limitMs) {
      const graceActive = await isGracePeriodActive("__group__");
      if (!graceActive) {
        console.log(`[Ticker] Group limit exceeded for ${domain} — blocking tab ${tabId}`);
        await endSession(); // save what we have first
        const savedAfter = await getUsage();
        const groupSpentAfter = groupLimit.domains.reduce(
          (sum, d) => sum + (savedAfter[d] ?? 0), 0
        );
        const blockedUrl = chrome.runtime.getURL(
          `blocked.html?domain=${encodeURIComponent(domain)}&spent=${groupSpentAfter}&limit=${groupLimit.limitMs}&type=group&domains=${encodeURIComponent(groupLimit.domains.join(","))}`
        );
        chrome.tabs.update(tabId, { url: blockedUrl });
        stopTicker();
        return;
      }
    }

    // Broadcast live warning status to the active tab
    const remainingMs = Math.max(0, groupLimit.limitMs - groupSpentMs);
    const pct = groupSpentMs / groupLimit.limitMs;
    let status = "ok";
    if (pct >= 0.9)                       status = "warning_10pct";
    else if (remainingMs <= 5 * 60_000)   status = "warning_5min";
    else if (remainingMs <= 10 * 60_000)  status = "warning_10min";

    if (status !== "ok") {
      chrome.tabs.sendMessage(tabId, {
        type: "LIMIT_STATUS",
        domain,
        spentMs: groupSpentMs,
        limitMs: groupLimit.limitMs,
        remainingMs,
        status,
        isGroup: true,
        groupDomains: groupLimit.domains,
      }).catch(() => {});
    }
  }
}

// ─── Enforcement State ─────────────────────────
// Tracks which domains the user has chosen "continue anyway" for.
// Cleared at midnight with the daily reset.
// Structure: { "youtube.com": { grantedAt: <timestamp>, expiresAt: <timestamp> } }

const CONTINUE_GRACE_MS = 10 * 60_000; // 10-minute grace window after "continue anyway"

async function getEnforcementState() {
  const { enforcementState } = await chrome.storage.local.get("enforcementState");
  return enforcementState ?? {};
}

async function saveEnforcementState(state) {
  await chrome.storage.local.set({ enforcementState: state });
}

async function isGracePeriodActive(domain) {
  const state = await getEnforcementState();
  const entry = state[domain];
  if (!entry) return false;
  return Date.now() < entry.expiresAt;
}

async function grantGracePeriod(domain) {
  const state = await getEnforcementState();
  const now = Date.now();
  state[domain] = { grantedAt: now, expiresAt: now + CONTINUE_GRACE_MS };
  await saveEnforcementState(state);
  console.log(`[Enforce] Grace period granted for ${domain} (${CONTINUE_GRACE_MS / 60_000} min)`);
}

async function clearAllGracePeriods() {
  await chrome.storage.local.remove("enforcementState");
  console.log("[Enforce] All grace periods cleared (daily reset)");
}

// ─── Enforcement Check ─────────────────────────
// Called before starting a session. If the domain is exceeded
// and no active grace period, redirect the tab to blocked.html.

async function enforceOnNavigation(tabId, domain) {
  const [savedUsage, limits, groupLimit] = await Promise.all([
    getUsage(), getLimits(), getGroupLimit()
  ]);

  // Include any live elapsed time from a currently-running session so that
  // navigating to a second group-domain mid-session is caught correctly.
  const liveUsage = { ...savedUsage };
  if (currentSession.domain && currentSession.startTime !== null) {
    const liveElapsed = Date.now() - currentSession.startTime;
    liveUsage[currentSession.domain] =
      (savedUsage[currentSession.domain] ?? 0) + liveElapsed;
  }

  // ── Individual limit check ─────────────────
  const limitMs = limits[domain];
  if (limitMs != null) {
    const spentMs = liveUsage[domain] ?? 0;
    if (spentMs >= limitMs) {
      const graceActive = await isGracePeriodActive(domain);
      if (!graceActive) {
        const blockedUrl = chrome.runtime.getURL(
          `blocked.html?domain=${encodeURIComponent(domain)}&spent=${spentMs}&limit=${limitMs}&type=individual`
        );
        chrome.tabs.update(tabId, { url: blockedUrl });
        console.log(`[Enforce] Blocked ${domain} (individual) — tab ${tabId}`);
        return true;
      }
    }
  }

  // ── Group limit check ──────────────────────
  if (groupLimit && groupLimit.domains.includes(domain) && groupLimit.groupLimitMs) {
    const groupSpentMs = groupLimit.domains.reduce(
      (sum, d) => sum + (liveUsage[d] ?? 0), 0
    );
    if (groupSpentMs >= groupLimit.groupLimitMs) {
      const graceActive = await isGracePeriodActive("__group__");
      if (!graceActive) {
        const blockedUrl = chrome.runtime.getURL(
          `blocked.html?domain=${encodeURIComponent(domain)}&spent=${groupSpentMs}&limit=${groupLimit.limitMs}&type=group&domains=${encodeURIComponent(groupLimit.domains.join(","))}`
        );
        chrome.tabs.update(tabId, { url: blockedUrl });
        console.log(`[Enforce] Blocked ${domain} (group) — tab ${tabId}`);
        return true;
      }
    }
  }

  return false;
}

// ─── Active Tab Detection ──────────────────────

async function handleActiveTab(tabId) {
  if (!tabId) {
    await endSession();
    return;
  }

  try {
    const tab = await chrome.tabs.get(tabId);
    const domain = extractDomain(tab.url ?? "");
    if (domain) {
      // Enforcement gate: block before starting a new session
      const blocked = await enforceOnNavigation(tabId, domain);
      if (!blocked) startSession(domain, tabId);
    } else {
      // New tab page, chrome:// urls, etc.
      await endSession();
    }
  } catch {
    // Tab may have been removed between the event and the get()
    await endSession();
  }
}

// ─── Chrome Event Listeners ────────────────────

// 1. User switches to a different tab
chrome.tabs.onActivated.addListener(({ tabId }) => {
  handleActiveTab(tabId);
});

// 2. Tab URL changes (e.g. navigating to a new site)
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete") return;
  if (tab.active) handleActiveTab(tabId);
});

// 3. Tab is closed
chrome.tabs.onRemoved.addListener((tabId) => {
  if (currentSession.tabId === tabId) {
    endSession();
  }
});

// 4. Window focus changes (user switches apps or minimises)
chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    // Browser lost focus entirely — end current session
    await endSession();
  } else {
    // Regained focus — resume tracking the active tab
    const [tab] = await chrome.tabs.query({ active: true, windowId });
    if (tab) handleActiveTab(tab.id);
  }
});

// 5. System idle / locked screen
chrome.idle.setDetectionInterval(IDLE_THRESHOLD_SEC);
chrome.idle.onStateChanged.addListener(async (state) => {
  if (state === "idle" || state === "locked") {
    console.log(`[Tracker] System ${state} — ending session`);
    await endSession();
  } else if (state === "active") {
    // User came back — restart tracking the active tab
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (tab) handleActiveTab(tab.id);
  }
});

// ─── Daily Reset ───────────────────────────────
// Runs once at startup and then checks every minute
// whether the date has rolled over since the last run.

async function dailyResetCheck() {
  const { lastResetDate } = await chrome.storage.local.get("lastResetDate");
  const today = todayKey();

  if (lastResetDate !== today) {
    console.log(`[Tracker] New day detected (${today}) — previous data kept, resetting session`);
    await chrome.storage.local.set({ lastResetDate: today });
    // Clear any "continue anyway" grace periods from the previous day
    await clearAllGracePeriods();
    // We keep historical data per day (keyed by date), so no purge needed.
    // Old dates can be cleaned up after 30 days:
    await pruneOldData(30);
  }
}

async function pruneOldData(keepDays) {
  const all = await chrome.storage.local.get(null);
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - keepDays);

  const toRemove = Object.keys(all).filter((k) => {
    // Keys that look like dates: "YYYY-MM-DD"
    if (!/^\d{4}-\d{2}-\d{2}$/.test(k)) return false;
    return new Date(k) < cutoff;
  });

  if (toRemove.length) {
    await chrome.storage.local.remove(toRemove);
    console.log(`[Tracker] Pruned old data:`, toRemove);
  }
}

// Run reset check at startup and every minute
dailyResetCheck();
setInterval(dailyResetCheck, 60_000);

// ─── Limit Helpers ─────────────────────────────

async function getLimits() {
  const { limits } = await chrome.storage.local.get("limits");
  return limits ?? {};
}

async function setLimit(domain, limitMs) {
  const limits = await getLimits();
  limits[domain] = limitMs;
  await chrome.storage.local.set({ limits });
  console.log(`[Limits] Set ${domain} → ${limitMs}ms`);
}

async function removeLimit(domain) {
  const limits = await getLimits();
  delete limits[domain];
  await chrome.storage.local.set({ limits });
  console.log(`[Limits] Removed limit for ${domain}`);
}

/**
 * Called after every session save.
 * Compares the domain's total usage against its limit and
 * broadcasts a LIMIT_STATUS message so the popup / content
 * scripts can react (warn or block) without polling.
 */
async function checkLimitForDomain(domain) {
  const [usage, limits] = await Promise.all([getUsage(), getLimits()]);
  const limitMs = limits[domain];
  if (limitMs == null) return; // no limit set — nothing to do

  const spentMs = usage[domain] ?? 0;
  const remainingMs = Math.max(0, limitMs - spentMs);
  const pct = spentMs / limitMs;

  let status = "ok";
  if (remainingMs === 0)         status = "exceeded";
  else if (pct >= 0.9)           status = "warning_10pct"; // ≤10% left
  else if (limitMs - spentMs <= 5 * 60_000) status = "warning_5min";
  else if (limitMs - spentMs <= 10 * 60_000) status = "warning_10min";

  console.log(`[Limits] ${domain}: ${spentMs}ms / ${limitMs}ms → ${status}`);

  // Broadcast to all tabs of this domain so content.js can react
  const tabs = await chrome.tabs.query({ url: [`*://*.${domain}/*`, `*://${domain}/*`] });
  for (const tab of tabs) {
    chrome.tabs.sendMessage(tab.id, {
      type: "LIMIT_STATUS",
      domain,
      spentMs,
      limitMs,
      remainingMs,
      status,
    }).catch(() => {}); // tab may not have content script loaded yet
  }

  return { domain, spentMs, limitMs, remainingMs, status };
}

// ─── Group Limit Helpers ───────────────────────
// Group limit storage shape:
// { limitMs: number, domains: string[] }

async function getGroupLimit() {
  const { groupLimit } = await chrome.storage.local.get("groupLimit");
  return groupLimit ?? null;
}

async function setGroupLimit(groupLimitMs, domains) {
  await chrome.storage.local.set({ groupLimit: { groupLimitMs, domains } });
  console.log(`[GroupLimit] Set ${groupLimitMs}ms for [${domains.join(", ")}]`);
}

async function addDomainToGroup(domain) {
  const gl = await getGroupLimit();
  const domains = gl ? gl.domains : [];
  if (!domains.includes(domain)) {
    domains.push(domain);
    await chrome.storage.local.set({
      groupLimit: { groupLimitMs: gl?.groupLimitMs ?? 0, domains },
    });
  }
}

async function removeDomainFromGroup(domain) {
  const gl = await getGroupLimit();
  if (!gl) return;
  const domains = gl.domains.filter((d) => d !== domain);
  await chrome.storage.local.set({ groupLimit: { ...gl, domains } });
}

async function clearGroupLimit() {
  await chrome.storage.local.remove("groupLimit");
  console.log("[GroupLimit] Cleared");
}

/**
 * Called after every session save for domains that belong to a group.
 * Sums saved usage across all group domains, determines status, and:
 *   - If exceeded: directly redirects ALL open group-domain tabs to blocked.html
 *   - If warning:  broadcasts LIMIT_STATUS so content.js shows a toast
 */
async function checkGroupLimit(domain) {
  const [groupLimit, usage] = await Promise.all([getGroupLimit(), getUsage()]);
  if (!groupLimit || !groupLimit.domains.includes(domain)) return;
  if (!groupLimit.groupLimitMs) return;

  const groupSpentMs = groupLimit.domains.reduce(
    (sum, d) => sum + (usage[d] ?? 0), 0
  );
  const remainingMs = Math.max(0, groupLimit.groupLimitMs - groupSpentMs);
  const pct = groupSpentMs / groupLimit.groupLimitMs;

  let status = "ok";
  if (remainingMs === 0) status = "exceeded";
  else if (pct >= 0.9) status = "warning_10pct";
  else if (remainingMs <= 5 * 60_000) status = "warning_5min";
  else if (remainingMs <= 10 * 60_000) status = "warning_10min";

  console.log(`[GroupLimit] ${groupSpentMs}ms / ${groupLimit.groupLimitMs}ms → ${status}`);

  if (status === "exceeded") {
    // Check grace period — if active, don't block
    const graceActive = await isGracePeriodActive("__group__");
    if (graceActive) {
      console.log("[GroupLimit] Exceeded but grace period active — allowing");
      return { groupSpentMs, limitMs: groupLimit.groupLimitMs, remainingMs, status };
    }

    // Redirect every open tab that belongs to any group domain
    const blockedUrl = chrome.runtime.getURL(
      `blocked.html?domain=${encodeURIComponent(domain)}&spent=${groupSpentMs}&limit=${groupLimit.groupLimitMs}&type=group&domains=${encodeURIComponent(groupLimit.domains.join(","))}`
    );
    for (const d of groupLimit.domains) {
      const tabs = await chrome.tabs.query({ url: [`*://*.${d}/*`, `*://${d}/*`] });
      for (const tab of tabs) {
        // Don't redirect tabs already showing the blocked page
        if (!tab.url?.includes("blocked.html")) {
          chrome.tabs.update(tab.id, { url: blockedUrl }).catch(() => {});
          console.log(`[GroupLimit] Redirected tab ${tab.id} (${d}) to blocked page`);
        }
      }
    }
  } else if (status !== "ok") {
    // Warning — broadcast to open group-domain tabs so content.js shows a toast
    for (const d of groupLimit.domains) {
      const tabs = await chrome.tabs.query({ url: [`*://*.${d}/*`, `*://${d}/*`] });
      for (const tab of tabs) {
        chrome.tabs.sendMessage(tab.id, {
          type: "LIMIT_STATUS",
          domain: d,
          spentMs: groupSpentMs,
          limitMs: groupLimit.groupLimitMs,
          remainingMs,
          status,
          isGroup: true,
          groupDomains: groupLimit.domains,
        }).catch(() => {});
      }
    }
  }

  return { groupSpentMs, limitMs: groupLimit.groupLimitMs, remainingMs, status };
}

// ─── Message API (for popup / content scripts) ─

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  // Every branch must either call sendResponse synchronously and return nothing,
  // OR return true to keep the port open for an async sendResponse.
  // An unmatched message must return false (not undefined) so Chrome knows
  // the port is intentionally closed with no response.

  switch (msg.type) {

    // ── Session / usage ───────────────────────

    case "GET_USAGE_TODAY":
      getUsage().then(sendResponse);
      return true;

    case "GET_CURRENT_SESSION":
      sendResponse({
        domain: currentSession.domain,
        elapsedMs: currentSession.startTime
          ? Date.now() - currentSession.startTime
          : 0,
      });
      return false; // sync — port can close immediately

    // ── Individual limit management ───────────

    case "GET_LIMITS":
      getLimits().then(sendResponse);
      return true;

    case "SET_LIMIT":
      // Save limit then immediately check if it's already breached
      setLimit(msg.domain, msg.limitMs)
        .then(() => checkLimitForDomain(msg.domain))
        .then(sendResponse);
      return true;

    case "REMOVE_LIMIT":
      removeLimit(msg.domain).then(() => sendResponse({ ok: true }));
      return true;

    case "CHECK_LIMIT":
      checkLimitForDomain(msg.domain).then(sendResponse);
      return true;

    // ── Enforcement ───────────────────────────

    case "CONTINUE_ANYWAY":
      grantGracePeriod(msg.domain).then(() => sendResponse({ ok: true }));
      return true;

    case "CONTINUE_ANYWAY_GROUP":
      grantGracePeriod("__group__").then(() => sendResponse({ ok: true }));
      return true;

    case "GET_ENFORCEMENT_STATE":
      getEnforcementState().then(sendResponse);
      return true;

    // ── Group limit management ─────────────────

    case "GET_GROUP_LIMIT":
      getGroupLimit().then(sendResponse);
      return true;

    case "SET_GROUP_LIMIT":
      setGroupLimit(msg.groupLimitMs, msg.domains).then(() => sendResponse({ ok: true }))
      .catch((e) => console.error("Error setting group limit:",e));
      return true;

    case "ADD_DOMAIN_TO_GROUP":
      addDomainToGroup(msg.domain).then(() => sendResponse({ ok: true }));
      return true;

    case "REMOVE_DOMAIN_FROM_GROUP":
      removeDomainFromGroup(msg.domain).then(() => sendResponse({ ok: true }));
      return true;

    case "CLEAR_GROUP_LIMIT":
      clearGroupLimit().then(() => sendResponse({ ok: true }));
      return true;

    default:
      // Unknown message type — close the port cleanly with no response
      return false;
  }
});