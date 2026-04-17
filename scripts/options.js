// ─────────────────────────────────────────────
//  options.js  –  Limit Management Logic
//
//  Two modes:
//    Individual — per-domain daily time limits (original)
//    Group      — one shared budget across a set of domains
//
//  Storage layout (via background messages):
//    limits:     { "youtube.com": 1800000, ... }        individual
//    groupLimit: { limitMs: 7200000, domains: [...] }   group
// ─────────────────────────────────────────────

// ─── Helpers ──────────────────────────────────

function normaliseDomain(raw) {
  raw = raw.trim().toLowerCase();
  if (!raw) return null;
  if (raw.startsWith("http://") || raw.startsWith("https://")) {
    try { raw = new URL(raw).hostname; } catch { return null; }
  }
  raw = raw.replace(/^www\./, "");
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(raw)) return null;
  return raw;
}

function toMs(hours, minutes) {
  return (parseInt(hours, 10) * 60 + parseInt(minutes, 10)) * 60_000;
}

function fromMs(ms) {
  const totalMin = Math.floor(ms / 60_000);
  return { hours: Math.floor(totalMin / 60), minutes: totalMin % 60 };
}

function formatLimit(ms) {
  const { hours, minutes } = fromMs(ms);
  if (hours === 0) return `${minutes}m`;
  if (minutes === 0) return `${hours}h`;
  return `${hours}h ${minutes}m`;
}

// ─── Toast ────────────────────────────────────

let toastTimer = null;
function showToast(msg) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2500);
}

// ─── Background message bridge ────────────────

const bg = {
  send: (msg) => new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (response) => {
      // Always consume lastError — Chrome throws an unchecked error if it isn't
      // read, even when the operation succeeded. This is common in MV3 when the
      // service worker wakes up mid-message or a default case returns false.
      if (chrome.runtime.lastError) {
        console.warn(`[bg.send] ${msg.type}:`, chrome.runtime.lastError.message);
      }
      resolve(response);
    });
  }),
  getLimits:             ()             => bg.send({ type: "GET_LIMITS" }),
  setLimit:              (domain, ms)   => bg.send({ type: "SET_LIMIT", domain, limitMs: ms }),
  removeLimit:           (domain)       => bg.send({ type: "REMOVE_LIMIT", domain }),
  getGroupLimit:         ()             => bg.send({ type: "GET_GROUP_LIMIT" }),
  setGroupLimit:         (ms, domains)  => bg.send({ type: "SET_GROUP_LIMIT", groupLimitMs: ms, domains }),
  addDomainToGroup:      (domain)       => bg.send({ type: "ADD_DOMAIN_TO_GROUP", domain }),
  removeDomainFromGroup: (domain)       => bg.send({ type: "REMOVE_DOMAIN_FROM_GROUP", domain }),
  clearGroupLimit:       ()             => bg.send({ type: "CLEAR_GROUP_LIMIT" }),
};

// ─── Mode switch ──────────────────────────────

let currentMode = "individual"; // "individual" | "group"

document.getElementById("tab-individual").addEventListener("click", () => switchMode("individual"));
document.getElementById("tab-group").addEventListener("click",      () => switchMode("group"));

function switchMode(mode) {
  currentMode = mode;

  document.getElementById("tab-individual").classList.toggle("active", mode === "individual");
  document.getElementById("tab-group").classList.toggle("active", mode === "group");

  document.querySelector(".individual-container").classList.toggle("active", mode === "individual");
  document.querySelector(".group-container").classList.toggle("active", mode === "group");

  if (mode === "individual") renderLimits();
  if (mode === "group")      renderGroup();
}

// ─────────────────────────────────────────────
//  INDIVIDUAL MODE
// ─────────────────────────────────────────────

// ─── Render individual limits list ────────────

async function renderLimits() {
  const limits = await bg.getLimits();
  const listEl = document.getElementById("limits-list");
  const entries = Object.entries(limits);

  if (entries.length === 0) {
    listEl.innerHTML = `<div class="empty-state">No limits set yet.</div>`;
    return;
  }

  entries.sort((a, b) => a[0].localeCompare(b[0]));

  listEl.innerHTML = entries.map(([domain, ms]) => `
    <div class="limit-row" data-domain="${domain}" data-ms="${ms}">
      <span class="limit-domain">${domain}</span>
      <span class="limit-value">${formatLimit(ms)}</span>
      <div class="limit-actions">
        <button class="btn-secondary btn-edit" data-domain="${domain}">Edit</button>
        <button class="btn-danger btn-delete" data-domain="${domain}">Remove</button>
      </div>
    </div>
  `).join("");

  listEl.querySelectorAll(".btn-edit").forEach((btn) =>
    btn.addEventListener("click", () => startInlineEdit(btn.dataset.domain))
  );
  listEl.querySelectorAll(".btn-delete").forEach((btn) =>
    btn.addEventListener("click", () => handleDelete(btn.dataset.domain))
  );
}

// ─── Inline edit ──────────────────────────────

function startInlineEdit(domain) {
  document.querySelectorAll(".limit-row.editing").forEach((r) => r.classList.remove("editing"));

  const row = document.querySelector(`.limit-row[data-domain="${domain}"]`);
  if (!row) return;

  const { hours, minutes } = fromMs(parseInt(row.dataset.ms, 10));
  row.classList.add("editing");
  row.innerHTML = `
    <span class="limit-domain">${domain}</span>
    <div class="inline-edit">
      <input type="number" class="edit-hours"   min="0" max="23" value="${hours}"   style="width:64px" />
      <span style="color:#666;font-size:12px">h</span>
      <input type="number" class="edit-minutes" min="0" max="59" value="${minutes}" style="width:64px" />
      <span style="color:#666;font-size:12px">m</span>
    </div>
    <div class="limit-actions">
      <button class="btn-primary   btn-save-edit"   data-domain="${domain}">Save</button>
      <button class="btn-secondary btn-cancel-edit">Cancel</button>
    </div>
  `;
  row.querySelector(".btn-save-edit").addEventListener("click", () => handleSaveEdit(domain, row));
  row.querySelector(".btn-cancel-edit").addEventListener("click", () => renderLimits());
  row.querySelector(".edit-hours").focus();
}

async function handleSaveEdit(domain, row) {
  const limitMs = toMs(row.querySelector(".edit-hours").value, row.querySelector(".edit-minutes").value);
  if (limitMs <= 0) { showToast("Limit must be greater than 0 minutes."); return; }
  await bg.setLimit(domain, limitMs);
  showToast(`Updated limit for ${domain} to ${formatLimit(limitMs)}.`);
  renderLimits();
}

async function handleDelete(domain) {
  await bg.removeLimit(domain);
  showToast(`Removed limit for ${domain}.`);
  renderLimits();
}

// ─── Add individual limit form ─────────────────

const domainInput  = document.getElementById("input-domain");
const hoursInput   = document.getElementById("input-hours");
const minutesInput = document.getElementById("input-minutes");
const addError     = document.getElementById("add-error");

document.getElementById("btn-add").addEventListener("click", handleAdd);
[domainInput, hoursInput, minutesInput].forEach((el) =>
  el.addEventListener("keydown", (e) => { if (e.key === "Enter") handleAdd(); })
);

async function handleAdd() {
  addError.textContent = "";

  const domain = normaliseDomain(domainInput.value);
  if (!domain) {
    addError.textContent = "Please enter a valid domain (e.g. youtube.com).";
    domainInput.focus();
    return;
  }

  const limitMs = toMs(hoursInput.value, minutesInput.value);
  if (limitMs <= 0) {
    addError.textContent = "Limit must be at least 1 minute.";
    minutesInput.focus();
    return;
  }

  const existing = await bg.getLimits();
  if (existing[domain] != null) {
    addError.textContent = `A limit for ${domain} already exists. Use the Edit button to change it.`;
    return;
  }

  await bg.setLimit(domain, limitMs);
  showToast(`Limit set: ${domain} → ${formatLimit(limitMs)} per day.`);
  domainInput.value = ""; hoursInput.value = "0"; minutesInput.value = "30";
  renderLimits();
}

// ─────────────────────────────────────────────
//  GROUP MODE
// ─────────────────────────────────────────────

// ─── Render group panel ────────────────────────

async function renderGroup() {
  const gl = await bg.getGroupLimit();
  renderGroupBudget(gl);
  renderGroupDomains(gl ? gl.domains : []);
}

function renderGroupBudget(gl) {
  // Show current budget above the form if one is already saved
  const card = document.querySelector(".group-container .card");
  const existing = card.querySelector(".group-budget-display");
  if (existing) existing.remove();

  if (gl && gl.limitMs > 0) {
    const badge = document.createElement("div");
    badge.className = "group-budget-display";
    badge.textContent = `Current group budget: ${formatLimit(gl.limitMs)} shared across all group domains.`;
    const title = card.querySelector(".card-title");
    title.after(badge);
  }

  // Pre-fill the time inputs if a limit already exists
  if (gl && gl.limitMs) {
    const { hours, minutes } = fromMs(gl.limitMs);
    document.getElementById("group-input-hours").value   = hours;
    document.getElementById("group-input-minutes").value = minutes;
  }
}

function renderGroupDomains(domains) {
  const container = document.getElementById("domain-list");

  if (domains.length === 0) {
    container.innerHTML = `<div class="empty-state">No domains in the group yet.</div>`;
    return;
  }

  container.innerHTML = domains.map((domain) => `
    <div class="domain-item" data-domain="${domain}">
      <span class="domain-item-name">${domain}</span>
      <button class="btn-danger btn-remove-domain" data-domain="${domain}">Remove</button>
    </div>
  `).join("");

  container.querySelectorAll(".btn-remove-domain").forEach((btn) =>
    btn.addEventListener("click", () => handleRemoveDomain(btn.dataset.domain))
  );
}

// ─── Group time limit ──────────────────────────

document.getElementById("btn-group-save").addEventListener("click", handleGroupSave);
["group-input-hours", "group-input-minutes"].forEach((id) =>
  document.getElementById(id).addEventListener("keydown", (e) => {
    if (e.key === "Enter") handleGroupSave();
  })
);

async function handleGroupSave() {
  const limitMs = toMs(
    document.getElementById("group-input-hours").value,
    document.getElementById("group-input-minutes").value
  );

  if (limitMs <= 0) {
    showToast("Group budget must be at least 1 minute.");
    return;
  }

  const gl = await bg.getGroupLimit();
  const domains = gl ? gl.domains : [];
  await bg.setGroupLimit(limitMs, domains);
  showToast(`Group budget set to ${formatLimit(limitMs)}.`);
  renderGroup();
}

// ─── Group domains ─────────────────────────────

const groupDomainInput = document.getElementById("domain-input");

document.getElementById("btn-set-group").addEventListener("click", handleAddGroupDomain);
groupDomainInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") handleAddGroupDomain();
});

async function handleAddGroupDomain() {
  const domain = normaliseDomain(groupDomainInput.value);
  
  if (!domain) {
    showToast("Please enter a valid domain (e.g. youtube.com).");
    groupDomainInput.focus();
    return;
  }

  const gl = await bg.getGroupLimit();

  // Prevent duplicate
  if (gl && gl.domains.includes(domain)) {
    showToast(`${domain} is already in the group.`);
    return;
  }

  // Warn if the group has no time budget set yet
  if (!gl || !gl.groupLimitMs) {
    showToast("Set a group budget first, then add domains.");
    document.getElementById("group-input-hours").focus();
    return;
  }

  await bg.addDomainToGroup(domain);
  showToast(`Added ${domain} to the group.`);
  groupDomainInput.value = "";
  renderGroup();
}

async function handleRemoveDomain(domain) {
  await bg.removeDomainFromGroup(domain);
  showToast(`Removed ${domain} from the group.`);
  renderGroup();
}

// ─── Pre-fill from popup shortcut ─────────────

async function checkPrefill() {
  const { _prefillDomain } = await chrome.storage.local.get("_prefillDomain");
  if (!_prefillDomain) return;

  domainInput.value = _prefillDomain;
  domainInput.focus();
  await chrome.storage.local.remove("_prefillDomain");

  const limits = await bg.getLimits();
  if (limits[_prefillDomain] != null) {
    await renderLimits();
    const row = document.querySelector(`.limit-row[data-domain="${_prefillDomain}"]`);
    if (row) {
      row.scrollIntoView({ behavior: "smooth", block: "center" });
      startInlineEdit(_prefillDomain);
    }
  }
}

// ─── Init ──────────────────────────────────────

// Start in individual mode — activate the panel
switchMode("individual");
checkPrefill();