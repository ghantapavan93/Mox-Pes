"use client";

import { useEffect } from "react";

/**
 * Back returns focus to the control that left the page (release design §5.7). Before a link
 * navigates away, `rememberFocus` stores its element id under the current URL in sessionStorage;
 * when that URL is shown again, `restoreRememberedFocus` focuses the element and forgets it, so a
 * later visit starts fresh. The key is the path and query without the hash, which in-page anchors
 * change. Storage can be unavailable (a private window, blocked site data): then nothing is
 * remembered and the page behaves as before.
 */

const PREFIX = "rs:focus:";
const keyFor = () => `${PREFIX}${window.location.pathname}${window.location.search}`;

export function rememberFocus(id: string): void {
  try {
    window.sessionStorage.setItem(keyFor(), id);
  } catch {
    // No storage: Back still works, focus starts at the top.
  }
}

/** How long the page may take to settle after Back (streaming, a kept page shown again, a remount). */
const SETTLE_MS = 2000;

/**
 * Focuses the remembered element for this URL, if any, then forgets it. True when an element was
 * remembered.
 *
 * The page settles over several frames after Back: content streams in, a page kept for Back runs
 * its effects just before it is shown (focus() on a hidden element does nothing), and the page can
 * be rendered again from the server, which replaces the element that was focused. So for about two
 * seconds every frame puts focus back on the visible element with that id, until the reader presses
 * a key or the pointer; then the entry is forgotten. Every mounted copy of the page may run this;
 * they all focus the same element.
 */
export function restoreRememberedFocus(): boolean {
  const key = keyFor();
  let id: string | null = null;
  try {
    id = window.sessionStorage.getItem(key);
  } catch {
    return false;
  }
  if (!id) return false;
  const started = performance.now();
  let readerActed = false;
  const acted = () => {
    readerActed = true;
  };
  window.addEventListener("keydown", acted, { capture: true, once: true });
  window.addEventListener("pointerdown", acted, { capture: true, once: true });
  const finish = () => {
    window.removeEventListener("keydown", acted, { capture: true });
    window.removeEventListener("pointerdown", acted, { capture: true });
    try {
      window.sessionStorage.removeItem(key);
    } catch {
      // nothing to forget
    }
  };
  const tick = () => {
    if (readerActed || performance.now() - started > SETTLE_MS) {
      finish();
      return;
    }
    const el = document.getElementById(id!);
    if (el && el !== document.activeElement && el.getClientRects().length > 0) el.focus({ preventScroll: false });
    window.requestAnimationFrame(tick);
  };
  tick();
  return true;
}

/** On mount (and when a page kept for Back is shown again): restore the remembered focus. */
export function useRestoreFocus(): void {
  useEffect(() => {
    restoreRememberedFocus();
  }, []);
}
