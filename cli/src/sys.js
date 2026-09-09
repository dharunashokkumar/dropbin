// The two places this tool touches the desktop: the clipboard and the browser.
// Both are best-effort — nothing here is allowed to fail an upload.

import { spawn, spawnSync } from "node:child_process";

function tools(kind) {
  const p = process.platform;
  if (kind === "copy") {
    if (p === "win32") return [["clip", []]];
    if (p === "darwin") return [["pbcopy", []]];
    return [["wl-copy", []], ["xclip", ["-selection", "clipboard"]], ["xsel", ["--clipboard", "--input"]]];
  }
  if (p === "win32") return [["cmd", ["/c", "start", ""]]];
  if (p === "darwin") return [["open", []]];
  return [["xdg-open", []]];
}

/** True if the text made it to the clipboard. */
export function copy(text) {
  for (const [cmd, args] of tools("copy")) {
    const r = spawnSync(cmd, args, { input: text, stdio: ["pipe", "ignore", "ignore"] });
    if (!r.error && r.status === 0) return true;
  }
  return false;
}

/** Hand a link to whatever the desktop uses for links. */
export function browse(url) {
  const [cmd, args] = tools("open")[0];
  try {
    const child = spawn(cmd, [...args, url], { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}
