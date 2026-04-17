// ─────────────────────────────────────────────
//  storage.js  –  Storage Abstraction Layer
//  A clean, promise-based API over chrome.storage.local.
//  Import this wherever you need to read/write usage data.
// ─────────────────────────────────────────────


const Storage = (() => {
  // ── Key helpers ────────────────────────────

  function dateKey(date = new Date()) {
    return date.toLocaleDateString("en-CA"); // "YYYY-MM-DD"
  }

  // ── Usage data ─────────────────────────────

  /**
   * Returns today's usage map: { "youtube.com": 1234567, ... }
   * Values are in milliseconds.
   */
  async function getUsageToday() {
    const key = dateKey();
    const result = await chrome.storage.local.get(key);
    return result[key] ?? {};
  }

  /**
   * Returns usage for a specific date string ("YYYY-MM-DD").
   */
  async function getUsageFor(dateString) {
    const result = await chrome.storage.local.get(dateString);
    return result[dateString] ?? {};
  }

  /**
   * Adds `durationMs` to domain's total for today.
   */
  async function addUsage(domain, durationMs) {
    const key = dateKey();
    const result = await chrome.storage.local.get(key);
    const usage = result[key] ?? {};
    usage[domain] = (usage[domain] ?? 0) + durationMs;
    await chrome.storage.local.set({ [key]: usage });
  }

  // ── Limits ─────────────────────────────────

  /**
   * Returns all stored limits: { "youtube.com": 1800000, ... }
   * Values are in milliseconds.
   */
  async function getLimits() {
    const { limits } = await chrome.storage.local.get("limits");
    return limits ?? {};
  }

  /**
   * Sets a daily limit for a domain.
   * @param {string} domain   e.g. "youtube.com"
   * @param {number} limitMs  limit in milliseconds
   */
  async function setLimit(domain, limitMs) {
    const limits = await getLimits();
    limits[domain] = limitMs;
    await chrome.storage.local.set({ limits });
  }

  async function setGroupLimit(limitMs) {
    const limits = await getLimits()
    limits["group"] = limitMs;
    await chrome.storage.local.set({ limits });
  }

  /**
   * Removes the limit for a domain.
   */
  async function removeLimit(domain) {
    const limits = await getLimits();
    delete limits[domain];
    await chrome.storage.local.set({ limits });
  }

  /**
   * Removes the limit for a domain.
   */
  async function removeGroupLimit() {
    const limits = await getLimits();
    delete limits["group"]
    await chrome.storage.local.set({ limits })
  }

  async function getGroups() {
    const { groups } = await chrome.storage.local.get("groups");
    return groups ?? {};
  }

  async function setGroup(groupId, groupData) {
    const groups = await getGroups();
    groups[groupId] = groupData;
    await chrome.storage.local.set({ groups });
  }

  /**
   * Remove a group
   */
  async function removeGroup(groupId) {
    const groups = await getGroups();
    delete groups[groupId];
    await chrome.storage.local.set({ groups });
  }

  /**
   * Returns total usage for a group today
   */
  async function getGroupUsage(groupId) {
    const [usage, groups] = await Promise.all([
      getUsageToday(),
      getGroups()
    ]);

    const group = groups[groupId];
    if (!group) return 0;

    return group.domains.reduce((sum, d) => {
      return sum + (usage[d] ?? 0);
    }, 0);
}

/**
 * Remaining time for group
 */
async function getGroupRemainingMs(groupId) {
  const groups = await getGroups();
  const group = groups[groupId];
  if (!group) return Infinity;

  const spent = await getGroupUsage(groupId);
  return Math.max(0, group.groupLimitMs - spent);
}

  // ── Convenience: usage vs limit ────────────

  /**
   * Returns remaining time in ms for a domain today.
   * Returns Infinity if no limit is set.
   */
  async function getRemainingMs(domain) {
    const [usage, limits] = await Promise.all([getUsageToday(), getLimits()]);
    const limit = limits[domain];
    if (limit == null) return Infinity;
    const spent = usage[domain] ?? 0;
    return Math.max(0, limit - spent);
  }

  // ── Prune old data ─────────────────────────

  async function pruneOldData(keepDays = 30) {
    const all = await chrome.storage.local.get(null);
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - keepDays);

    const toRemove = Object.keys(all).filter((k) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(k)) return false;
      return new Date(k) < cutoff;
    });

    if (toRemove.length) {
      await chrome.storage.local.remove(toRemove);
    }
    return toRemove;
  }

  // ── Public API ─────────────────────────────
  return {
    dateKey,
    getUsageToday,
    getUsageFor,
    addUsage,
    getLimits,
    setLimit,
    removeLimit,
    getRemainingMs,
    pruneOldData,
    getGroups,
    setGroup,
    removeGroup,
    getGroupUsage,
    getGroupRemainingMs,
  };
})();

// Allow import in service workers and content scripts
if (typeof module !== "undefined") module.exports = Storage;