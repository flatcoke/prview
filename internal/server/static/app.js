(function () {
  "use strict";

  let currentView = "side-by-side";
  let diffData = null;
  let isWorkspace = false;
  let currentRepo = null;
  let currentWorktree = null;
  let reposCache = null;

  // Active WebSocket manager — holds the current live connection.
  let wsManager = null;

  // ── HTTP ──

  async function fetchJSON(url) {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return resp.json();
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

  // refreshDiff re-fetches the current diff (without touching the worktree bar)
  // and re-renders stats, file list, and diff.
  async function refreshDiff() {
    const repo = currentRepo;
    const wt = currentWorktree;
    try {
      const url = repo ? buildDiffUrl(repo, wt) : "/api/diff";
      const data = await fetchJSON(url);
      diffData = data;
      renderStats(data);
      renderFileList(data);
      renderDiff(data);
    } catch (_) {
      // Silently ignore refresh errors — stale view is better than error flash.
    }
  }

  // stopWS tears down any active WebSocket connection.
  function stopWS() {
    if (wsManager) {
      wsManager.stop();
      wsManager = null;
    }
  }

  // startWS replaces the current WS manager with a new connection.
  function startWS(repo, worktree) {
    stopWS();
    wsManager = connectWS(repo, worktree);
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
    hideWorktreeBar();
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
  }

  // ── Worktree bar ──

  function renderWorktreeBar(worktrees, repoName, activeWorktreeName) {
    const bar = document.getElementById("worktree-bar");
    bar.innerHTML = "";

    worktrees.forEach((wt) => {
      const btn = document.createElement("button");
      btn.className = "wt-tab" + (wt.name === activeWorktreeName ? " active" : "");
      btn.textContent = wt.name;
      btn.onclick = () => selectWorktree(repoName, wt.name);
      bar.appendChild(btn);
    });

    bar.style.display = "flex";
    document.getElementById("container").classList.add("has-worktree-bar");
  }

  function hideWorktreeBar() {
    document.getElementById("worktree-bar").style.display = "none";
    document.getElementById("container").classList.remove("has-worktree-bar");
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

  async function selectRepo(repoName, initialWorktree) {
    currentRepo = repoName;
    currentWorktree = null;

    const url = initialWorktree
      ? `/repos/${repoName}/worktrees/${initialWorktree}`
      : `/repos/${repoName}`;
    history.pushState({ repo: repoName, worktree: initialWorktree || null }, "", url);

    showDiffView();
    setDiffLoading(repoName);

    // Fetch worktrees and determine which one to show.
    let worktrees = [];
    try {
      const wtData = await fetchJSON(
        `/api/worktrees?repo=${encodeURIComponent(repoName)}`
      );
      worktrees = wtData.worktrees || [];
    } catch (_) {}

    let activeWt = null;
    if (worktrees.length > 1) {
      activeWt = initialWorktree || worktrees[0].name;
      currentWorktree = activeWt;
      renderWorktreeBar(worktrees, repoName, activeWt);
    } else {
      hideWorktreeBar();
    }

    try {
      const diffUrl = buildDiffUrl(repoName, activeWt);
      diffData = await fetchJSON(diffUrl);
      renderStats(diffData);
      renderFileList(diffData);
      renderDiff(diffData);
    } catch (err) {
      renderDiffError(err.message);
    }

    // Start live refresh for this repo/worktree.
    startWS(repoName, activeWt);
  }

  async function selectWorktree(repoName, worktreeName) {
    currentWorktree = worktreeName;
    history.pushState(
      { repo: repoName, worktree: worktreeName },
      "",
      `/repos/${repoName}/worktrees/${worktreeName}`
    );

    // Update active tab.
    document.querySelectorAll(".wt-tab").forEach((btn) => {
      btn.classList.toggle("active", btn.textContent === worktreeName);
    });

    setDiffLoading(repoName);
    try {
      const diffUrl = buildDiffUrl(repoName, worktreeName);
      diffData = await fetchJSON(diffUrl);
      renderStats(diffData);
      renderFileList(diffData);
      renderDiff(diffData);
    } catch (err) {
      renderDiffError(err.message);
    }

    // Switch live refresh to the new worktree.
    startWS(repoName, worktreeName);
  }

  function buildDiffUrl(repoName, worktreeName) {
    let url = `/api/diff?repo=${encodeURIComponent(repoName)}`;
    if (worktreeName) {
      url += `&worktree=${encodeURIComponent(worktreeName)}`;
    }
    return url;
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

  // ── URL parsing ──

  function parseRepoPath(pathname) {
    const m = pathname.match(/^\/repos\/(.+)$/);
    if (!m) return { repoName: null, worktreeName: null };
    const rest = m[1];
    // Check for worktree segment: /repos/{repoName}/worktrees/{worktreeName}
    const wtm = rest.match(/^(.+)\/worktrees\/([^/]+)$/);
    if (wtm) {
      return { repoName: wtm[1], worktreeName: wtm[2] };
    }
    return { repoName: rest, worktreeName: null };
  }

  // ── Init ──

  async function init() {
    setupViewToggle();

    document.getElementById("btn-back").onclick = () => {
      if (reposCache) renderRepoListPage(reposCache);
    };

    window.addEventListener("popstate", (e) => {
      if (e.state && e.state.repo) {
        selectRepo(e.state.repo, e.state.worktree || null);
      } else if (reposCache) {
        renderRepoListPage(reposCache, false);
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
      const { repoName, worktreeName } = parseRepoPath(window.location.pathname);
      if (repoName && repos.some((r) => r.name === repoName)) {
        await selectRepo(repoName, worktreeName);
      } else {
        renderRepoListPage(repos, false);
      }
      return;
    }

    // Single repo mode.
    showDiffView();
    setDiffLoading("");
    try {
      diffData = await fetchJSON("/api/diff");
      renderStats(diffData);
      renderFileList(diffData);
      renderDiff(diffData);
    } catch (err) {
      renderDiffError(err.message);
    }

    // Start live refresh for single-repo mode (no repo param).
    startWS(null, null);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
