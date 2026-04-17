const MONTH_NAMES = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const DAY_NAMES   = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
const WEEK_LABELS = ["M","T","W","T","F","S","S"]; // Mon–Sun

document.addEventListener("DOMContentLoaded", () => { init(); });

async function init() {
  const today    = new Date();
  const todayKey = today.toLocaleDateString("en-CA");

  document.getElementById("header-date").textContent =
    `${DAY_NAMES[today.getDay()]}, ${MONTH_NAMES[today.getMonth()]} ${today.getDate()}, ${today.getFullYear()}`;

  const allData  = await chrome.storage.local.get(null);
  const limits   = allData.limits ?? {};
  const todayUsage = allData[todayKey] ?? {};

  // Build current ISO week (Mon–Sun)
  const weekDates = getCurrentWeekDates(today);

  // Accumulate usage and track which days have data
  const weekTotals = {};   // { domain: totalMs }
  let daysWithData = 0;
  const dayStatuses = [];  // [{ dateStr, hasData }, ...]

  for (const dateStr of weekDates) {
    const dayData = allData[dateStr] ?? {};
    const hasData = Object.keys(dayData).length > 0;
    dayStatuses.push({ dateStr, hasData });

    if (hasData) {
      daysWithData++;
      for (const [domain, ms] of Object.entries(dayData)) {
        weekTotals[domain] = (weekTotals[domain] ?? 0) + ms;
      }
    }
  }

  // Average = total this week / days that had any activity
  const weekAvg = {};
  if (daysWithData > 0) {
    for (const [domain, total] of Object.entries(weekTotals)) {
      weekAvg[domain] = total / daysWithData;
    }
  }

  renderTodayChart(todayUsage, limits);
  renderWeekContext(weekDates, dayStatuses, todayKey, daysWithData);
  renderWeeklyChart(weekAvg, limits, daysWithData);
}

// Returns the 7 date strings (YYYY-MM-DD) for Monday–Sunday of the week
// that contains `today`.
function getCurrentWeekDates(today) {
  const day = today.getDay(); // 0 = Sun
  const diffToMonday = day === 0 ? -6 : 1 - day;
  const monday = new Date(today);
  monday.setDate(today.getDate() + diffToMonday);

  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    return d.toLocaleDateString("en-CA");
  });
}

function formatMs(ms) {
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const hours   = Math.floor(totalSec / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  return `${minutes}m`;
}

function barColorClass(usageMs, limitMs) {
  if (limitMs == null) return "blue";
  const pct = usageMs / limitMs;
  if (pct >= 1)   return "red";
  if (pct >= 0.8) return "orange";
  return "green";
}

function buildBarRow(label, valueMs, auxText, fillPct, colorClass, limitMarkerPct) {
  const row = document.createElement("div");
  row.className = "bar-row";

  const markerHtml = (limitMarkerPct != null && limitMarkerPct > 0 && limitMarkerPct <= 100)
    ? `<div class="bar-limit-marker" style="left:${limitMarkerPct.toFixed(1)}%"></div>`
    : "";

  row.innerHTML = `
    <div class="bar-label" title="${label}">${label}</div>
    <div class="bar-track">
      <div class="bar-fill ${colorClass}" style="width:${Math.min(fillPct, 100).toFixed(1)}%"></div>
      ${markerHtml}
    </div>
    <div class="bar-value">${formatMs(valueMs)}</div>
    <div class="bar-aux">${auxText}</div>
  `;
  return row;
}

function renderTodayChart(usage, limits) {
  const container = document.getElementById("today-chart");
  const totalEl   = document.getElementById("today-total");

  const entries = Object.entries(usage).sort((a, b) => b[1] - a[1]);

  if (entries.length === 0) {
    totalEl.textContent = "";
    return;
  }

  const totalMs = entries.reduce((sum, [, ms]) => sum + ms, 0);
  totalEl.textContent = `Total: ${formatMs(totalMs)}`;

  // Scale max = highest of (all usages, all limits for those domains)
  const maxUsage = entries[0][1];
  const maxLimit = Math.max(0, ...entries.map(([d]) => limits[d] ?? 0));
  const scaleMax = Math.max(maxUsage, maxLimit) || 1;

  container.innerHTML = "";

  for (const [domain, ms] of entries) {
    const limit = limits[domain] ?? null;
    const fillPct        = (ms / scaleMax) * 100;
    const limitMarkerPct = limit != null ? (limit / scaleMax) * 100 : null;
    const colorClass     = barColorClass(ms, limit);
    const auxText        = limit != null ? `/ ${formatMs(limit)}` : "";

    container.appendChild(buildBarRow(domain, ms, auxText, fillPct, colorClass, limitMarkerPct));
  }
}

function renderWeekContext(weekDates, dayStatuses, todayKey, daysWithData) {
  const container = document.getElementById("week-context");

  const start = new Date(weekDates[0] + "T00:00:00");
  const end   = new Date(weekDates[6] + "T00:00:00");
  const rangeText = `${MONTH_NAMES[start.getMonth()]} ${start.getDate()} – ` +
                    `${MONTH_NAMES[end.getMonth()]} ${end.getDate()}`;

  const dotsHtml = dayStatuses.map(({ dateStr, hasData }, i) => {
    const isToday  = dateStr === todayKey;
    const isFuture = dateStr > todayKey;
    const cls = isToday ? "today" : (!isFuture && hasData ? "has-data" : "");
    return `<div class="day-dot ${cls}" title="${dateStr}">${WEEK_LABELS[i]}</div>`;
  }).join("");

  const avgNote = daysWithData > 0
    ? `· avg over ${daysWithData} day${daysWithData !== 1 ? "s" : ""}`
    : "";

  container.innerHTML = `
    <div class="week-days">${dotsHtml}</div>
    <span class="week-range">${rangeText} ${avgNote}</span>
  `;
}

function renderWeeklyChart(weekAvg, limits, daysWithData) {
  const container = document.getElementById("week-chart");
  const totalEl   = document.getElementById("week-total");

  const entries = Object.entries(weekAvg).sort((a, b) => b[1] - a[1]);

  if (entries.length === 0) {
    totalEl.textContent = "";
    return;
  }

  const maxAvg   = entries[0][1];
  const maxLimit = Math.max(0, ...entries.map(([d]) => limits[d] ?? 0));
  const scaleMax = Math.max(maxAvg, maxLimit) || 1;

  const totalAvgMs = entries.reduce((sum, [, ms]) => sum + ms, 0);
  totalEl.textContent = daysWithData > 0
    ? `${formatMs(totalAvgMs)} avg/day across all sites`
    : "";

  container.innerHTML = "";

  for (const [domain, avgMs] of entries) {
    const limit = limits[domain] ?? null;
    const fillPct        = (avgMs / scaleMax) * 100;
    const limitMarkerPct = limit != null ? (limit / scaleMax) * 100 : null;
    const colorClass     = barColorClass(avgMs, limit);

    container.appendChild(
      buildBarRow(domain, avgMs, "avg/day", fillPct, colorClass, limitMarkerPct)
    );
  }
}
