(function () {
  "use strict";

  // ── Constants ──

  /** API endpoint paths. */
  const API = {
    diff:      "/api/diff",
    repos:     "/api/repos",
    branches:  "/api/branches",
    worktrees: "/api/worktrees",
    clear:     "/api/clear",
    hide:      "/api/hide",
  };

  /** WebSocket reconnect backoff parameters (milliseconds). */
  const WS_RECONNECT = {
    initialDelay: 1000,
    maxDelay:     16000,
  };

  /** Element IDs referenced from JavaScript. */
  const ID = {
    btnBack:              "btn-back",
    headerTitle:          "header-title",
    baseBranchControl:    "base-branch-control",
    baseSelect:           "base-select",
    btnDeleteBranch:      "btn-delete-branch",
    worktreeControl:      "worktree-control",
    wtSelect:             "wt-select",
    btnDeleteWorktree:    "btn-delete-worktree",
    stats:                "stats",
    headerRightWorkspace: "header-right-workspace",
    btnSettings:          "btn-settings",
    settingsMenu:         "settings-menu",
    settingsShowHidden:   "settings-show-hidden",
    lblShowHidden:        "lbl-show-hidden",
    chkShowHidden:        "chk-show-hidden",
    btnModeBranch:        "btn-mode-branch",
    btnModeUncommitted:   "btn-mode-uncommitted",
    liveDot:              "live-dot",
    btnUnified:           "btn-unified",
    btnSplit:             "btn-split",
    sidebar:              "sidebar",
    diffContainer:        "diff-container",
    repoListContainer:    "repo-list-container",
    fileList:             "file-list",
    loading:              "loading",
  };

  // ── State ──

  let currentView     = "side-by-side";
  let diffData        = null;
  let isWorkspace     = false;
  let currentRepo     = null;
  let currentWorktree = null;
  let currentBranch   = null;
  let reposCache      = null;
  let currentBase     = null;
  let currentMode     = "branch"; // "branch" | "uncommitted"

  /** Active WebSocket manager — holds the current live connection. */
  let wsManager = null;

  /** Cached DOM element references — populated by initDom() during init. */
  const dom = {};

  function initDom() {
    Object.entries(ID).forEach(([key, id]) => {
      dom[key] = document.getElementById(id);
    });
  }

  // ── HTTP ──

  async function fetchJSON(url) {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return resp.json();
  }

  // ── URL state ──

  function parseURLState() {
    const pathname = window.location.pathname;
    const params   = new URLSearchParams(window.location.search);
    const worktreeName = params.get("worktree") || null;
    const base         = params.get("base") || null;
    const mode         = params.get("mode") || "branch";

    // /repos/{repoName}/branches/{currentBranch}
    const bm = pathname.match(/^\/repos\/(.+)\/branches\/([^/]+)$/);
    if (bm) return { repoName: bm[1], worktreeName, base, mode, branch: bm[2] };

    // /repos/{repoName}
    const m = pathname.match(/^\/repos\/(.+)$/);
    if (m) return { repoName: m[1], worktreeName, base, mode, branch: null };

    return { repoName: null, worktreeName, base, mode, branch: null };
  }

  function buildPageURL(repoName, worktreeName) {
    if (!repoName) return "/";
    let path = `/repos/${repoName}`;
    if (currentBranch) path += `/branches/${currentBranch}`;

    const params = new URLSearchParams();
    if (worktreeName) params.set("worktree", worktreeName);
    if (currentMode === "branch" && currentBase) params.set("base", currentBase);
    if (currentMode !== "branch") params.set("mode", currentMode);
    const qs = params.toString() ? "?" + params.toString() : "";
    return path + qs;
  }

  function buildDiffUrl(repoName, worktreeName) {
    const params = new URLSearchParams();
    if (repoName)     params.set("repo", repoName);
    if (worktreeName) params.set("worktree", worktreeName);
    params.set("mode", currentMode);
    if (currentMode === "branch" && currentBase) params.set("base", currentBase);
    return API.diff + "?" + params.toString();
  }

  function updateURL(push) {
    const url   = buildPageURL(currentRepo, currentWorktree);
    const state = { repo: currentRepo, worktree: currentWorktree, base: currentBase, mode: currentMode, branch: currentBranch };
    if (push) history.pushState(state, "", url);
    else      history.replaceState(state, "", url);
  }

  // ── Diff fetching & rendering ──

  async function fetchAndRenderDiff() {
    setDiffLoading(currentRepo || "");
    try {
      const url = buildDiffUrl(currentRepo, currentWorktree);
      diffData = await fetchJSON(url);
      renderStats(diffData);
      renderFileList(diffData);
      renderDiff(diffData);
    } catch (err) {
      renderDiffError(err.message);
    }
  }

  // ── WebSocket live refresh ──

  function setLiveIndicator(state) {
    if (!dom.liveDot) return;
    dom.liveDot.className = "live-dot" + (state ? " " + state : "");
  }

  /**
   * connectWS opens a WebSocket to /ws with optional repo/worktree params and
   * returns a manager object with a stop() method.
   */
  function connectWS(repo, worktree) {
    let ws             = null;
    let stopped        = false;
    let reconnectTimer = null;
    let reconnectDelay = WS_RECONNECT.initialDelay;

    function buildURL() {
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      let url = `${proto}//${location.host}/ws`;
      if (repo) {
        url += `?repo=${encodeURIComponent(repo)}`;
        if (worktree) url += `&worktree=${encodeURIComponent(worktree)}`;
      }
      return url;
    }

    function connect() {
      if (stopped) return;
      ws = new WebSocket(buildURL());

      ws.onopen = function () {
        reconnectDelay = WS_RECONNECT.initialDelay;
        setLiveIndicator("connected");
      };

      ws.onmessage = function (event) {
        let msg;
        try {
          msg = JSON.parse(event.data);
        } catch (_) {
          return;
        }
        if (msg.type === "refresh") {
          refreshDiff();
        }
      };

      ws.onclose = function () {
        if (stopped) return;
        setLiveIndicator("reconnecting");
        reconnectTimer = setTimeout(function () {
          reconnectDelay = Math.min(reconnectDelay * 2, WS_RECONNECT.maxDelay);
          connect();
        }, reconnectDelay);
      };

      ws.onerror = function () {
        // onclose will fire next and handle reconnection.
      };
    }

    connect();

    return {
      stop: function () {
        stopped = true;
        clearTimeout(reconnectTimer);
        if (ws) {
          ws.onclose = null; // prevent reconnect loop on deliberate close
          ws.close();
        }
        setLiveIndicator("");
      },
    };
  }

  /** refreshDiff re-fetches the current diff without touching UI chrome. */
  async function refreshDiff() {
    try {
      const url  = buildDiffUrl(currentRepo, currentWorktree);
      const data = await fetchJSON(url);
      diffData = data;
      renderStats(data);
      renderFileList(data);
      renderDiff(data);
    } catch (_) {
      // Silently ignore refresh errors — stale view is better than an error flash.
    }
  }

  function stopWS() {
    if (wsManager) {
      wsManager.stop();
      wsManager = null;
    }
  }

  function startWS(repo, worktree) {
    stopWS();
    wsManager = connectWS(repo, worktree);
  }

  // ── Branch controls ──

  async function loadBranches(repoName) {
    const url = repoName
      ? `${API.branches}?repo=${encodeURIComponent(repoName)}`
      : API.branches;
    return fetchJSON(url);
  }

  function renderBaseSelect(branches, selectedBranch) {
    dom.baseSelect.innerHTML = "";
    (branches || []).forEach((b) => {
      const opt = document.createElement("option");
      opt.value     = b;
      opt.textContent = b;
      opt.selected  = b === selectedBranch;
      dom.baseSelect.appendChild(opt);
    });
    dom.baseSelect.value    = selectedBranch || "";
    dom.baseSelect.onchange = () => {
      currentBase = dom.baseSelect.value;
      updateDeleteBranchVisibility();
      updateURL(false);
      fetchAndRenderDiff();
    };
  }

  // ── Delete handlers ──

  function updateDeleteBranchVisibility() {
    if (!dom.btnDeleteBranch) return;
    const selected    = dom.baseSelect ? dom.baseSelect.value : "";
    const isProtected = selected === "main" || selected === "master";
    dom.btnDeleteBranch.disabled = isProtected;
  }

  function updateDeleteWorktreeVisibility() {
    if (!dom.btnDeleteWorktree) return;
    const options = dom.wtSelect ? dom.wtSelect.options : [];
    dom.btnDeleteWorktree.disabled = options.length <= 1 || dom.wtSelect.selectedIndex === 0;
  }

  async function deleteBranch() {
    const branch = dom.baseSelect ? dom.baseSelect.value : "";
    if (!branch) return;
    if (!confirm(`Delete branch "${branch}"? This cannot be undone.`)) return;

    try {
      const params = new URLSearchParams({ branch });
      if (currentRepo) params.set("repo", currentRepo);
      const resp = await fetch(API.branches + "?" + params.toString(), { method: "DELETE" });
      if (!resp.ok) {
        const data = await resp.json();
        alert("Failed: " + (data.error || resp.statusText));
        return;
      }
      // Refresh branches — reset to default.
      const branchData   = await loadBranches(currentRepo || null);
      const branches     = branchData.branches || [];
      const defaultBranch = branchData.default || "main";
      currentBase = defaultBranch;
      renderBaseSelect(branches, currentBase);
      updateDeleteBranchVisibility();
      updateURL(false);
      await fetchAndRenderDiff();
    } catch (err) {
      alert("Error: " + err.message);
    }
  }

  async function deleteWorktree() {
    const worktree = dom.wtSelect ? dom.wtSelect.value : "";
    if (!worktree || !currentRepo) return;
    if (!confirm(`Remove worktree "${worktree}"? The working directory will be deleted.`)) return;

    try {
      const params = new URLSearchParams({ repo: currentRepo, worktree });
      const resp   = await fetch(API.worktrees + "?" + params.toString(), { method: "DELETE" });
      if (!resp.ok) {
        const data = await resp.json();
        alert("Failed: " + (data.error || resp.statusText));
        return;
      }
      // Refresh worktrees — switch to main worktree.
      const wtData   = await fetchJSON(`${API.worktrees}?repo=${encodeURIComponent(currentRepo)}`);
      const worktrees = wtData.worktrees || [];
      if (worktrees.length > 1) {
        currentWorktree = worktrees[0].name;
        renderWorktreeSelect(worktrees, currentRepo, currentWorktree);
      } else {
        currentWorktree = null;
        hideWorktreeSelect();
      }
      updateDeleteWorktreeVisibility();
      updateURL(true);
      await fetchAndRenderDiff();
      startWS(currentRepo, currentWorktree);
    } catch (err) {
      alert("Error: " + err.message);
    }
  }

  function showBranchControl() {
    dom.baseBranchControl.style.display = "";
  }

  function hideBranchControl() {
    dom.baseBranchControl.style.display = "none";
  }

  /** syncModeToggle updates button active states and shows/hides the base-branch control. */
  function syncModeToggle() {
    const isBranch = currentMode === "branch";
    dom.btnModeBranch.classList.toggle("active", isBranch);
    dom.btnModeUncommitted.classList.toggle("active", !isBranch);
    if (isBranch) {
      showBranchControl();
    } else {
      hideBranchControl();
    }
  }

  // ── Layout switching ──

  function showRepoList() {
    stopWS();
    dom.sidebar.style.display           = "none";
    dom.diffContainer.style.display     = "none";
    dom.repoListContainer.style.display = "flex";
    dom.btnBack.style.display           = "none";
    document.querySelectorAll(".header-right").forEach((el) => (el.style.display = "none"));
    dom.headerRightWorkspace.style.display = "";
    dom.headerTitle.textContent = "prview";
    currentRepo     = null;
    currentWorktree = null;
    hideWorktreeSelect();
    hideBranchControl();
  }

  function showDiffView() {
    dom.sidebar.style.display           = "";
    dom.diffContainer.style.display     = "";
    dom.repoListContainer.style.display = "none";
    if (isWorkspace) {
      dom.btnBack.style.display = "";
    }
    dom.headerRightWorkspace.style.display = "none";
    document.querySelectorAll(".header-right").forEach((el) => {
      if (el.id !== ID.headerRightWorkspace) el.style.display = "";
    });
    if (currentRepo) {
      dom.headerTitle.textContent = currentRepo;
    }
    syncModeToggle();
  }

  // ── Worktree dropdown ──

  function renderWorktreeSelect(worktrees, repoName, activeWorktreeName) {
    dom.wtSelect.innerHTML = "";
    worktrees.forEach((wt) => {
      const opt = document.createElement("option");
      opt.value       = wt.name;
      opt.textContent = wt.branch || wt.name;
      opt.selected    = wt.name === activeWorktreeName;
      dom.wtSelect.appendChild(opt);
    });
    dom.wtSelect.onchange = () => {
      selectWorktree(repoName, dom.wtSelect.value);
      updateDeleteWorktreeVisibility();
    };
    dom.worktreeControl.style.display = "";
    updateDeleteWorktreeVisibility();
  }

  function hideWorktreeSelect() {
    dom.worktreeControl.style.display = "none";
    dom.wtSelect.innerHTML = "";
  }

  // ── Workspace / repo list ──

  async function loadWorkspace() {
    const data = await fetchJSON(API.repos);
    if (data.workspace && Array.isArray(data.repos) && data.repos.length > 0) {
      isWorkspace = true;
      reposCache  = data.repos;
      lastRepoData = data;
      return data.repos;
    }
    return null;
  }

  let lastRepoData = null;

  function renderRepoListPage(repos, pushHistory, data) {
    if (data) lastRepoData = data;
    if (pushHistory !== false) history.pushState({}, "", "/");
    showRepoList();

    const dirtyCount = repos.filter((r) => r.dirty).length;
    dom.stats.innerHTML = `${repos.length} repositories`;
    if (dirtyCount > 0) {
      dom.stats.innerHTML += ` &nbsp;<span class="add">${dirtyCount} with changes</span>`;
    }

    const sorted = [...repos].sort((a, b) => {
      if (a.dirty && !b.dirty) return -1;
      if (!a.dirty && b.dirty) return 1;
      return (b.lastCommit || 0) - (a.lastCommit || 0);
    });

    const table = document.createElement("table");
    table.className = "repo-table";

    const thead = document.createElement("thead");
    thead.innerHTML = `<tr>
      <th></th>
      <th>Repository</th>
      <th>Branch</th>
      <th>Status</th>
      <th></th>
    </tr>`;
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    sorted.forEach((repo) => {
      const tr = document.createElement("tr");
      tr.className = repo.dirty ? "repo-dirty" : "";

      const indicator = repo.dirty
        ? '<span class="dot-dirty">●</span>'
        : '<span class="dot-clean">○</span>';

      tr.innerHTML =
        `<td class="repo-indicator">${indicator}</td>` +
        `<td class="repo-name">${repo.name}</td>` +
        `<td class="repo-branch">${repo.branch || ""}</td>` +
        `<td class="repo-status">${repo.dirty ? "Changes" : "Clean"}</td>` +
        `<td class="repo-actions"><button class="repo-menu-btn" title="Actions">⋯</button>` +
        `<div class="repo-menu">` +
        `<button class="repo-menu-item" data-action="clear" data-repo="${repo.name}">Clear changes</button>` +
        `<div class="repo-menu-divider"></div>` +
        `<button class="repo-menu-item danger" data-action="hide" data-repo="${repo.name}">Hide this repo</button>` +
        `</div></td>`;

      // Row click → open repo (but not on the actions column).
      tr.addEventListener("click", (e) => {
        if (e.target.closest(".repo-actions")) return;
        selectRepo(repo.name);
      });

      // Menu toggle.
      const menuBtn = tr.querySelector(".repo-menu-btn");
      const menu    = tr.querySelector(".repo-menu");
      menuBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        closeAllMenus();
        menu.classList.toggle("open");
      });

      // Menu item clicks — use event delegation on the menu container.
      menu.addEventListener("click", async (e) => {
        e.stopPropagation();
        const item = e.target.closest(".repo-menu-item");
        if (!item) return;
        const action   = item.dataset.action;
        const repoName = item.dataset.repo;
        menu.classList.remove("open");

        if (action === "clear") {
          if (!confirm(`Clear all changes in "${repoName}"? This will discard uncommitted modifications.`)) return;
          fadeOutRow(tr);
          try {
            await repoActionAndReload(`${API.clear}?repo=${encodeURIComponent(repoName)}`, "POST");
          } catch (err) { alert("Error: " + err.message); }
        } else if (action === "hide") {
          if (!confirm(`Hide "${repoName}" from the workspace list?`)) return;
          fadeOutRow(tr);
          try {
            await repoActionAndReload(`${API.hide}?repo=${encodeURIComponent(repoName)}`, "POST");
          } catch (err) { alert("Error: " + err.message); }
        }
      });

      tbody.appendChild(tr);
    });
    table.appendChild(tbody);

    dom.repoListContainer.innerHTML = "";
    dom.repoListContainer.appendChild(table);

    // Update settings menu: show or hide the "show hidden" item.
    const hiddenCount = (data || lastRepoData || {}).hidden || 0;
    if (hiddenCount > 0) {
      dom.settingsShowHidden.style.display = "";
      dom.lblShowHidden.textContent = `Show hidden (${hiddenCount})`;
    } else {
      dom.settingsShowHidden.style.display = "none";
    }
  }

  /**
   * repoActionAndReload sends a request to url, then re-fetches and re-renders
   * the repo list. Returns false if the server returned an error.
   */
  /**
   * fadeOutRow applies a CSS fade+collapse animation to a table row.
   * The row is removed from the DOM after the transition completes.
   */
  function fadeOutRow(row) {
    row.style.transition = "opacity 0.3s ease, transform 0.3s ease";
    row.style.opacity    = "0";
    row.style.transform  = "translateX(-20px)";
    row.addEventListener("transitionend", () => row.remove(), { once: true });
  }

  async function repoActionAndReload(url, method) {
    const resp = await fetch(url, { method });
    if (!resp.ok) {
      const data = await resp.json();
      alert("Failed: " + (data.error || resp.statusText));
      return false;
    }
    reposCache = null;
    const freshData = await fetchJSON(API.repos);
    if (freshData.repos) {
      reposCache   = freshData.repos;
      lastRepoData = freshData;
      renderRepoListPage(freshData.repos, false, freshData);
    }
    return true;
  }

  // ── Repo diff ──

  /** selectRepo loads a repo diff view. initialBase/initialMode come from URL or popstate. */
  async function selectRepo(repoName, initialWorktree, initialBase, initialMode) {
    currentRepo     = repoName;
    currentWorktree = null;
    if (initialMode) currentMode = initialMode;

    showDiffView();
    setDiffLoading(repoName);

    // Load branches and worktrees in parallel.
    const [branchResult, worktreeResult] = await Promise.allSettled([
      loadBranches(repoName),
      fetchJSON(`${API.worktrees}?repo=${encodeURIComponent(repoName)}`),
    ]);

    // Resolve base branch.
    let branches      = [];
    let defaultBranch = "main";
    if (branchResult.status === "fulfilled") {
      branches      = branchResult.value.branches || [];
      defaultBranch = branchResult.value.default  || "main";
    }
    // Resolve current branch from API or repo list cache.
    currentBranch = branchResult.status === "fulfilled" && branchResult.value.current
      ? branchResult.value.current
      : (reposCache && reposCache.find(r => r.name === repoName)?.branch) || defaultBranch;

    currentBase = (initialBase && branches.includes(initialBase)) ? initialBase : defaultBranch;
    renderBaseSelect(branches, currentBase);
    updateDeleteBranchVisibility();
    syncModeToggle();

    // Resolve worktree.
    let worktrees = [];
    if (worktreeResult.status === "fulfilled") {
      worktrees = worktreeResult.value.worktrees || [];
    }
    if (worktrees.length > 1) {
      const activeWt  = initialWorktree || worktrees[0].name;
      currentWorktree = activeWt;
      renderWorktreeSelect(worktrees, repoName, activeWt);
    } else {
      hideWorktreeSelect();
    }

    // Push history with fully resolved state.
    history.pushState(
      { repo: repoName, worktree: currentWorktree, base: currentBase, mode: currentMode },
      "",
      buildPageURL(repoName, currentWorktree)
    );

    await fetchAndRenderDiff();
    startWS(repoName, currentWorktree);
  }

  async function selectWorktree(repoName, worktreeName) {
    currentWorktree         = worktreeName;
    dom.wtSelect.value      = worktreeName;

    history.pushState(
      { repo: repoName, worktree: worktreeName, base: currentBase, mode: currentMode },
      "",
      buildPageURL(repoName, worktreeName)
    );

    setDiffLoading(repoName);
    await fetchAndRenderDiff();
    startWS(repoName, worktreeName);
  }

  function setDiffLoading(repoName) {
    const label = repoName ? `Loading ${repoName}…` : "Loading…";
    dom.stats.innerHTML        = label;
    dom.fileList.innerHTML     = "";
    dom.diffContainer.innerHTML = '<div class="diff-loading">Loading diff…</div>';
  }

  function renderDiffError(message) {
    dom.diffContainer.innerHTML = `<div class="diff-error">Error: ${message}</div>`;
  }

  // ── Stats / file list / diff rendering ──

  function renderStats(data) {
    const nFiles = data.files ? data.files.length : 0;
    dom.stats.innerHTML =
      `${nFiles} file${nFiles !== 1 ? "s" : ""} changed &nbsp;` +
      `<span class="add">+${data.additions || 0}</span> &nbsp;` +
      `<span class="del">-${data.deletions || 0}</span>`;
  }

  function renderFileList(data) {
    dom.fileList.innerHTML = "";
    if (!data.files) return;

    data.files.forEach((file, idx) => {
      const li   = document.createElement("li");
      li.onclick = () => scrollToFile(idx);

      const name =
        file.status === "renamed"
          ? `${file.oldName} → ${file.newName}`
          : file.status === "deleted"
            ? file.oldName
            : file.newName;

      const badgeText = file.status.charAt(0).toUpperCase();
      li.innerHTML =
        `<span class="status-badge status-${file.status}">${badgeText}</span>` +
        `<span class="filename" title="${name}">${name}</span>` +
        `<span class="file-stats">` +
        (file.additions ? `<span class="add">+${file.additions}</span> ` : "") +
        (file.deletions ? `<span class="del">-${file.deletions}</span>` : "") +
        `</span>`;

      dom.fileList.appendChild(li);
    });
  }

  function renderDiff(data) {
    if (!data.rawDiff || data.rawDiff.trim() === "") {
      dom.diffContainer.innerHTML = '<div class="diff-empty">No changes detected.</div>';
      return;
    }

    const html = Diff2Html.html(data.rawDiff, {
      drawFileList: false,
      matching:     "lines",
      outputFormat: currentView,
      colorScheme:  "dark",
    });
    dom.diffContainer.innerHTML = html;

    dom.diffContainer.querySelectorAll(".d2h-file-header").forEach((header, idx) => {
      header.id = `file-header-${idx}`;
      const btn     = document.createElement("button");
      btn.className = "file-collapse-btn";
      btn.innerHTML = "▼";
      btn.onclick   = (e) => {
        e.stopPropagation();
        toggleFile(btn);
      };
      header.prepend(btn);
    });
  }

  function toggleFile(btn) {
    const wrapper = btn.closest(".d2h-file-wrapper");
    const diff    = wrapper && wrapper.querySelector(".d2h-file-diff");
    if (!diff) return;
    const collapsed = diff.style.display === "none";
    diff.style.display = collapsed ? "" : "none";
    btn.classList.toggle("collapsed", !collapsed);
  }

  function scrollToFile(idx) {
    const header = document.getElementById(`file-header-${idx}`);
    if (header) header.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  // ── View toggle ──

  function setupViewToggle() {
    dom.btnUnified.onclick = () => {
      currentView = "line-by-line";
      dom.btnUnified.classList.add("active");
      dom.btnSplit.classList.remove("active");
      if (diffData) renderDiff(diffData);
    };
    dom.btnSplit.onclick = () => {
      currentView = "side-by-side";
      dom.btnSplit.classList.add("active");
      dom.btnUnified.classList.remove("active");
      if (diffData) renderDiff(diffData);
    };
  }

  // ── Mode toggle ──

  function setupModeToggle() {
    dom.btnModeBranch.onclick = () => {
      if (currentMode === "branch") return;
      currentMode = "branch";
      syncModeToggle();
      updateURL(false);
      fetchAndRenderDiff();
    };
    dom.btnModeUncommitted.onclick = () => {
      if (currentMode === "uncommitted") return;
      currentMode = "uncommitted";
      syncModeToggle();
      updateURL(false);
      fetchAndRenderDiff();
    };
  }

  // ── Close all open menus ──

  function closeAllMenus() {
    document.querySelectorAll(".repo-menu.open, .settings-menu.open").forEach((m) => m.classList.remove("open"));
  }
  document.addEventListener("click", closeAllMenus);

  // ── Init ──

  async function init() {
    initDom();

    setupViewToggle();
    setupModeToggle();
    dom.btnDeleteBranch.onclick  = deleteBranch;
    dom.btnDeleteWorktree.onclick = deleteWorktree;

    // Settings dropdown toggle.
    dom.btnSettings.onclick = (e) => {
      e.stopPropagation();
      closeAllMenus();
      dom.settingsMenu.classList.toggle("open");
    };

    // Show hidden checkbox.
    let showingAll = false;
    dom.chkShowHidden.onchange = async (e) => {
      showingAll = e.target.checked;
      dom.settingsMenu.classList.remove("open");
      try {
        const url  = showingAll ? `${API.repos}?all=true` : API.repos;
        const resp = await fetchJSON(url);
        if (resp.repos) {
          reposCache   = resp.repos;
          lastRepoData = resp;
          renderRepoListPage(resp.repos, false, resp);
        }
      } catch (_) {}
    };

    // Read URL state at page load.
    const urlState = parseURLState();
    currentMode = urlState.mode || "branch";
    if (urlState.base) currentBase = urlState.base;

    dom.btnBack.onclick = () => {
      if (reposCache) renderRepoListPage(reposCache);
    };

    window.addEventListener("popstate", (e) => {
      if (e.state && e.state.repo) {
        currentBase = e.state.base || null;
        currentMode = e.state.mode || "branch";
        selectRepo(e.state.repo, e.state.worktree || null, e.state.base, e.state.mode);
      } else if (reposCache) {
        renderRepoListPage(reposCache, false);
      } else {
        // Single-repo mode: restore mode/base from URL then re-fetch.
        const state = parseURLState();
        currentBase = state.base;
        currentMode = state.mode || "branch";
        syncModeToggle();
        fetchAndRenderDiff();
      }
    });

    let repos = null;
    try {
      repos = await loadWorkspace();
    } catch (_) {
      // API unavailable or not workspace — fall through to single repo mode.
    }

    dom.loading.style.display = "none";

    if (repos) {
      // Workspace mode: honour direct URL like /repos/name or /repos/name/worktrees/wt.
      const { repoName, worktreeName } = urlState;
      if (repoName && repos.some((r) => r.name === repoName)) {
        await selectRepo(repoName, worktreeName, urlState.base, urlState.mode);
      } else {
        renderRepoListPage(repos, false);
      }
      return;
    }

    // Single repo mode.
    showDiffView();

    // Load branches for the base dropdown.
    try {
      const branchData    = await loadBranches(null);
      const branches      = branchData.branches || [];
      const defaultBranch = branchData.default   || "main";
      if (!currentBase || !branches.includes(currentBase)) {
        currentBase = defaultBranch;
      }
      renderBaseSelect(branches, currentBase);
    } catch (_) {}

    syncModeToggle();
    updateURL(false);

    await fetchAndRenderDiff();
    startWS(null, null);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
