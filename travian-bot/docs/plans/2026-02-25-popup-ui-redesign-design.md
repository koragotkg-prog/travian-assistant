# Popup UI Redesign - Gaming Dashboard v2

**Date:** 2026-02-25
**Status:** Approved

## Goals
- Full redesign of popup (420x580px Chrome popup)
- Gaming Dashboard style: dark theme, neon glow, gradients
- Tab Navigation to split 13+ sections into 4 clean tabs
- Fix: information overload, poor visuals, complex settings

## Color Palette
| Token | Value | Usage |
|-------|-------|-------|
| bg-base | #0a0a1a | Page background |
| bg-surface | #12122a | Card/section background |
| bg-surface-hover | #1a1a3a | Hover state |
| border | #2a2a5a | Card borders (subtle glow) |
| primary | #00e5ff | Main accent (electric cyan) |
| primary-glow | rgba(0,229,255,0.15) | Glow/shadow effects |
| success | #00ff88 | Running/positive states |
| danger | #ff3366 | Errors/emergency |
| warning | #ffaa00 | Warnings |
| text-primary | #e8e8f0 | Main text |
| text-secondary | #7a7a9a | Secondary text |

## Layout
```
┌──────────────────────────────────┐
│  Header (fixed): logo + status   │
│  Village selector dropdown       │
├──────────────────────────────────┤
│  Tab Bar (fixed): 4 tabs         │
├──────────────────────────────────┤
│  Tab Content (scrollable)        │
├──────────────────────────────────┤
│  Control Bar (fixed): Start/     │
│  Pause/Stop + Emergency          │
└──────────────────────────────────┘
```

## Tabs

### Tab 1: Dashboard
- 2x2 Stats cards (completed, failed, uptime, rate)
- Current task with progress bar
- Feature toggle pills (2-column compact grid)
- Task queue list (compact)

### Tab 2: Config
- Upgrade targets (scan + checklist with target levels)
- Troop training (type, batch, min resources)
- Farming (interval, rally point toggle, min troops)
- Timing & Safety (delays, max actions, hero HP)
- Save button

### Tab 3: AI Strategy
- Phase badge with confidence
- 3 metric cards (bottleneck, risk, expand)
- Ranked recommendations list
- Refresh button

### Tab 4: Logs
- Filter chips (All/Info/Warn/Error)
- Full-height scrollable log viewer
- Color-coded entries
- Clear button

## Visual Effects
- Glow borders: box-shadow with primary-glow
- Header gradient: cyan to purple
- Status pulse animation (green dot)
- Tab switch fade (200ms)
- Hover glow on interactive elements
- Progress bar gradient (cyan to green)
- Neon toggle pills
- Card subtle gradient backgrounds

## Files Modified
- `popup/index.html` - Complete rewrite
- `popup/styles.css` - Complete rewrite
- `popup/popup.js` - Refactor for tab navigation, keep all messaging logic
