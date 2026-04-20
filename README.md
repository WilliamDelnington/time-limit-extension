# Time Limitter

A Chrome extension that tracks time spent on websites and enforces daily limits — with support for per-site limits, shared group budgets, and a live usage dashboard.

---

## Features

### Dashboard (popup)
Click the extension icon to open the dashboard. It shows:
- **Now tracking** — the domain currently active in your browser, with a live elapsed timer.
- **Today's usage** — a list of every site that has a limit set, showing time spent and a progress bar. The bar turns orange at 80% and red when the limit is exceeded. Sites without any limit are hidden — only tracked domains appear.
- **Quick limit shortcut** — each row has an "edit" or "+ limit" button that opens the settings page with that domain pre-filled.

The dashboard refreshes every second, so the elapsed time and progress bars stay live while it is open.

---

### Individual limits
Set a daily time budget per site. When the limit is reached, the site is blocked for the rest of the day.

To add a limit:
1. Open the extension popup and click **Manage limits →**, or right-click the extension icon and choose **Options**.
2. In the **Individual** tab, enter a domain (e.g. `youtube.com`) and a time in hours and minutes.
3. Click **Save limit**.

Existing limits appear in the list below the form. Each row has an **Edit** button (opens an inline editor) and a **Remove** button.

---

### Group limits
Set a single shared daily budget across a group of sites. The combined time spent on all sites in the group counts against one limit — useful when you want to cap total "distraction time" rather than managing each site individually.

To set up a group:
1. Open **Options** and switch to the **Group** tab.
2. Set the shared time budget using the hours and minutes fields, then click **Save group time limit**.
3. Add domains one at a time using the domain field. Each added domain appears in the **Group Domains** list below.
4. To remove a domain from the group, click **Remove** next to it.

The group budget and domain list persist across browser restarts. You can change the budget at any time by re-entering the time and saving — the domain list is preserved.

> **Note:** A domain must be added *after* a budget is set. The extension will warn you if you try to add a domain before a budget exists.

---

### Enforcement
When a limit is reached, the extension enforces it in two ways depending on whether you are already on the site or navigating to it.

**While browsing (mid-session):** A full-page overlay appears with a 5-second countdown. You can:
- Wait for the countdown and be redirected automatically.
- Click **Go somewhere else** to redirect immediately.
- Click **Continue anyway** to get a 10-minute grace period.

**On navigation:** If you try to open a blocked site (by typing the URL, clicking a link, or switching to a tab), you are taken directly to the blocked page without a countdown.

**Warning toasts:** At 10 minutes, 5 minutes, and when under 10% of the budget remains, a small toast appears in the bottom-right corner of the page. It auto-dismisses after a few seconds and can be manually closed.

**The blocked page** shows how much time was used vs. the limit and offers three actions:
- **Open a new tab** — closes the blocked page and opens a fresh tab.
- **Continue anyway** — shows a confirmation dialog, then grants a 10-minute grace period.
- **Adjust limit in settings** — opens the options page directly.

Grace periods reset at midnight along with all daily usage.

---

## How time is tracked

Sessions are tracked per domain (not per tab). A session starts when a domain becomes the active tab and ends when the tab is switched away, closed, the window loses focus, or the system goes idle. Sessions shorter than 1 second are discarded to filter out accidental flicks.

Usage is stored per calendar day and kept for 30 days before being pruned. Limits themselves are stored indefinitely until you remove them.

---

## File structure

```
time-tracker/
├── manifest.json       Extension manifest (MV3)
├── background.js       Service worker — session tracking, limit checking, enforcement
├── content.js          Injected into pages — activity detection, warning toasts, mid-session overlay
├── storage.js          Storage abstraction layer
├── popup.html          Dashboard UI (shown when clicking the extension icon)
├── popup.js            Dashboard logic
├── options.html        Settings page — individual and group limit management
├── options.js          Settings logic
├── blocked.html        Page shown when a site is blocked
├── blocked.js          Blocked page logic
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

---

## Installation

This extension is not on the Chrome Web Store. To install it locally:

1. Download or clone this repository.
2. Open Chrome and go to `chrome://extensions`.
3. Enable **Developer mode** using the toggle in the top-right corner.
4. Click **Load unpacked** and select the `time-tracker` folder.
5. The extension icon will appear in your toolbar. Pin it for easy access.

To update after making changes to the source files, go back to `chrome://extensions` and click the refresh icon on the extension card.
