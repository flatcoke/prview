(function () {
  "use strict";

  let currentView = "line-by-line";
  let diffData = null;
  let isWorkspace = false;
  let currentRepo = null;

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

  // ── Workspace mode ──

  async function checkWorkspace() {
    const data = await fetchJSON("/api/repos");
    if (!data) return false;
    if (data.workspace && data.repos && data.repos.length > 0) {
      isWorkspace = true;
      renderRepoList(data.repos);
      return true;
    }
    return false;
  }

  function renderRepoList(repos) {
    const sidebar = document.getElementById("sidebar");
    const sidebarHeader = sidebar.querySelector(".sidebar-header");
    sidebarHeader.textContent = "Repositories";

    const ul = document.getElementById("file-list");
    ul.innerHTML = "";

    const stats = document.getElementById("stats");
    stats.innerHTML = `${repos.length} repo${repos.length !== 1 ? "s" : ""} found`;

    const container = document.getElementById("diff-container");
    const empty = document.getElementById("empty-state");
    empty.querySelector("p").textContent = "Select a repository to view changes.";
    container.innerHTML = "";
    container.appendChild(empty);
    empty.style.display = "flex";

    repos.forEach((repo) => {
      const li = document.createElement("li");
      li.onclick = () => selectRepo(repo.name, repos);

      const dirtyDot = repo.dirty
        ? '<span style="color: var(--green); margin-right: 6px;">●</span>'
        : '<span style="color: var(--text-muted); margin-right: 6px;">○</span>';

      li.innerHTML =
        dirtyDot +
        `<span class="filename" title="${repo.name}">${repo.name}</span>` +
        `<span class="file-stats" style="color: var(--text-muted); font-size: 11px;">${repo.branch || ""}</span>`;

      ul.appendChild(li);
    });
  }

  async function selectRepo(repoName, repos) {
    currentRepo = repoName;

    // Highlight selected repo in sidebar
    const items = document.querySelectorAll("#file-list li");
    items.forEach((li) => {
      li.style.background =
        li.querySelector(".filename").textContent === repoName
          ? "var(--bg-tertiary)"
          : "";
    });

    // Fetch diff for this repo
    const url = `/api/diff?repo=${encodeURIComponent(repoName)}`;
    diffData = await fetchJSON(url);

    if (diffData) {
      renderStats(diffData);
      renderDiff(diffData);

      // Show file list below repos — rebuild sidebar with repo selector + files
      renderWorkspaceSidebar(repos, repoName, diffData);
    }
  }

  function renderWorkspaceSidebar(repos, activeRepo, data) {
    const ul = document.getElementById("file-list");
    ul.innerHTML = "";

    // Repo section
    const repoHeader = document.createElement("li");
    repoHeader.style.cssText =
      "padding: 8px 16px; font-size: 11px; font-weight: 600; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px; cursor: default; pointer-events: none;";
    repoHeader.textContent = "Repositories";
    ul.appendChild(repoHeader);

    repos.forEach((repo) => {
      const li = document.createElement("li");
      const isActive = repo.name === activeRepo;
      if (isActive) li.style.background = "var(--bg-tertiary)";
      li.onclick = () => selectRepo(repo.name, repos);

      const dirtyDot = repo.dirty
        ? '<span style="color: var(--green); margin-right: 6px;">●</span>'
        : '<span style="color: var(--text-muted); margin-right: 6px;">○</span>';

      li.innerHTML =
        dirtyDot +
        `<span class="filename" title="${repo.name}">${repo.name}</span>` +
        `<span class="file-stats" style="color: var(--text-muted); font-size: 11px;">${repo.branch || ""}</span>`;

      ul.appendChild(li);
    });

    // Files section (if active repo has files)
    if (data && data.files && data.files.length > 0) {
      const fileHeader = document.createElement("li");
      fileHeader.style.cssText =
        "padding: 8px 16px; font-size: 11px; font-weight: 600; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px; cursor: default; pointer-events: none; border-top: 1px solid var(--border); margin-top: 4px;";
      fileHeader.textContent = `Files — ${activeRepo}`;
      ul.appendChild(fileHeader);

      data.files.forEach((file, idx) => {
        const li = document.createElement("li");
        li.onclick = () => scrollToFile(idx);
        li.style.paddingLeft = "24px";

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

    const config = {
      drawFileList: false,
      matching: "lines",
      outputFormat: currentView,
      highlight: true,
      colorScheme: "dark",
    };

    const ui = new Diff2HtmlUI(targetEl, data.rawDiff, config);
    ui.draw();

    // Add collapse buttons to file headers
    const headers = container.querySelectorAll(".d2h-file-header");
    headers.forEach((header, idx) => {
      const btn = document.createElement("button");
      btn.className = "file-collapse-btn";
      btn.innerHTML = "▼";
      btn.setAttribute("data-file-idx", idx);
      btn.onclick = (e) => {
        e.stopPropagation();
        toggleFile(btn, idx);
      };
      header.prepend(btn);
      header.setAttribute("data-file-idx", idx);
      header.id = `file-header-${idx}`;
    });
  }

  function toggleFile(btn, _idx) {
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

  async function init() {
    setupViewToggle();

    // Check if workspace mode
    const ws = await checkWorkspace();
    if (ws) return; // Workspace mode — wait for repo selection

    // Single repo mode
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
