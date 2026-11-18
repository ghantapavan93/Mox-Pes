import { execFile, spawn } from "node:child_process";

/**
 * The Windows clipboard, which carries a hosted database URL from Neon's copy button to the hosted
 * loader and from the loader to the Vercel CLI, so the URL is never displayed, typed, put on a
 * command line or written to a file (docs/deploy.md).
 */

/** The clipboard's text (Windows only). */
export function readClipboard(): Promise<string> {
  if (process.platform !== "win32") return Promise.reject(new Error("The clipboard is read on Windows only."));
  return new Promise((resolve, reject) => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Get-Clipboard -Raw"], { windowsHide: true }, (error, stdout) =>
      error ? reject(error) : resolve(stdout.trim()),
    );
  });
}

/** Puts a value on the clipboard (Windows only) without printing it. */
export function writeClipboard(value: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("clip.exe", [], { stdio: ["pipe", "ignore", "inherit"], windowsHide: true });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`clip.exe exited with code ${code}`))));
    child.stdin.end(value);
  });
}
