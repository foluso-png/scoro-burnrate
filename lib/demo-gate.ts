import "server-only";
import { loadUserPrefs } from "./user-prefs";

export class DemoModeBlockedError extends Error {
  constructor() {
    super("Blocked by demo mode");
    this.name = "DemoModeBlockedError";
  }
}

/**
 * Call before any Scoro write. Loads the user's prefs and throws
 * DemoModeBlockedError if demoMode is on. Every write path must
 * call this; a missing call is a missing gate.
 */
export async function assertCanWrite(slackUserId: string): Promise<void> {
  const prefs = await loadUserPrefs(slackUserId);
  if (prefs.demoMode) throw new DemoModeBlockedError();
}
