(function () {
  "use strict";

  let currentView = "line-by-line";
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

  // ── Workspace mode: repo list ──

  async function checkWorkspace() {
    const data = await fetchJSON("/api/repos");
    if (!data) return false;
    if (data.workspace && data.repos && data.repos.length > 0) {
      isWorkspace = true;
      reposCache = data.repos;
      renderRepoListPage(data.repos);
      return true;
    }
    return false;
  }

  function renderRepoListPage(repos) {
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

    const grid = document.createElement("div");
    grid.className = "repo-grid";

    sorted.forEach((repo) => {
      const card = document.createElement("div");
      card.className = "repo-card" + (repo.dirty ? " repo-dirty" : "");
      card.onclick = () => selectRepo(repo.name);

      card.innerHTML =
        `<div class="repo-card-header">` +
        `<span class="repo-name">${repo.name}</span>` +
        `<span class="repo-branch">${repo.branch || ""}</span>` +
        `</div>` +
        `<div class="repo-card-status">` +
        (repo.dirty
          ? '<span class="repo-status-dirty">● Changes</span>'
          : '<span class="repo-status-clean">○ Clean</span>') +
        `</div>`;

      grid.appendChild(card);
    });

    container.appendChild(grid);
  }

  async function selectRepo(repoName) {
    currentRepo = repoName;
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

  // ── Single repo mode ──

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
        (file.additions
          ? `<span class="add">+${file.additions}</span> `
          : "") +
        (file.deletions
          ? `<span class="del">-${file.deletions}</span>`
          : "") +
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

    const config = {
      drawFileList: false,
      matching: "lines",
      outputFormat: currentView,
      highlight: true,
      colorScheme: "dark",
    };

    const ui = new Diff2HtmlUI(targetEl, data.rawDiff, config);
    ui.draw();

    const headers = container.querySelectorAll(".d2h-file-header");
    headers.forEach((header, idx) => {
      const btn = document.createElement("button");
      btn.className = "file-collapse-btn";
      btn.innerHTML = "▼";
      btn.setAttribute("data-file-idx", idx);
      btn.onclick = (e) => {
        e.stopPropagation();
        toggleFile(btn);
      };
      header.prepend(btn);
      header.setAttribute("data-file-idx", idx);
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
    const btnUnified = document.getElementById("btn-unified");
    const btnSplit = document.getElementById("btn-split");

    btnUnified.onclick = () => {
      currentView = "line-by-line";
      btnUnified.classList.add("active");
      btnSplit.classList.remove("active");
      if (diffData) renderDiff(diffData);
    };

    btnSplit.onclick = () => {
      currentView = "side-by-side";
      btnSplit.classList.add("active");
      btnUnified.classList.remove("active");
      if (diffData) renderDiff(diffData);
    };
  }

  function setupBackButton() {
    document.getElementById("btn-back").onclick = () => {
      if (reposCache) {
        renderRepoListPage(reposCache);
      }
    };
  }

  async function init() {
    setupViewToggle();
    setupBackButton();

    const ws = await checkWorkspace();
    if (ws) return;

    // Single repo mode
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
