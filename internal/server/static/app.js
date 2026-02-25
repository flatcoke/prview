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
      updateURL(false);
      fetchAndRenderDiff();
    };
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
    document.querySelector(".header-right").style.display = "none";
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
    document.querySelector(".header-right").style.display = "";
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
    sel.onchange = () => selectWorktree(repoName, sel.value);
    document.getElementById("worktree-control").style.display = "";
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
      return data.repos;
    }
    return null;
  }

  function renderRepoListPage(repos, pushHistory) {
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
      return a.name.localeCompare(b.name);
    });

    const table = document.createElement("table");
    table.className = "repo-table";

    const thead = document.createElement("thead");
    thead.innerHTML = `<tr>
      <th></th>
      <th>Repository</th>
      <th>Branch</th>
      <th>Status</th>
    </tr>`;
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    sorted.forEach((repo) => {
      const tr = document.createElement("tr");
      tr.className = repo.dirty ? "repo-dirty" : "";
      tr.onclick = () => selectRepo(repo.name);

      const indicator = repo.dirty
        ? '<span class="dot-dirty">●</span>'
        : '<span class="dot-clean">○</span>';

      tr.innerHTML =
        `<td class="repo-indicator">${indicator}</td>` +
        `<td class="repo-name">${repo.name}</td>` +
        `<td class="repo-branch">${repo.branch || ""}</td>` +
        `<td class="repo-status">${repo.dirty ? "Changes" : "Clean"}</td>`;

      tbody.appendChild(tr);
    });
    table.appendChild(tbody);

    container.innerHTML = "";
    container.appendChild(table);
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

  // ── Init ──

  async function init() {
    setupViewToggle();
    setupModeToggle();

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
