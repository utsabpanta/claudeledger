/**
 * Open a file/URL in the user's default application, cross-platform.
 *
 * This is the one place claudestats shells out. It launches the OS "open" handler
 * (`open` on macOS, `start` on Windows, `xdg-open` on Linux) — it never makes a
 * network request itself.
 */

import { spawn } from "node:child_process";

/** Best-effort open of `target`; resolves to false if the launcher errored. */
export function openInBrowser(target: string): Promise<boolean> {
  return new Promise((resolve) => {
    const { command, args } = launcher(target);
    try {
      const child = spawn(command, args, { stdio: "ignore", detached: true });
      child.on("error", () => resolve(false));
      child.unref();
      // Give the spawn a tick to fail fast on ENOENT; otherwise assume success.
      setTimeout(() => resolve(true), 80);
    } catch {
      resolve(false);
    }
  });
}

function launcher(target: string): { command: string; args: string[] } {
  switch (process.platform) {
    case "darwin":
      return { command: "open", args: [target] };
    case "win32":
      // `start` is a cmd builtin; the empty "" is the window title arg.
      return { command: "cmd", args: ["/c", "start", "", target] };
    default:
      return { command: "xdg-open", args: [target] };
  }
}
