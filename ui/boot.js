/** Vim plugin shell.boot — attach monaco-vim to Verse Monaco editors. */
(function () {
  const PLUGIN_ID = "vim";
  const ICON = "/plugin-ui/vim/assets/icon.svg";
  const VENDOR = "/plugin-ui/vim/ui/vendor/monaco-vim.js";
  const CSS = "/plugin-ui/vim/ui/vim.css";

  function hostApi() {
    const root = window.__duckyPluginHost;
    if (!root) return null;
    if (typeof root.forPlugin === "function") return root.forPlugin(PLUGIN_ID);
    return root;
  }

  function prefs() {
    try {
      return (hostApi() && hostApi().prefs.get()) || {};
    } catch {
      return {};
    }
  }

  function masterEnabled() {
    return prefs().enabled === true;
  }

  function setPref(patch) {
    try {
      const h = hostApi();
      if (h) h.prefs.set(patch);
    } catch {
      /* ignore */
    }
  }

  // Migrate legacy core setting if present once.
  (async function migrateLegacy() {
    try {
      const api = window.pywebview && window.pywebview.api;
      if (!api || !api.get_agent_settings) return;
      if (prefs()._migratedVim) return;
      const s = await api.get_agent_settings();
      if (s && s.verse_vim_enabled === true) {
        setPref({ enabled: true, _migratedVim: true });
      } else {
        setPref({ _migratedVim: true });
      }
    } catch {
      setPref({ _migratedVim: true });
    }
  })();

  function ensureCss() {
    if (document.getElementById("ducky-vim-css")) return;
    const link = document.createElement("link");
    link.id = "ducky-vim-css";
    link.rel = "stylesheet";
    link.href = CSS;
    document.head.appendChild(link);
  }

  let vimLibPromise = null;
  function loadVimLib() {
    if (window.DuckyMonacoVim) return Promise.resolve(window.DuckyMonacoVim);
    if (vimLibPromise) return vimLibPromise;
    vimLibPromise = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = VENDOR;
      s.onload = () => {
        if (window.DuckyMonacoVim) resolve(window.DuckyMonacoVim);
        else reject(new Error("DuckyMonacoVim global missing"));
      };
      s.onerror = () => reject(new Error("failed to load monaco-vim vendor"));
      document.head.appendChild(s);
    });
    return vimLibPromise;
  }

  function editorPath(ed) {
    try {
      const model = ed.getModel && ed.getModel();
      if (!model) return "";
      const uri = model.uri;
      let p = (uri && (uri.path || uri.fsPath || String(uri))) || "";
      p = String(p).replace(/\\/g, "/");
      // Strip leading drive/file noise; keep Content/...verse when present
      const idx = p.toLowerCase().lastIndexOf("/content/");
      if (idx >= 0) p = p.slice(idx + 1);
      if (p.startsWith("/")) p = p.slice(1);
      return p;
    } catch {
      return "";
    }
  }

  function isVersePath(p) {
    return /\.verse$/i.test(p || "");
  }

  /** @type {Map<string, { adapter: any, statusEl: HTMLElement, ed: any }>} */
  const hosts = new Map();
  /** @type {Set<string>} */
  const disabledPaths = new Set();

  function findStatusHost(ed) {
    const dom = ed.getDomNode && ed.getDomNode();
    if (!dom) return null;
    const body = dom.closest(".verse-editor-body") || dom.parentElement;
    if (!body) return null;
    let el = body.querySelector(":scope > .ducky-vim-status");
    if (!el) {
      el = document.createElement("div");
      el.className = "ducky-vim-status";
      body.appendChild(el);
    }
    return el;
  }

  async function attach(ed) {
    const path = editorPath(ed);
    if (!isVersePath(path)) return;
    if (hosts.has(path)) return;
    if (!masterEnabled()) return;
    if (disabledPaths.has(path.toLowerCase())) return;
    if (!globalThis.__duckyMonaco) return;

    const lib = await loadVimLib();
    const initVimMode = lib.initVimMode || (lib.default && lib.default.initVimMode);
    const VimMode = lib.VimMode || (lib.default && lib.default.VimMode);
    if (!initVimMode) return;

    const statusEl = findStatusHost(ed);
    if (!statusEl) return;
    statusEl.replaceChildren();
    statusEl.classList.add("is-active");

    if (VimMode && VimMode.Vim && !globalThis.__duckyVimExRegistered) {
      globalThis.__duckyVimExRegistered = true;
      const vimApi = VimMode.Vim;
      const save = () => {
        try {
          document.dispatchEvent(
            new KeyboardEvent("keydown", { key: "s", ctrlKey: true, bubbles: true }),
          );
        } catch {
          /* ignore */
        }
      };
      vimApi.defineEx("write", "w", save);
      vimApi.defineEx("wq", "wq", save);
    }

    const adapter = initVimMode(ed, statusEl);
    hosts.set(path, { adapter, statusEl, ed });
    reportState(path, ed, true);
  }

  function detach(path) {
    const key = path;
    const h = hosts.get(key);
    if (!h) return;
    try {
      h.adapter.dispose && h.adapter.dispose();
    } catch {
      /* ignore */
    }
    if (h.statusEl) {
      h.statusEl.classList.remove("is-active");
      h.statusEl.replaceChildren();
    }
    hosts.delete(key);
    reportState(key, h.ed, false);
  }

  function detachAll() {
    for (const p of [...hosts.keys()]) detach(p);
  }

  function reportState(path, ed, vimOn) {
    try {
      const api = window.pywebview && window.pywebview.api;
      if (!api || !api.report_editor_state) return;
      const model = ed && ed.getModel && ed.getModel();
      const pos = ed && ed.getPosition && ed.getPosition();
      const sel = ed && ed.getSelection && ed.getSelection();
      void api.report_editor_state(path, {
        path,
        found: true,
        vim_enabled: !!vimOn,
        vim_mode: vimOn ? "normal" : null,
        line: pos ? pos.lineNumber : null,
        column: pos ? pos.column : null,
        selection: sel
          ? {
              startLine: sel.startLineNumber,
              startColumn: sel.startColumn,
              endLine: sel.endLineNumber,
              endColumn: sel.endColumn,
            }
          : null,
        dirty: model ? model.getAlternativeVersionId?.() !== model.getVersionId?.() : null,
      });
    } catch {
      /* ignore */
    }
  }

  function syncAll() {
    ensureCss();
    if (!masterEnabled()) {
      detachAll();
      updateHeaderBtn();
      return;
    }
    const monaco = globalThis.__duckyMonaco;
    if (!monaco || !monaco.editor || !monaco.editor.getEditors) {
      updateHeaderBtn();
      return;
    }
    const editors = monaco.editor.getEditors();
    const live = new Set();
    for (const ed of editors) {
      const p = editorPath(ed);
      if (!isVersePath(p)) continue;
      live.add(p);
      if (disabledPaths.has(p.toLowerCase())) {
        detach(p);
        continue;
      }
      void attach(ed);
    }
    for (const p of [...hosts.keys()]) {
      if (!live.has(p)) detach(p);
    }
    updateHeaderBtn();
  }

  function activeVersePath() {
    const monaco = globalThis.__duckyMonaco;
    if (!monaco || !monaco.editor) return "";
    const eds = monaco.editor.getEditors() || [];
    // Prefer focused
    for (const ed of eds) {
      try {
        if (ed.hasTextFocus && ed.hasTextFocus()) {
          const p = editorPath(ed);
          if (isVersePath(p)) return p;
        }
      } catch {
        /* ignore */
      }
    }
    for (const ed of eds) {
      const p = editorPath(ed);
      if (isVersePath(p)) return p;
    }
    return "";
  }

  let headerBtn = null;
  function updateHeaderBtn() {
    ensureCss();
    const slot =
      document.querySelector(".app-header-actions") ||
      document.querySelector(".app-header .app-header-right") ||
      document.querySelector("header .window-controls");
    if (!slot) return;

    if (!masterEnabled()) {
      if (headerBtn) {
        headerBtn.remove();
        headerBtn = null;
      }
      return;
    }

    if (!headerBtn) {
      headerBtn = document.createElement("button");
      headerBtn.type = "button";
      headerBtn.className = "ducky-vim-header-btn no-drag";
      headerBtn.title = "Toggle Vim for current Verse file";
      headerBtn.innerHTML = `<img src="${ICON}" alt="Vim" /><span>Vim</span>`;
      headerBtn.addEventListener("click", () => {
        const p = activeVersePath();
        if (!p) return;
        const key = p.toLowerCase();
        if (disabledPaths.has(key)) disabledPaths.delete(key);
        else disabledPaths.add(key);
        syncAll();
      });
      const controls = document.querySelector(".window-controls");
      if (controls && controls.parentElement) {
        controls.parentElement.insertBefore(headerBtn, controls);
      } else {
        slot.appendChild(headerBtn);
      }
    }

    const p = activeVersePath();
    const on = p && !disabledPaths.has(p.toLowerCase()) && hosts.has(p);
    headerBtn.classList.toggle("is-on", !!on);
  }

  window.addEventListener("ducky-editor-plugin-action", (ev) => {
    const action = ev && ev.detail;
    if (!action || !action.type) return;
    const path = String(action.path || "").replace(/\\/g, "/");
    if (action.type === "set_vim_enabled") {
      const key = path.toLowerCase();
      if (action.enabled) disabledPaths.delete(key);
      else disabledPaths.add(key);
      syncAll();
      return;
    }
    if (action.type === "run_vim_command") {
      const h = hosts.get(path);
      if (!h || !h.adapter) return;
      const text = String(action.text || "");
      void loadVimLib().then((lib) => {
        const VimMode = lib.VimMode || (lib.default && lib.default.VimMode);
        const vimApi = VimMode && VimMode.Vim;
        if (!vimApi) return;
        try {
          if (text.startsWith(":")) vimApi.handleEx(h.adapter, text.slice(1));
          else {
            for (const ch of text) vimApi.handleKey(h.adapter, ch);
          }
        } catch (e) {
          console.warn("[vim] command failed", e);
        }
      });
    }
  });

  window.addEventListener("uefn-plugin-prefs", (ev) => {
    const d = ev && ev.detail;
    if (d && d.pluginId && d.pluginId !== PLUGIN_ID) return;
    syncAll();
  });

  ensureCss();
  const obs = new MutationObserver(() => syncAll());
  obs.observe(document.documentElement, { childList: true, subtree: true });
  const timer = setInterval(syncAll, 1500);
  syncAll();

  const cleanups = (window.__duckyPluginBootCleanups = window.__duckyPluginBootCleanups || {});
  cleanups[PLUGIN_ID] = () => {
    clearInterval(timer);
    obs.disconnect();
    detachAll();
    if (headerBtn) headerBtn.remove();
    headerBtn = null;
    const css = document.getElementById("ducky-vim-css");
    if (css) css.remove();
  };
})();
