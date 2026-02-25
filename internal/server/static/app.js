(function () {
  "use strict";

  let currentView = "side-by-side";
  let diffData = null;
  let isWorkspace = false;
  let currentRepo = null;
  let currentWorktree = null;
  let reposCache = null;
  let currentBase = null;
  let currentMode = "branch"; // "branch" | "uncommitted"

  // Active WebSocket manager — holds the current live connection.
  let wsManager = null;

  // ── HTTP ──

  async function fetchJSON(url) {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return resp.json();
  }

  // ── URL state ──

  function parseURLState() {
    const pathname = window.location.pathname;
    const params = new URLSearchParams(window.location.search);
    const base = params.get("base") || null;
    const mode = params.get("mode") || "branch";

    const m = pathname.match(/^\/repos\/(.+)$/);
    if (!m) return { repoName: null, worktreeName: null, base, mode };

    const rest = m[1];
    const wtm = rest.match(/^(.+)\/worktrees\/([^/]+)$/);
    if (wtm) return { repoName: wtm[1], worktreeName: wtm[2], base, mode };
    return { repoName: rest, worktreeName: null, base, mode };
  }

  function buildPageURL(repoName, worktreeName) {
    const params = new URLSearchParams();
    if (currentMode !== "branch") params.set("mode", currentMode);
    if (currentMode === "branch" && currentBase) params.set("base", currentBase);
    const qs = params.toString() ? "?" + params.toString() : "";

    if (!repoName) return "/" + qs;
    let path = `/repos/${repoName}`;
    if (worktreeName) path += `/worktrees/${worktreeName}`;
    return path + qs;
  }

  function buildDiffUrl(repoName, worktreeName) {
    const params = new URLSearchParams();
    if (repoName) params.set("repo", repoName);
    if (worktreeName) params.set("worktree", worktreeName);
    params.set("mode", currentMode);
    if (currentMode === "branch" && currentBase) params.set("base", currentBase);
    return "/api/diff?" + params.toString();
  }

  function updateURL(push) {
    const url = buildPageURL(currentRepo, currentWorktree);
    const state = {
      repo: currentRepo,
      worktree: currentWorktree,
      base: currentBase,
      mode: currentMode,
    };
    if (push) history.pushState(state, "", url);
    else history.replaceState(state, "", url);
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
    const dot = document.getElementById("live-dot");
    if (!dot) return;
    dot.className = "live-dot" + (state ? " " + state : "");
  }

  // connectWS opens a WebSocket to /ws with optional repo/worktree params and
  // returns a manager object with a stop() method.
  function connectWS(repo, worktree) {
    let ws = null;
    let stopped = false;
    let reconnectTimer = null;
    let reconnectDelay = 1000;

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
        reconnectDelay = 1000;
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
          reconnectDelay = Math.min(reconnectDelay * 2, 16000);
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

  // refreshDiff re-fetches the current diff without touching UI chrome.
  async function refreshDiff() {
    try {
      const url = buildDiffUrl(currentRepo, currentWorktree);
      const data = await fetchJSON(url);
      diffData = data;
      renderStats(data);
      renderFileList(data);
      renderDiff(data);
    } catch (_) {
      // Silently ignore refresh errors — stale view is better than error flash.
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
      ? `/api/branches?repo=${encodeURIComponent(repoName)}`
      : "/api/branches";
    return fetchJSON(url);
  }

  function renderBaseSelect(branches, selectedBranch) {
    const sel = document.getElementById("base-select");
    sel.innerHTML = "";
    (branches || []).forEach((b) => {
      const opt = document.createElement("option");
      opt.value = b;
      opt.textContent = b;
      opt.selected = b === selectedBranch;
      sel.appendChild(opt);
    });
    sel.value = selectedBranch || "";
    sel.onchange = () => {
      currentBase = sel.value;
      updateDeleteBranchVisibility();
      updateURL(false);
      fetchAndRenderDiff();
    };
  }

  // ── Delete handlers ──

  function updateDeleteBranchVisibility() {
    const btn = document.getElementById("btn-delete-branch");
    if (!btn) return;
    // Hide if selected base is the current branch (can't delete checked-out branch)
    // or if it's main/master
    const sel = document.getElementById("base-select");
    const selected = sel ? sel.value : "";
    const isProtected = selected === "main" || selected === "master";
    btn.disabled = isProtected;
  }

  function updateDeleteWorktreeVisibility() {
    const btn = document.getElementById("btn-delete-worktree");
    if (!btn) return;
    const sel = document.getElementById("wt-select");
    const options = sel ? sel.options : [];
    btn.disabled = options.length <= 1 || sel.selectedIndex === 0;
  }

  async function deleteBranch() {
    const sel = document.getElementById("base-select");
    const branch = sel ? sel.value : "";
    if (!branch) return;
    if (!confirm(`Delete branch "${branch}"? This cannot be undone.`)) return;

    try {
      const params = new URLSearchParams({ branch });
      if (currentRepo) params.set("repo", currentRepo);
      const resp = await fetch("/api/branches?" + params.toString(), { method: "DELETE" });
      if (!resp.ok) {
        const data = await resp.json();
        alert("Failed: " + (data.error || resp.statusText));
        return;
      }
      // Refresh branches — reset to default if deleted was selected.
      const branchData = await loadBranches(currentRepo || null);
      const branches = branchData.branches || [];
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
    const sel = document.getElementById("wt-select");
    const wt = sel ? sel.value : "";
    if (!wt || !currentRepo) return;
    if (!confirm(`Remove worktree "${wt}"? The working directory will be deleted.`)) return;

    try {
      const params = new URLSearchParams({ repo: currentRepo, worktree: wt });
      const resp = await fetch("/api/worktrees?" + params.toString(), { method: "DELETE" });
      if (!resp.ok) {
        const data = await resp.json();
        alert("Failed: " + (data.error || resp.statusText));
        return;
      }
      // Refresh worktrees — switch to main worktree.
      const wtData = await fetchJSON(`/api/worktrees?repo=${encodeURIComponent(currentRepo)}`);
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
    document.getElementById("base-branch-control").style.display = "";
  }

  function hideBranchControl() {
    document.getElementById("base-branch-control").style.display = "none";
  }

  // syncModeToggle updates button active states and shows/hides base-branch-control.
  function syncModeToggle() {
    const isBranch = currentMode === "branch";
    document.getElementById("btn-mode-branch").classList.toggle("active", isBranch);
    document.getElementById("btn-mode-uncommitted").classList.toggle("active", !isBranch);
    if (isBranch) {
      showBranchControl();
    } else {
      hideBranchControl();
    }
  }

  // ── Layout switching ──

  function showRepoList() {
    stopWS();
    document.getElementById("sidebar").style.display = "none";
    document.getElementById("diff-container").style.display = "none";
    document.getElementById("repo-list-container").style.display = "flex";
    document.getElementById("btn-back").style.display = "none";
    document.querySelectorAll(".header-right").forEach((el) => (el.style.display = "none"));
    document.getElementById("header-right-workspace").style.display = "";
    document.getElementById("header-title").textContent = "prview";
    currentRepo = null;
    currentWorktree = null;
    hideWorktreeSelect();
    hideBranchControl();
  }

  function showDiffView() {
    document.getElementById("sidebar").style.display = "";
    document.getElementById("diff-container").style.display = "";
    document.getElementById("repo-list-container").style.display = "none";
    if (isWorkspace) {
      document.getElementById("btn-back").style.display = "";
    }
    document.getElementById("header-right-workspace").style.display = "none";
    document.querySelectorAll(".header-right").forEach((el) => {
      if (el.id !== "header-right-workspace") el.style.display = "";
    });
    if (currentRepo) {
      document.getElementById("header-title").textContent = currentRepo;
    }
    syncModeToggle();
  }

  // ── Worktree dropdown ──

  function renderWorktreeSelect(worktrees, repoName, activeWorktreeName) {
    const sel = document.getElementById("wt-select");
    sel.innerHTML = "";
    worktrees.forEach((wt) => {
      const opt = document.createElement("option");
      opt.value = wt.name;
      opt.textContent = wt.branch || wt.name;
      opt.selected = wt.name === activeWorktreeName;
      sel.appendChild(opt);
    });
    sel.onchange = () => {
      selectWorktree(repoName, sel.value);
      updateDeleteWorktreeVisibility();
    };
    document.getElementById("worktree-control").style.display = "";
    updateDeleteWorktreeVisibility();
  }

  function hideWorktreeSelect() {
    document.getElementById("worktree-control").style.display = "none";
    document.getElementById("wt-select").innerHTML = "";
  }

  // ── Workspace / repo list ──

  async function loadWorkspace() {
    const data = await fetchJSON("/api/repos");
    if (data.workspace && Array.isArray(data.repos) && data.repos.length > 0) {
      isWorkspace = true;
      reposCache = data.repos;
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

    const container = document.getElementById("repo-list-container");
    const stats = document.getElementById("stats");

    const dirtyCount = repos.filter((r) => r.dirty).length;
    stats.innerHTML = `${repos.length} repositories`;
    if (dirtyCount > 0) {
      stats.innerHTML += ` &nbsp;<span class="add">${dirtyCount} with changes</span>`;
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

      // Row click → open repo (but not on actions column).
      tr.addEventListener("click", (e) => {
        if (e.target.closest(".repo-actions")) return;
        selectRepo(repo.name);
      });

      // Menu toggle.
      const menuBtn = tr.querySelector(".repo-menu-btn");
      const menu = tr.querySelector(".repo-menu");
      menuBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        closeAllMenus();
        menu.classList.toggle("open");
      });

      // Menu item clicks.
      menu.addEventListener("click", async (e) => {
        e.stopPropagation();
        const item = e.target.closest(".repo-menu-item");
        if (!item) return;
        const action = item.dataset.action;
        const repoName = item.dataset.repo;
        menu.classList.remove("open");

        if (action === "clear") {
          if (!confirm(`Clear all changes in "${repoName}"? This will discard uncommitted modifications.`)) return;
          try {
            const resp = await fetch(`/api/clear?repo=${encodeURIComponent(repoName)}`, { method: "POST" });
            if (!resp.ok) { const d = await resp.json(); alert("Failed: " + (d.error || resp.statusText)); return; }
            reposCache = null;
            const resp2 = await fetchJSON("/api/repos");
            if (resp2.repos) { reposCache = resp2.repos; lastRepoData = resp2; renderRepoListPage(resp2.repos, false, resp2); }
          } catch (err) { alert("Error: " + err.message); }
        } else if (action === "hide") {
          if (!confirm(`Hide "${repoName}" from the workspace list?`)) return;
          try {
            const resp = await fetch(`/api/hide?repo=${encodeURIComponent(repoName)}`, { method: "POST" });
            if (!resp.ok) { const d = await resp.json(); alert("Failed: " + (d.error || resp.statusText)); return; }
            reposCache = null;
            const resp2 = await fetchJSON("/api/repos");
            if (resp2.repos) { reposCache = resp2.repos; lastRepoData = resp2; renderRepoListPage(resp2.repos, false, resp2); }
          } catch (err) { alert("Error: " + err.message); }
        }
      });

      tbody.appendChild(tr);
    });
    table.appendChild(tbody);

    container.innerHTML = "";
    container.appendChild(table);

    // Update settings button visibility based on hidden count.
    const hiddenCount = (data || lastRepoData || {}).hidden || 0;
    // Update settings menu: show hidden item.
    const hiddenItem = document.getElementById("settings-show-hidden");
    const hiddenLabel = document.getElementById("lbl-show-hidden");
    if (hiddenCount > 0) {
      hiddenItem.style.display = "";
      hiddenLabel.textContent = `Show hidden (${hiddenCount})`;
    } else {
      hiddenItem.style.display = "none";
    }
  }

  // ── Repo diff ──

  // selectRepo loads a repo view. initialBase/initialMode come from URL or popstate.
  async function selectRepo(repoName, initialWorktree, initialBase, initialMode) {
    currentRepo = repoName;
    currentWorktree = null;
    if (initialMode) currentMode = initialMode;

    showDiffView();
    setDiffLoading(repoName);

    // Load branches and worktrees in parallel.
    const [branchResult, worktreeResult] = await Promise.allSettled([
      loadBranches(repoName),
      fetchJSON(`/api/worktrees?repo=${encodeURIComponent(repoName)}`),
    ]);

    // Resolve base branch.
    let branches = [];
    let defaultBranch = "main";
    if (branchResult.status === "fulfilled") {
      branches = branchResult.value.branches || [];
      defaultBranch = branchResult.value.default || "main";
    }
    if (initialBase && branches.includes(initialBase)) {
      currentBase = initialBase;
    } else {
      currentBase = defaultBranch;
    }
    renderBaseSelect(branches, currentBase);
    updateDeleteBranchVisibility();
    syncModeToggle();

    // Resolve worktree.
    let worktrees = [];
    if (worktreeResult.status === "fulfilled") {
      worktrees = worktreeResult.value.worktrees || [];
    }
    let activeWt = null;
    if (worktrees.length > 1) {
      activeWt = initialWorktree || worktrees[0].name;
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
    currentWorktree = worktreeName;
    document.getElementById("wt-select").value = worktreeName;

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
    document.getElementById("stats").innerHTML = label;
    document.getElementById("file-list").innerHTML = "";
    document.getElementById("diff-container").innerHTML =
      '<div class="diff-loading">Loading diff…</div>';
  }

  function renderDiffError(message) {
    document.getElementById("diff-container").innerHTML =
      `<div class="diff-error">Error: ${message}</div>`;
  }

  // ── Stats / file list / diff rendering ──

  function renderStats(data) {
    const nFiles = data.files ? data.files.length : 0;
    document.getElementById("stats").innerHTML =
      `${nFiles} file${nFiles !== 1 ? "s" : ""} changed &nbsp;` +
      `<span class="add">+${data.additions || 0}</span> &nbsp;` +
      `<span class="del">-${data.deletions || 0}</span>`;
  }

  function renderFileList(data) {
    const ul = document.getElementById("file-list");
    ul.innerHTML = "";
    if (!data.files) return;

    data.files.forEach((file, idx) => {
      const li = document.createElement("li");
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

      ul.appendChild(li);
    });
  }

  function renderDiff(data) {
    const container = document.getElementById("diff-container");

    if (!data.rawDiff || data.rawDiff.trim() === "") {
      container.innerHTML = '<div class="diff-empty">No changes detected.</div>';
      return;
    }

    const html = Diff2Html.html(data.rawDiff, {
      drawFileList: false,
      matching: "lines",
      outputFormat: currentView,
      colorScheme: "dark",
    });
    container.innerHTML = html;

    container.querySelectorAll(".d2h-file-header").forEach((header, idx) => {
      header.id = `file-header-${idx}`;
      const btn = document.createElement("button");
      btn.className = "file-collapse-btn";
      btn.innerHTML = "▼";
      btn.onclick = (e) => {
        e.stopPropagation();
        toggleFile(btn);
      };
      header.prepend(btn);
    });
  }

  function toggleFile(btn) {
    const wrapper = btn.closest(".d2h-file-wrapper");
    const diff = wrapper && wrapper.querySelector(".d2h-file-diff");
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
    document.getElementById("btn-unified").onclick = () => {
      currentView = "line-by-line";
      document.getElementById("btn-unified").classList.add("active");
      document.getElementById("btn-split").classList.remove("active");
      if (diffData) renderDiff(diffData);
    };
    document.getElementById("btn-split").onclick = () => {
      currentView = "side-by-side";
      document.getElementById("btn-split").classList.add("active");
      document.getElementById("btn-unified").classList.remove("active");
      if (diffData) renderDiff(diffData);
    };
  }

  // ── Mode toggle ──

  function setupModeToggle() {
    document.getElementById("btn-mode-branch").onclick = () => {
      if (currentMode === "branch") return;
      currentMode = "branch";
      syncModeToggle();
      updateURL(false);
      fetchAndRenderDiff();
    };
    document.getElementById("btn-mode-uncommitted").onclick = () => {
      if (currentMode === "uncommitted") return;
      currentMode = "uncommitted";
      syncModeToggle();
      updateURL(false);
      fetchAndRenderDiff();
    };
  }

  // ── Close all open repo menus ──

  function closeAllMenus() {
    document.querySelectorAll(".repo-menu.open, .settings-menu.open").forEach((m) => m.classList.remove("open"));
  }
  document.addEventListener("click", closeAllMenus);

  // ── Init ──

  async function init() {
    setupViewToggle();
    setupModeToggle();
    document.getElementById("btn-delete-branch").onclick = deleteBranch;
    document.getElementById("btn-delete-worktree").onclick = deleteWorktree;

    // Settings dropdown toggle.
    document.getElementById("btn-settings").onclick = (e) => {
      e.stopPropagation();
      const menu = document.getElementById("settings-menu");
      closeAllMenus();
      menu.classList.toggle("open");
    };

    // Show hidden checkbox.
    let showingAll = false;
    document.getElementById("chk-show-hidden").onchange = async (e) => {
      showingAll = e.target.checked;
      document.getElementById("settings-menu").classList.remove("open");
      try {
        const url = showingAll ? "/api/repos?all=true" : "/api/repos";
        const resp = await fetchJSON(url);
        if (resp.repos) {
          reposCache = resp.repos;
          lastRepoData = resp;
          renderRepoListPage(resp.repos, false, resp);
        }
      } catch (_) {}
    };

    // Read URL state at page load.
    const urlState = parseURLState();
    currentMode = urlState.mode || "branch";
    if (urlState.base) currentBase = urlState.base;

    document.getElementById("btn-back").onclick = () => {
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

    const loading = document.getElementById("loading");

    let repos = null;
    try {
      repos = await loadWorkspace();
    } catch (_) {
      // API unavailable or not workspace — fall through to single repo mode.
    }

    loading.style.display = "none";

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

    // Load branches for base dropdown.
    try {
      const branchData = await loadBranches(null);
      const branches = branchData.branches || [];
      const defaultBranch = branchData.default || "main";
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
