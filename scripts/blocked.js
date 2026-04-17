// ─────────────────────────────────────────────
//  blocked.js  –  Blocked Page Logic
//
//  Shown when a domain's daily limit is exceeded
//  and the user navigates to it (or is redirected
//  here by content.js after the limit tips over).
//
//  Actions available:
//    1. Open a new tab            → chrome.tabs.create
//    2. Continue anyway           → confirm dialog
//       → CONTINUE_ANYWAY msg     → background grants grace period
//       → history.back() to return to the blocked site
//    3. Adjust limit in settings  → chrome.runtime.openOptionsPage()
// ─────────────────────────────────────────────

// ─── Read URL params ──────────────────────────

const params      = new URLSearchParams(location.search);
const domain      = params.get("domain")  ?? "this site";
const spentMs     = parseInt(params.get("spent") ?? "0", 10);
const limitMs     = parseInt(params.get("limit") ?? "0", 10);
const blockType   = params.get("type") ?? "individual";   // "individual" | "group"
const groupDomains = params.get("domains")
  ? decodeURIComponent(params.get("domains")).split(",")
  : [];

const isGroup = blockType === "group";

// ─── Render stats ─────────────────────────────

if (isGroup) {
  document.getElementById("domain-label").textContent = "group budget";
  document.getElementById("domain-label").style.background = "#e8f5e9";
  document.getElementById("domain-label").style.color = "#2e7d32";
  document.querySelector("h1").textContent = "Group budget reached";

  // Show which domains are in the group below the stats
  if (groupDomains.length > 0) {
    const note = document.createElement("p");
    note.style.cssText = "font-size:12px;color:#888;margin-bottom:16px;";
    note.textContent = `Tracked sites: ${groupDomains.join(", ")}`;
    document.querySelector(".stats").after(note);
  }
} else {
  document.getElementById("domain-label").textContent = domain;
}

document.getElementById("stat-spent").textContent = formatMs(spentMs);
document.getElementById("stat-limit").textContent = formatMs(limitMs);

// ─── Actions ──────────────────────────────────

// 1. Open new tab
document.getElementById("btn-newtab").addEventListener("click", () => {
  chrome.tabs.create({ url: "chrome://newtab" });
  window.close();
});

// 2. Continue anyway — show confirmation first
const confirmBox = document.getElementById("confirm-box");

document.getElementById("btn-continue").addEventListener("click", () => {
  confirmBox.classList.add("visible");
  document.getElementById("btn-confirm-yes").focus();
});

document.getElementById("btn-confirm-no").addEventListener("click", () => {
  confirmBox.classList.remove("visible");
  document.getElementById("btn-continue").focus();
});

document.getElementById("btn-confirm-yes").addEventListener("click", () => {
  // Ask background to grant a grace period
  const continueType = isGroup ? "CONTINUE_ANYWAY_GROUP" : "CONTINUE_ANYWAY";
  chrome.runtime.sendMessage({ type: continueType, domain }, () => {
    if (chrome.runtime.lastError) { console.warn('blocked.js sendMessage:', chrome.runtime.lastError.message); return; }
    // Navigate back to the site — grace period is now active so
    // background.js will allow the session to start
    if (history.length > 1) {
      history.back();
    } else {
      location.replace(`https://${domain}`);
    }
  });
});

// 3. Open settings
document.getElementById("btn-settings").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

document.getElementById("link-settings").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

// ─── Helpers ──────────────────────────────────

function formatMs(ms) {
  if (!ms) return "—";
  const totalMin = Math.floor(ms / 60_000);
  if (totalMin < 60) return `${totalMin}m`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}