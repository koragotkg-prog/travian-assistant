# Popup UI Redesign Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Complete redesign of the popup dashboard with gaming theme, tab navigation, and improved UX.

**Architecture:** Rewrite 3 files (index.html, styles.css, popup.js). HTML gets tab-based layout with fixed header/controls. CSS gets full gaming dashboard theme with neon glow effects. JS adds tab switching while preserving ALL existing messaging, config, and data logic.

**Tech Stack:** Plain HTML/CSS/JS (no build tools, no dependencies). Chrome Extension Manifest V3 popup.

---

### Task 1: Rewrite popup/index.html

**Files:**
- Rewrite: `popup/index.html`

**Step 1: Write new HTML structure**

New layout with 4 sections:
- Fixed header: logo, status dot, village selector
- Fixed tab bar: 4 tab buttons (Dashboard, Config, AI, Logs)
- Scrollable tab content: 4 tab panels
- Fixed control bar: Start/Pause/Stop/Emergency

All existing element IDs must be preserved so popup.js DOM references still work. New IDs added for tabs: `tabDash`, `tabConfig`, `tabAI`, `tabLogs`, `panelDash`, `panelConfig`, `panelAI`, `panelLogs`.

Dashboard panel contains: statsBar, currentTask, features (toggle pills), queueSection.
Config panel contains: upgradeSection, troopSection, farmSection, delaySection, heroSection, saveSection.
AI panel contains: strategySection.
Logs panel contains: logsSection.

---

### Task 2: Rewrite popup/styles.css

**Files:**
- Rewrite: `popup/styles.css`

**Step 1: Write gaming dashboard CSS**

Color palette:
- bg-base: #0a0a1a, bg-surface: #12122a, border: #2a2a5a
- primary: #00e5ff, success: #00ff88, danger: #ff3366, warning: #ffaa00
- text: #e8e8f0, text-secondary: #7a7a9a

Key styles:
- Body: 420px width, 580px height, no scroll on body itself
- Header: gradient background (dark navy to subtle purple), fixed at top
- Tab bar: flex row, tabs with bottom border indicator, glow on active
- Tab content: flex-grow, overflow-y auto (only this area scrolls)
- Control bar: fixed at bottom, flex row with gap
- Cards: bg-surface with glow box-shadow, border-radius 8px
- Stats: 2x2 grid cards with glow borders
- Toggle pills: compact 2-column grid, cyan accent
- Buttons: neon glow on hover, gradient backgrounds
- Progress bar: gradient cyan-to-green
- Pulse animation on status dot
- Smooth tab switch transitions (opacity + transform)
- All existing class names preserved + new ones added

---

### Task 3: Refactor popup/popup.js for tab navigation

**Files:**
- Modify: `popup/popup.js`

**Step 1: Add tab switching logic**

Add at top of file (after DOM refs):
- New DOM refs: `tabDash`, `tabConfig`, `tabAI`, `tabLogs`, `panelDash`, `panelConfig`, `panelAI`, `panelLogs`
- `switchTab(tabName)` function: removes `active` class from all tabs/panels, adds to selected
- Event listeners for each tab button

**Step 2: Update DOM element references**

Add new refs to the `dom` object for any new HTML elements. All existing refs stay the same since we preserve element IDs.

**Step 3: Update bindEvents()**

Add tab click handlers. Keep all existing event bindings unchanged.

**Step 4: Update progress bar rendering**

Modify `updateTaskDisplay()` to render a visual progress bar element instead of just text percentage.

All existing functions (sendMessage, updateStatus, updateStats, updateLogs, updateQueue, renderStrategyDashboard, collectConfig, populateForm, etc.) stay unchanged — they reference element IDs which are preserved.

---

### Task 4: Visual verification

**Step 1:** Load extension in Chrome, open popup
**Step 2:** Verify all 4 tabs switch correctly
**Step 3:** Verify Start/Stop/Pause buttons work
**Step 4:** Verify settings save correctly
**Step 5:** Verify scan and upgrade list renders
**Step 6:** Verify logs display and filter
