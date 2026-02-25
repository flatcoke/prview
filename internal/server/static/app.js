(function () {
  "use strict";

  let currentView = "side-by-side";
  let diffData = null;
  let isWorkspace = false;
  let currentRepo = null;
  let reposCache = null;

  // ── HTTP ──

  async function fetchJSON(url) {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return resp.json();
  }

  // ── Layout switching ──

  function showRepoList() {
    document.getElementById("sidebar").style.display = "none";
    document.getElementById("diff-container").style.display = "none";
    document.getElementById("repo-list-container").style.display = "flex";
    document.getElementById("btn-back").style.display = "none";
    document.querySelector(".header-right").style.display = "none";
    currentRepo = null;
  }

  function showDiffView() {
    document.getElementById("sidebar").style.display = "";
    document.getElementById("diff-container").style.display = "";
    document.getElementById("repo-list-container").style.display = "none";
    if (isWorkspace) {
      document.getElementById("btn-back").style.display = "";
    }
    document.querySelector(".header-right").style.display = "";
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

  async function selectRepo(repoName) {
    currentRepo = repoName;
    history.pushState({ repo: repoName }, "", `/repos/${repoName}`);

    // Show diff view with loading state immediately — clears any previous diff.
    showDiffView();
    setDiffLoading(repoName);

    try {
      const url = `/api/diff?repo=${encodeURIComponent(repoName)}`;
      diffData = await fetchJSON(url);
      renderStats(diffData);
      renderFileList(diffData);
      renderDiff(diffData);
    } catch (err) {
      renderDiffError(err.message);
    }
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
    const prefix = currentRepo ? `${currentRepo} — ` : "";
    document.getElementById("stats").innerHTML =
      prefix +
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

  // ── Init ──

  async function init() {
    setupViewToggle();

    document.getElementById("btn-back").onclick = () => {
      if (reposCache) renderRepoListPage(reposCache);
    };

    window.addEventListener("popstate", (e) => {
      if (e.state && e.state.repo) {
        selectRepo(e.state.repo);
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
      // Workspace mode: honour direct URL like /repos/parent/child.
      const match = window.location.pathname.match(/^\/repos\/(.+)$/);
      const repoName = match ? match[1] : "";
      if (repoName && repos.some((r) => r.name === repoName)) {
        await selectRepo(repoName);
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
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
