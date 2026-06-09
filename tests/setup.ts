// Jest setup file for Obsidian plugin testing

// Source code uses window.* timers and window.console (per obsidianmd's
// prefer-window-timers / no-global-this rules — Obsidian always provides
// window at runtime). The node test env has no window, so alias it to
// globalThis, which supplies setTimeout/setInterval/clearInterval/console.
if (typeof (globalThis as { window?: unknown }).window === 'undefined') {
  (globalThis as { window?: unknown }).window = globalThis;
}

// Mock performance API if not available
if (!global.performance) {
  global.performance = {
    now: () => Date.now(),
  } as any;
}