// Stabilization diagnostics, injected with page.addInitScript in the verification worktree only.
// Never committed. Every wrapper calls the original synchronously and returns what it returns, so
// the page behaves the same; each line goes to the console as "[diag] <epoch ms> ...".
(() => {
  const now = () => (performance.timeOrigin + performance.now()).toFixed(1);
  const desc = (el) => {
    if (!el) return String(el);
    if (el === document) return "document";
    if (!el.tagName) return String(el);
    const tid = el.getAttribute("data-testid");
    return el.tagName.toLowerCase() + (tid ? `[${tid}]` : "") + (el.id ? `#${el.id}` : "") + (el.__diagId ? `{${el.__diagId}}` : "");
  };
  const log = (...parts) => console.log("[diag]", now(), ...parts);
  const shortStack = () => (new Error().stack || "").split("\n").slice(3, 7).map((s) => s.trim().replace(/https?:\/\/localhost:\d+/g, "")).join(" | ");

  // Every focus() call: what it targeted, what was focused before and after, and who called it.
  const originalFocus = HTMLElement.prototype.focus;
  HTMLElement.prototype.focus = function focus(...args) {
    const before = desc(document.activeElement);
    const result = originalFocus.apply(this, args);
    log("focus()", desc(this), "connected:", this.isConnected, "active:", before, "->", desc(document.activeElement), "hasFocus:", document.hasFocus(), "at:", shortStack());
    return result;
  };
  document.addEventListener("focusin", (e) => log("focusin", desc(e.target)), true);
  document.addEventListener("focusout", (e) => log("focusout", desc(e.target), "related:", desc(e.relatedTarget)), true);
  window.addEventListener("blur", () => log("window blur; hasFocus:", document.hasFocus()));
  window.addEventListener("focus", () => log("window focus"));
  document.addEventListener("visibilitychange", () => log("visibility", document.visibilityState));

  // Animation-frame callbacks whose code moves focus: when they were asked for, when they ran,
  // and whether the conflict notice existed in the DOM at that moment.
  const originalRaf = window.requestAnimationFrame.bind(window);
  let rafSeq = 0;
  window.requestAnimationFrame = function requestAnimationFrame(callback) {
    const source = String(callback);
    if (!source.includes("focus")) return originalRaf(callback);
    const n = ++rafSeq;
    log(`rAF#${n} requested`, "conflict in DOM:", !!document.querySelector('[data-testid="stale-conflict"]'), "code:", source.slice(0, 90));
    return originalRaf((ts) => {
      log(`rAF#${n} runs`, "conflict in DOM:", !!document.querySelector('[data-testid="stale-conflict"]'), "active:", desc(document.activeElement));
      return callback(ts);
    });
  };

  // Element identity: a new conflict notice, replay panel or replay result gets a number; a
  // removed one is reported, so a remount shows as "removed #1, inserted #2".
  let seq = 0;
  const tracked = new Map();
  const watch = () => {
    for (const id of ["stale-conflict", "replay-panel", "replay-result", "decision-form"]) {
      const el = document.querySelector(`[data-testid="${id}"]`);
      const prev = tracked.get(id);
      if (prev && prev !== el && !prev.isConnected) {
        log("removed", id, `#${prev.__diagId}`);
        tracked.delete(id);
      }
      if (el && !el.__diagId) {
        el.__diagId = `${id}#${++seq}`;
        tracked.set(id, el);
        log("inserted", desc(el), "active:", desc(document.activeElement), id === "replay-result" ? JSON.stringify(el.textContent.slice(0, 80)) : "");
      }
    }
  };
  const observer = new MutationObserver(watch);
  const start = () => {
    observer.observe(document.documentElement, { subtree: true, childList: true });
    watch();
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();

  // After a conflict notice appears: report every change of the focused element for 2 s, also
  // the ones no focus() call or focus event explains (a removed or replaced element).
  let lastActive = null;
  let pollUntil = 0;
  const poll = () => {
    const active = desc(document.activeElement) + " hasFocus=" + document.hasFocus();
    if (active !== lastActive) {
      log("active is", active);
      lastActive = active;
    }
    if (performance.now() < pollUntil) setTimeout(poll, 10);
  };
  new MutationObserver(() => {
    const el = document.querySelector('[data-testid="stale-conflict"]');
    if (el && !el.__diagPolled) {
      el.__diagPolled = true;
      pollUntil = performance.now() + 2000;
      lastActive = null;
      poll();
    }
  }).observe(document, { subtree: true, childList: true });

  // Fetches of the two API calls in question, with their status and timing.
  const originalFetch = window.fetch;
  window.fetch = function fetch(input, init) {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const interesting = /\/api\/(replays|exceptions\/\d+\/review)/.test(url);
    const started = now();
    if (interesting) log("fetch start", (init && init.method) || "GET", url);
    const promise = originalFetch.apply(this, arguments);
    if (interesting) promise.then((r) => log("fetch done", url, r.status, "started", started), (e) => log("fetch failed", url, String(e)));
    return promise;
  };

  // Clicks on buttons: was React attached to the button when it was clicked?
  document.addEventListener(
    "click",
    (e) => {
      const button = e.target && e.target.closest ? e.target.closest("button") : null;
      if (!button) return;
      const hydrated = Object.keys(button).some((k) => k.startsWith("__reactProps$"));
      log("click", desc(button), JSON.stringify(button.textContent.trim().slice(0, 40)), "react attached:", hydrated);
    },
    true,
  );
  window.addEventListener("error", (e) => log("window error", String(e.message)));
  window.addEventListener("unhandledrejection", (e) => log("unhandled rejection", String(e.reason)));
})();
