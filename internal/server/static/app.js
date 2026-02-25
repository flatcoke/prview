(function () {
  "use strict";

  let currentView = "line-by-line";
  let diffData = null;

  async function fetchDiff() {
    try {
      const resp = await fetch("/api/diff");
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return await resp.json();
    } catch (err) {
      console.error("Failed to fetch diff:", err);
      return null;
    }
  }

  function renderStats(data) {
    const el = document.getElementById("stats");
    const nFiles = data.files ? data.files.length : 0;
    el.innerHTML = `${nFiles} file${nFiles !== 1 ? "s" : ""} changed &nbsp;`
      + `<span class="add">+${data.additions || 0}</span> &nbsp;`
      + `<span class="del">-${data.deletions || 0}</span>`;
  }

  function renderFileList(data) {
    const ul = document.getElementById("file-list");
    ul.innerHTML = "";
    if (!data.files) return;

    data.files.forEach((file, idx) => {
      const li = document.createElement("li");
      li.onclick = () => scrollToFile(idx);

      const name = file.status === "renamed"
        ? `${file.oldName} → ${file.newName}`
        : (file.status === "deleted" ? file.oldName : file.newName);

      const badgeClass = `status-${file.status}`;
      const badgeText = file.status.charAt(0).toUpperCase();

      li.innerHTML = `<span class="status-badge ${badgeClass}">${badgeText}</span>`
        + `<span class="filename" title="${name}">${name}</span>`
        + `<span class="file-stats">`
        + (file.additions ? `<span class="add">+${file.additions}</span> ` : "")
        + (file.deletions ? `<span class="del">-${file.deletions}</span>` : "")
        + `</span>`;

      ul.appendChild(li);
    });
  }

  function renderDiff(data) {
    const container = document.getElementById("diff-container");
    const empty = document.getElementById("empty-state");

    if (!data.rawDiff || data.rawDiff.trim() === "") {
      container.innerHTML = "";
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

  function toggleFile(btn, idx) {
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
    diffData = await fetchDiff();
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
