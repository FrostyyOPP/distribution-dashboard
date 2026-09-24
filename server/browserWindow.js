// Minimize the automation browser window so these headed Playwright tasks don't
// steal focus or cover the screen while they run. Uses Chrome DevTools Protocol
// (Browser.setWindowBounds) which targets ONLY this automation window — never the
// user's own Chrome. Safe for tasks that FETCH (Cloudflare still clears; our
// fetches are CDP-driven, not throttled by background-tab timers).
//
// NOT SAFE FOR TASKS THAT NEED THE PAGE TO RENDER — use parkWindow() for those.
// A minimized window has nothing on screen, and Looker only queries the tiles it
// believes are visible: from 2026-09-12 the Coursera metrics scrape captured
// nothing but the dashboard's "last refreshed" tile and failed thirteen nights
// running, while telling everyone to reconnect a session that was fine.
// Best-effort: any failure is swallowed so it can never break a task.
export async function minimizeWindow(ctx, page) {
  try {
    const cdp = await ctx.newCDPSession(page);
    const { windowId } = await cdp.send('Browser.getWindowForTarget');
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
    return true;
  } catch {
    return false; // headless, unsupported, or already closed — ignore
  }
}

// Keep the window OUT OF SIGHT BUT ON SCREEN as far as Chrome is concerned: a
// normal window, moved well off the left edge. The page renders, lazy tiles
// fire their queries, and nothing covers the user's screen. Use this, not
// minimizeWindow(), for anything that reads a rendered dashboard.
// Best-effort, like minimizeWindow — a failure leaves the window where it was.
export async function parkWindow(ctx, page) {
  try {
    const cdp = await ctx.newCDPSession(page);
    const { windowId } = await cdp.send('Browser.getWindowForTarget');
    // Two calls: Chrome refuses to change position and state in one.
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { left: -3000, top: 40, width: 1280, height: 900 } });
    return true;
  } catch {
    return false;
  }
}
