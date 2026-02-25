(function () {
  "use strict";

  let currentView = "side-by-side";
  let diffData = null;
  let isWorkspace = false;
  let currentRepo = null;
  let reposCache = null;

  async function fetchJSON(url) {
    try {
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return await resp.json();
    } catch (err) {
      console.error("Fetch error:", err);
      return null;
    }
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

  // ── Workspace mode ──

  async function checkWorkspace() {
    const data = await fetchJSON("/api/repos");
    if (!data) return false;
    if (data.workspace && data.repos && data.repos.length > 0) {
      isWorkspace = true;
      reposCache = data.repos;
      renderRepoListPage(data.repos, false);
      return true;
    }
    return false;
  }

  function renderRepoListPage(repos, pushHistory) {
    if (pushHistory !== false) history.pushState({}, "", "/");
    showRepoList();

    const container = document.getElementById("repo-list-container");
    container.innerHTML = "";

    const stats = document.getElementById("stats");
    const dirtyCount = repos.filter((r) => r.dirty).length;
    stats.innerHTML = `${repos.length} repositories`;
    if (dirtyCount > 0) {
      stats.innerHTML += ` &nbsp;<span class="add">${dirtyCount} with changes</span>`;
    }

    // Sort: dirty repos first
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

      tr.innerHTML =
        `<td class="repo-indicator">${repo.dirty ? '<span class="dot-dirty">●</span>' : '<span class="dot-clean">○</span>'}</td>` +
        `<td class="repo-name">${repo.name}</td>` +
        `<td class="repo-branch">${repo.branch || ""}</td>` +
        `<td class="repo-status">${repo.dirty ? "Changes" : "Clean"}</td>`;

      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    container.appendChild(table);
  }

  async function selectRepo(repoName) {
    currentRepo = repoName;
    history.pushState({ repo: repoName }, "", `/repos/${repoName}`);
    showDiffView();

    const stats = document.getElementById("stats");
    stats.innerHTML = `Loading ${repoName}...`;

    const url = `/api/diff?repo=${encodeURIComponent(repoName)}`;
    diffData = await fetchJSON(url);

    if (diffData) {
      renderStats(diffData);
      renderFileList(diffData);
      renderDiff(diffData);
    }
  }

  // ── Diff view ──

  function renderStats(data) {
    const el = document.getElementById("stats");
    const nFiles = data.files ? data.files.length : 0;
    const prefix = currentRepo ? `${currentRepo} — ` : "";
    el.innerHTML =
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

      const badgeClass = `status-${file.status}`;
      const badgeText = file.status.charAt(0).toUpperCase();

      li.innerHTML =
        `<span class="status-badge ${badgeClass}">${badgeText}</span>` +
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
    const empty = document.getElementById("empty-state");

    if (!data.rawDiff || data.rawDiff.trim() === "") {
      container.innerHTML = "";
      empty.querySelector("p").textContent = "No changes detected.";
      container.appendChild(empty);
      empty.style.display = "flex";
      return;
    }

    empty.style.display = "none";

    const targetEl = document.createElement("div");
    targetEl.id = "diff-target";
    container.innerHTML = "";
    container.appendChild(targetEl);

    const html = Diff2Html.html(data.rawDiff, {
      drawFileList: false,
      matching: "lines",
      outputFormat: currentView,
      colorScheme: "dark",
    });
    targetEl.innerHTML = html;

    const headers = container.querySelectorAll(".d2h-file-header");
    headers.forEach((header, idx) => {
      const btn = document.createElement("button");
      btn.className = "file-collapse-btn";
      btn.innerHTML = "▼";
      btn.onclick = (e) => {
        e.stopPropagation();
        toggleFile(btn);
      };
      header.prepend(btn);
      header.id = `file-header-${idx}`;
    });
  }

  function toggleFile(btn) {
    const wrapper = btn.closest(".d2h-file-wrapper");
    const diff = wrapper ? wrapper.querySelector(".d2h-file-diff") : null;
    if (!diff) return;
    const collapsed = diff.style.display === "none";
    diff.style.display = collapsed ? "" : "none";
    btn.classList.toggle("collapsed", !collapsed);
  }

  function scrollToFile(idx) {
    const header = document.getElementById(`file-header-${idx}`);
    if (header) {
      header.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

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

    const ws = await checkWorkspace();
    if (loading) loading.style.display = "none";
    if (ws) {
      // Check URL for direct repo access: /repoName
      const match = window.location.pathname.match(/^\/repos\/(.+)$/);
      const path = match ? match[1] : "";
      if (path && reposCache.some((r) => r.name === path)) {
        await selectRepo(path);
      }
      return;
    }

    if (loading) loading.style.display = "none";
    showDiffView();
    diffData = await fetchJSON("/api/diff");
    if (diffData) {
      renderStats(diffData);
      renderFileList(diffData);
      renderDiff(diffData);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
