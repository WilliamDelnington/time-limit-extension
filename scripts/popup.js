// ─────────────────────────────────────────────
//  popup.js  –  Popup Control Panel Logic
// ─────────────────────────────────────────────

function formatMs(ms) {
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

async function refresh() {
  // Current Session
  chrome.runtime.sendMessage({ type: "GET_CURRENT_SESSION" }, (session) => {
    if (chrome.runtime.lastError) return; // service worker waking up — skip this tick
    const domainEl  = document.getElementById("session-domain");
    const elapsedEl = document.getElementById("session-elapsed");

    if (session?.domain) {
      domainEl.textContent  = session.domain;
      elapsedEl.textContent = formatMs(session.elapsedMs) + " elapsed";
    } else {
      domainEl.textContent  = "No active tab";
      elapsedEl.textContent = "";
    }
  });

  // Get the usage used today
  chrome.runtime.sendMessage({ type: "GET_USAGE_TODAY" }, async (usage) => {
    if (chrome.runtime.lastError) return;
    if (!usage) return;

    const { limits = {}, groupLimit } = await chrome.storage.local.get(["limits", "groupLimit"]);
    const listEl = document.getElementById("usage-list");
    const groupEl = document.getElementById("group-usage")

    // Build the set of domains that have any limit (individual or group).
    // Only these should appear in the popup — untracked sites are hidden.
    const trackedIndividualDomains = new Set([
      ...Object.keys(limits),
    ]);

    const trackedGroupDomains = groupLimit?.domains ?? []

    const individualEntries = Object.entries(usage)
      .filter(([domain]) => trackedIndividualDomains.has(domain))
      .sort((a, b) => b[1] - a[1]);

    if (individualEntries.length === 0) {
      listEl.innerHTML = `<div class="empty-state">No tracked sites visited today.</div>`;
      return;
    } else {
      listEl.innerHTML = individualEntries.map(([domain, ms]) => {
      // const isGroupMember = groupLimit?.domains?.includes(domain);

      // For group members, show the shared spent total and group budget
      // const displayMs =;
      // isGroupMember && !limits[domain]
      //   ? groupLimit.domains.reduce((sum, d) => sum + (usage[d] ?? 0), 0)
      //   : ms
      const displayLimit = limits[domain];
      // isGroupMember && !limits[domain]
      //   ? groupLimit.grouplimitMs
      //   : 

      let barHtml = "";
      if (displayLimit) {
        const pct = Math.min(100, (ms / displayLimit) * 100);
        const cls = pct >= 100 ? "exceeded" : pct >= 80 ? "warning" : "";
        barHtml = `
          <div class="progress-bar">
            <div class="progress-fill ${cls}" style="width:${pct}%"></div>
          </div>`;
      }

      const timeLabel = displayLimit
        ? `${formatMs(ms)} / ${formatMs(displayLimit)}`
        : formatMs(ms);

      const btnLabel = limits[domain] ? "edit" : "+ limit";
      return `
        <div class="usage-row">
          <div class="usage-meta">
            <span class="usage-domain">${domain}</span>
            <span style="display:flex;align-items:center;gap:6px">
              <span class="usage-time">${timeLabel}</span>
              <button class="limit-btn" data-domain="${domain}">
                ${btnLabel}
              </button>
            </span>
          </div>
          ${barHtml}
        </div>`;
      }).join("");

      // Wire up limit buttons — open options page with domain pre-filled
      listEl.querySelectorAll(".limit-btn").forEach((btn) => {
        btn.addEventListener("click", () => {
          const domain = btn.dataset.domain;
          chrome.runtime.openOptionsPage();
          // Pass domain via storage so options page can pre-fill it
          chrome.storage.local.set({ _prefillDomain: domain });
        });
      });
    }

    if (trackedGroupDomains) {
      var totalUsageMs = 0

      var groupEntries = Object.entries(usage)
      .filter(([domain]) => trackedGroupDomains.includes(domain))

      groupEntries.forEach((entry) => {
        totalUsageMs += entry[1]
      })

      let groupBarHtml = ""
      if (groupLimit && groupLimit.groupLimitMs) {
        const grpPct = Math.min(100, (totalUsageMs / groupLimit.groupLimitMs) * 100)
        const grpCls = grpPct >= 100 ? "exceeded" : grpPct >= 80 ? "warning" : "";
        groupBarHtml = `
          <div class="progress-bar">
            <div class="progress-fill ${grpCls}" style="width:${grpPct}%"></div>
          </div>
        `
      }

      var printGroupLine = trackedGroupDomains.join(",")
      const groupTimeLabel = groupLimit.groupLimitMs ?
      `${formatMs(totalUsageMs)} / ${formatMs(groupLimit.groupLimitMs)}` : formatMs(totalUsageMs)

      groupEl.innerHTML = `
      <div class="usage-row">
        <div class="usage-meta">
          <span class="usage-domain">${printGroupLine.length > 40 ? printGroupLine.substring(0, 40) + "..." : printGroupLine}</span>
          <span style="display:flex;align-items:center;gap:6px">
            <span class="usage-time">${groupTimeLabel}</span>
            <button class="limit-btn" data-domain="${trackedGroupDomains}">
              +limit
            </button>
          </span>
        </div>
        ${groupBarHtml}
      </div>
      `
    }
  });
}

// Refresh on open, then every second
refresh();
setInterval(refresh, 10000);