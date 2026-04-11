if (!window.rovot || typeof window.rovot.baseUrl !== "function") {
  throw new Error(
    "Preload bridge unavailable (window.rovot missing). Check Electron preload and sandbox settings."
  );
}

const baseUrl = window.rovot.baseUrl();

// Token is fetched from the main process ONCE at startup (see bottom of file)
// and cached here.  All API / WebSocket calls use this cached value so the
// main process never has to re-read the token file after the initial load.
let cachedToken = "";

// DOM refs
const statusEl         = document.getElementById("connection-status");
const modelIndicator   = document.getElementById("model-indicator");
const privacyIndicator = document.getElementById("privacy-indicator");
const messagesEl       = document.getElementById("messages");
const approvalsEl      = document.getElementById("approvals"); // legacy anchor, hidden
const inputEl          = document.getElementById("input");
const sendBtn          = document.getElementById("send");
const recBtn           = document.getElementById("record");
const onboardingEl     = document.getElementById("onboarding");
const timelineEventsEl = document.getElementById("timeline-events");
const backendOverlay   = document.getElementById("backend-status-overlay");
const backendConnecting = document.getElementById("backend-connecting");
const backendError     = document.getElementById("backend-error");

let currentSessionId  = null;
let ws                = null;
let cachedConfig      = null;
let isSending         = false;
let timelineCollapsed = false;
let wsRetryCount      = 0;
const WS_MAX_RETRIES  = 5;

// Streaming state
let streamAbortController = null;

// Tools approved for the entire session (persists until page reload)
const sessionAllowedTools = new Set();

// Last active settings tab
let lastSettingsTab = "models";

// ── Helpers ──

function getToken() { return cachedToken; }

async function api(path, opts = {}) {
  const headers = opts.headers || {};
  headers["Authorization"] = `Bearer ${getToken()}`;
  return fetch(baseUrl + path, { ...opts, headers });
}

async function readJsonOrThrow(response) {
  const text = await response.text();
  if (!response.ok) {
    let detail = text || `HTTP ${response.status}`;
    try {
      const parsed = text ? JSON.parse(text) : null;
      if (parsed && typeof parsed === "object") {
        detail = parsed.detail || parsed.message || detail;
      }
    } catch (_) {}
    throw new Error(`Request failed (${response.status}): ${detail}`);
  }
  if (!text) return {};
  try { return JSON.parse(text); }
  catch (err) { throw new Error(`Invalid JSON response: ${err.message}`); }
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// ── Toast notifications ──

function showToast(message, type = "error", duration = 5000) {
  const container = document.getElementById("toast-container");
  const toast = document.createElement("div");
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.animation = "toast-out 0.18s ease forwards";
    setTimeout(() => toast.remove(), 200);
  }, duration);
}

// ── Enhanced Markdown renderer ──

function renderInline(html) {
  html = html.replace(/`([^`\n]+)`/g, '<code class="md-inline-code">$1</code>');
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/\*([^*\n]+)\*/g, "<em>$1</em>");
  html = html.replace(/~~([^~]+)~~/g, "<s>$1</s>");
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g,
    '<a class="md-link" data-href="$2">$1</a>');
  return html;
}

function renderMarkdown(text) {
  const lines = text.split("\n");
  const out   = [];
  let inCode  = false;
  let codeLang = "";
  let codeLines = [];
  let listType  = null; // "ul" | "ol"

  const flushList = () => {
    if (listType) { out.push(`</${listType}>`); listType = null; }
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];

    // ── Fenced code block ──
    if (raw.startsWith("```")) {
      if (inCode) {
        out.push(
          `<pre class="md-code-block"><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`
        );
        codeLines = []; inCode = false; codeLang = "";
      } else {
        flushList();
        codeLang = raw.slice(3).trim();
        inCode = true;
      }
      continue;
    }
    if (inCode) { codeLines.push(raw); continue; }

    const escaped = escapeHtml(raw);

    // ── Unordered list ──
    const ulm = raw.match(/^(\s*)[-*+] (.+)/);
    if (ulm) {
      if (listType !== "ul") { flushList(); out.push("<ul>"); listType = "ul"; }
      out.push(`<li>${renderInline(escapeHtml(ulm[2]))}</li>`);
      continue;
    }
    // ── Ordered list ──
    const olm = raw.match(/^(\s*)\d+\. (.+)/);
    if (olm) {
      if (listType !== "ol") { flushList(); out.push("<ol>"); listType = "ol"; }
      out.push(`<li>${renderInline(escapeHtml(olm[2]))}</li>`);
      continue;
    }

    flushList();

    // ── Blank line ──
    if (!raw.trim()) { out.push("<br>"); continue; }

    // ── ATX headings ──
    const hm = raw.match(/^(#{1,3}) (.+)/);
    if (hm) {
      const lvl = hm[1].length;
      out.push(`<h${lvl}>${renderInline(escapeHtml(hm[2]))}</h${lvl}>`);
      continue;
    }
    // ── Blockquote ──
    const bq = raw.match(/^> (.+)/);
    if (bq) { out.push(`<blockquote>${renderInline(escapeHtml(bq[1]))}</blockquote>`); continue; }
    // ── Horizontal rule ──
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(raw.trim())) { out.push("<hr>"); continue; }

    out.push(renderInline(escaped) + "<br>");
  }

  // Close unclosed fence or list
  if (inCode) out.push(`<pre class="md-code-block"><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
  flushList();

  return out.join("");
}

// Open markdown links externally via Electron's setWindowOpenHandler
messagesEl.addEventListener("click", (e) => {
  const link = e.target.closest(".md-link");
  if (!link) return;
  e.preventDefault();
  const href = link.getAttribute("data-href") || "";
  if (href.startsWith("http://") || href.startsWith("https://")) {
    window.open(href, "_blank"); // intercepted by main.js setWindowOpenHandler
  }
});

// ── addMsg — creates wrapper with message + meta row ──

function addMsg(role, text) {
  removeTypingIndicator();

  // Hide empty state on first message
  const emptyState = document.getElementById("chat-empty-state");
  if (emptyState) emptyState.classList.add("hidden");

  const wrapper = document.createElement("div");
  wrapper.className = `msg-wrapper ${role}`;

  const div = document.createElement("div");
  div.className = `msg ${role}`;
  if (role === "assistant") {
    div.innerHTML = renderMarkdown(text);
  } else {
    div.textContent = text;
  }
  wrapper.appendChild(div);

  // Meta row: timestamp + copy button (assistant only)
  const meta = document.createElement("div");
  meta.className = "msg-meta";

  const ts = document.createElement("span");
  ts.className = "msg-timestamp";
  ts.textContent = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  meta.appendChild(ts);

  if (role === "assistant") {
    const copyBtn = document.createElement("button");
    copyBtn.className = "btn-copy";
    copyBtn.title = "Copy to clipboard";
    copyBtn.innerHTML =
      '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
      '<rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>' +
      '<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> Copy';
    copyBtn.addEventListener("click", () => {
      navigator.clipboard.writeText(text).then(() => {
        copyBtn.innerHTML =
          '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
          '<polyline points="20 6 9 12 4 16"/></svg> Copied';
        copyBtn.classList.add("copied");
        setTimeout(() => {
          copyBtn.innerHTML =
            '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
            '<rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>' +
            '<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> Copy';
          copyBtn.classList.remove("copied");
        }, 2000);
      }).catch(() => showToast("Copy failed — clipboard unavailable", "warning", 3000));
    });
    meta.appendChild(copyBtn);
  }

  wrapper.appendChild(meta);
  messagesEl.appendChild(wrapper);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function showTypingIndicator() {
  if (document.getElementById("typing-indicator")) return;
  const div = document.createElement("div");
  div.id = "typing-indicator";
  div.className = "msg assistant typing";
  div.innerHTML = '<span class="dot"></span><span class="dot"></span><span class="dot"></span>';
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function removeTypingIndicator() {
  const el = document.getElementById("typing-indicator");
  if (el) el.remove();
}

function setSendingState(sending) {
  isSending = sending;
  inputEl.disabled = sending;
  if (sending) {
    sendBtn.textContent = "Stop";
    sendBtn.classList.add("btn-stop");
    sendBtn.onclick = stopStreaming;
  } else {
    sendBtn.textContent = "Send";
    sendBtn.classList.remove("btn-stop");
    sendBtn.onclick = sendMessage;
    streamAbortController = null;
  }
}

function stopStreaming() {
  if (streamAbortController) {
    streamAbortController.abort();
    streamAbortController = null;
  }
  setSendingState(false);
  removeTypingIndicator();
}

// ── Activity Timeline ──

function addTimelineEvent(type, detail) {
  const item = document.createElement("div");
  item.className = `timeline-item timeline-${type}`;
  const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const icons = {
    tool_call:         "&#9881;",
    approval:          "&#9888;",
    approval_resolved: "&#10003;",
    error:             "&#10007;",
    chat:              "&#9993;",
  };
  item.innerHTML = `
    <div class="timeline-icon">${icons[type] || "&#8226;"}</div>
    <div class="timeline-body">
      <div class="timeline-meta">
        <span class="timeline-type">${escapeHtml(type.replace(/_/g, " "))}</span>
        <span class="timeline-time">${time}</span>
      </div>
      <div class="timeline-detail">${escapeHtml(detail)}</div>
    </div>`;
  timelineEventsEl.prepend(item);
  while (timelineEventsEl.children.length > 200) {
    timelineEventsEl.removeChild(timelineEventsEl.lastChild);
  }
}

document.getElementById("toggle-timeline").addEventListener("click", () => {
  timelineCollapsed = !timelineCollapsed;
  document.getElementById("activity-timeline").classList.toggle("collapsed", timelineCollapsed);
});

// ── Sidebar navigation (Chat + Settings) ──

document.querySelectorAll(".nav-item").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".nav-item").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    const target = btn.getAttribute("data-view");
    document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
    document.getElementById(`view-${target}`).classList.add("active");
    if (target === "settings") activateSettingsTab(lastSettingsTab);
  });
});

// ── Settings tabs ──

document.querySelectorAll(".settings-tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    activateSettingsTab(tab.getAttribute("data-tab"));
  });
});

function activateSettingsTab(tab) {
  lastSettingsTab = tab;
  document.querySelectorAll(".settings-tab").forEach((t) => t.classList.remove("active"));
  const tabEl = document.querySelector(`.settings-tab[data-tab="${tab}"]`);
  if (tabEl) tabEl.classList.add("active");
  document.querySelectorAll(".settings-panel").forEach((p) => p.classList.remove("active"));
  const panelEl = document.getElementById(`settings-panel-${tab}`);
  if (panelEl) panelEl.classList.add("active");
  if (tab === "models")     loadModelsView();
  if (tab === "connectors") loadConnectorsView();
  if (tab === "security")   loadSecurityView();
  if (tab === "memory")     loadMemoryView();
  if (tab === "logs")       loadLogsView();
}

// ── Backend connection & Onboarding ──

async function waitForBackend(maxAttempts = 15) {
  backendOverlay.classList.remove("hidden");
  backendConnecting.classList.remove("hidden");
  backendError.classList.add("hidden");
  let lastHealthError = "";

  const connectingMsg = backendConnecting.querySelector("p");
  const connectingH2  = backendConnecting.querySelector("h2");

  const fetchHealthWithTimeout = async (timeoutMs = 1500) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await api("/health", { signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
  };

  for (let i = 0; i < maxAttempts; i++) {
    if (connectingH2) connectingH2.textContent = `Connecting to backend... (attempt ${i + 1}/${maxAttempts})`;

    if (i === 5 && connectingMsg) {
      connectingMsg.textContent = "Taking longer than expected. The daemon may still be starting.";
    }
    if (i === 3) {
      // Show daemon error log early
      try {
        const errMsg = await window.rovot.getDaemonError();
        if (errMsg && errMsg.trim()) {
          const detail = document.getElementById("backend-error-detail");
          if (detail) detail.textContent = errMsg.slice(-500);
        }
      } catch (_) {}
    }

    try {
      const r = await fetchHealthWithTimeout();
      if (r.ok) { backendOverlay.classList.add("hidden"); return true; }
      lastHealthError = `Health endpoint returned status ${r.status}`;
    } catch (err) {
      lastHealthError = err?.name === "AbortError"
        ? "Health request timed out."
        : (err?.message || "Unknown health check failure.");
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  backendConnecting.classList.add("hidden");
  backendError.classList.remove("hidden");
  try {
    const errMsg = await window.rovot.getDaemonError();
    const detail = document.getElementById("backend-error-detail");
    if (detail) {
      const details = [];
      if (lastHealthError) details.push(`Last health check error: ${lastHealthError}`);
      if (errMsg) details.push(errMsg.slice(-500));
      detail.textContent = details.join("\n\n");
    }
  } catch (err) {
    const detail = document.getElementById("backend-error-detail");
    if (detail && lastHealthError) {
      detail.textContent = `Last health check error: ${lastHealthError}\n\nFailed to read daemon logs: ${err?.message || "unknown error"}`;
    }
  }
  return false;
}

document.getElementById("backend-retry").addEventListener("click", async () => {
  const ok = await waitForBackend(15);
  if (ok) await checkOnboarding();
});

async function checkOnboarding() {
  const backendReady = await waitForBackend(15);
  if (!backendReady) return;
  try {
    const r = await api("/config");
    if (r.ok) {
      cachedConfig = await r.json();
      if (cachedConfig.onboarded === true) {
        onboardingEl.classList.add("hidden");
        applyUserMode(cachedConfig.user_mode || "standard");
        updateIndicators();
        return;
      }
    }
  } catch (_) { return; }
  onboardingEl.classList.remove("hidden");
}

// Onboarding state
let _onboardMode = "standard"; // "standard" | "developer"
let _onboardModelFilename = null;
let _onboardModelName = null;
let _onboardDownloadingFilename = null;

function setupOnboarding() {
  // Step 0: mode card selection
  document.querySelectorAll('input[name="user-mode"]').forEach((radio) => {
    radio.addEventListener("change", () => {
      document.querySelectorAll('.option-card').forEach((c) => c.classList.remove("selected"));
      radio.closest(".option-card").classList.add("selected");
      _onboardMode = radio.value;
    });
  });

  document.getElementById("onboard-step0-next").addEventListener("click", async () => {
    await api("/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: "user_mode", value: _onboardMode }) });
    goToOnboardStep(1);
    await _loadOnboardStep1();
  });

  // Step 1 navigation
  document.getElementById("onboard-back-1").addEventListener("click", () => goToOnboardStep(0));
  document.getElementById("onboard-next-1").addEventListener("click", () => goToOnboardStep(2));

  // Developer mode compute radio listeners
  document.querySelectorAll('input[name="compute"]').forEach((radio) => {
    radio.addEventListener("change", () => {
      document.querySelectorAll('.option-card').forEach((c) => c.classList.remove("selected"));
      radio.closest(".option-card").classList.add("selected");
      const apiSection = document.getElementById("api-key-section");
      if (apiSection) apiSection.classList.toggle("hidden", radio.value !== "api");
      const builtinNote = document.getElementById("builtin-onboard-note");
      if (builtinNote) builtinNote.classList.toggle("hidden", radio.value !== "builtin");
      const probeWrap = document.getElementById("model-probe-results-wrap");
      if (probeWrap) {
        probeWrap.classList.toggle("hidden", radio.value !== "local");
        if (radio.value === "local") probeModels();
      }
    });
  });

  // Step 2 navigation
  document.getElementById("onboard-back-2").addEventListener("click", () => goToOnboardStep(1));
  document.getElementById("onboard-next-2").addEventListener("click", () => goToOnboardStep(3));

  // Step 3 navigation
  document.getElementById("onboard-back-3").addEventListener("click", () => goToOnboardStep(2));
  document.getElementById("onboard-next-3").addEventListener("click", () => goToOnboardStep(4));

  // Step 4 privacy checkbox
  const privacyCb = document.getElementById("onboard-privacy-understood");
  const privacyNext = document.getElementById("onboard-next-4");
  if (privacyCb && privacyNext) {
    privacyCb.addEventListener("change", () => { privacyNext.disabled = !privacyCb.checked; });
  }
  document.getElementById("onboard-back-4").addEventListener("click", () => goToOnboardStep(3));
  document.getElementById("onboard-next-4").addEventListener("click", () => {
    goToOnboardStep(5);
    _loadOnboardStep5();
  });

  // Step 5 finish
  document.getElementById("onboard-finish").addEventListener("click", finishOnboarding);

  // Hide macOS connector row on non-macOS
  const macosRow = document.getElementById("onboard-macos-row");
  if (macosRow && !navigator.userAgent.includes("Mac")) {
    macosRow.classList.add("hidden");
  }
}

async function _loadOnboardStep1() {
  const stdBranch = document.getElementById("step1-standard");
  const devBranch = document.getElementById("step1-developer");

  if (_onboardMode === "standard") {
    stdBranch.classList.remove("hidden");
    devBranch.classList.add("hidden");

    const cardEl = document.getElementById("step1-recommended-card");
    const rec = await getRecommendedModel();
    if (rec) {
      _onboardModelFilename = rec.recommended_filename;
      _onboardModelName = rec.recommended_name;
      const catalogEntry = await getCatalogEntry(rec.recommended_filename);
      const metaParts = [];
      if (catalogEntry?.size_gb) metaParts.push(`${catalogEntry.size_gb} GB`);
      if (catalogEntry?.ram_required_gb) metaParts.push(`${catalogEntry.ram_required_gb} GB RAM`);
      const metaStr = metaParts.join(" · ");
      cardEl.innerHTML = `
        <div class="catalog-info">
          <strong>${escapeHtml(rec.recommended_name)}</strong>
          <span class="badge badge-green" style="margin-left:6px">Recommended for your device</span>
          ${metaStr ? `<span class="catalog-meta" style="display:block;margin-top:4px">${escapeHtml(metaStr)}</span>` : ""}
          <span class="catalog-desc" style="display:block;margin-top:4px">${escapeHtml(rec.reason)}</span>
        </div>`;
    } else {
      _onboardModelFilename = null;
      _onboardModelName = null;
      cardEl.innerHTML = `<div class="info-box">Could not detect device specs. Choose a model below.</div>`;
    }

    // "Choose a different model" toggle
    const chooseDiffBtn = document.getElementById("step1-choose-different");
    if (chooseDiffBtn && !chooseDiffBtn.dataset.init) {
      chooseDiffBtn.dataset.init = "true";
      chooseDiffBtn.addEventListener("click", async () => {
        const altSection = document.getElementById("step1-alt-models");
        altSection.classList.toggle("hidden");
        if (!altSection.classList.contains("hidden") && !altSection.dataset.loaded) {
          altSection.dataset.loaded = "true";
          const listEl = document.getElementById("step1-catalog-list");
          listEl.innerHTML = '<div class="info-box">Loading…</div>';
          try {
            const r = await api("/models/internal/catalog");
            const catalog = await r.json();
            listEl.innerHTML = "";
            catalog.forEach(item => {
              const card = document.createElement("div");
              card.className = "catalog-card";
              card.innerHTML = `
                <div class="catalog-info">
                  <strong>${escapeHtml(item.name)}</strong>
                  <span class="catalog-meta" style="display:block;margin-top:4px">${item.size_gb || "?"} GB · ${item.ram_required_gb || "?"} GB RAM</span>
                  <span class="catalog-desc" style="display:block">${escapeHtml(item.description || "")}</span>
                </div>
                <div class="catalog-action">
                  <button class="btn secondary btn-sm step1-select-btn" data-filename="${escapeHtml(item.filename)}" data-name="${escapeHtml(item.name)}">Select</button>
                </div>`;
              card.querySelector(".step1-select-btn").addEventListener("click", (e) => {
                _onboardModelFilename = e.target.dataset.filename;
                _onboardModelName = e.target.dataset.name;
                listEl.querySelectorAll(".step1-select-btn").forEach(b => { b.textContent = "Select"; b.classList.replace("primary", "secondary"); });
                e.target.textContent = "Selected ✓";
                e.target.classList.replace("secondary", "primary");
              });
              listEl.appendChild(card);
            });
          } catch (_) {
            listEl.innerHTML = '<div class="info-box">Could not load catalog.</div>';
          }
        }
      });
    }
  } else {
    // Developer mode
    stdBranch.classList.add("hidden");
    devBranch.classList.remove("hidden");
    // Auto-probe if local is selected
    const selectedCompute = document.querySelector('input[name="compute"]:checked')?.value;
    if (selectedCompute === "local") {
      document.getElementById("model-probe-results-wrap")?.classList.remove("hidden");
      probeModels();
    }
  }

  // Step 4: configure based on mode
  const privacyUnderstandRow = document.getElementById("privacy-understand-row");
  const privacyNext = document.getElementById("onboard-next-4");
  if (_onboardMode === "developer") {
    if (privacyUnderstandRow) privacyUnderstandRow.classList.add("hidden");
    if (privacyNext) privacyNext.disabled = false;
  } else {
    if (privacyUnderstandRow) privacyUnderstandRow.classList.remove("hidden");
    if (privacyNext) privacyNext.disabled = !(document.getElementById("onboard-privacy-understood")?.checked);
  }
}

async function _loadOnboardStep5() {
  const stdContent = document.getElementById("step5-standard-content");
  const devContent = document.getElementById("step5-developer-content");
  const finishBtn = document.getElementById("onboard-finish");

  if (_onboardMode === "standard") {
    stdContent.classList.remove("hidden");
    devContent.classList.add("hidden");

    if (_onboardModelFilename) {
      const modelLabel = document.getElementById("step5-model-label");
      const statusLabel = document.getElementById("step5-status-label");
      const progressBar = document.getElementById("step5-progress-bar");

      if (modelLabel) modelLabel.textContent = `Downloading ${_onboardModelName || _onboardModelFilename}…`;
      if (progressBar) progressBar.style.display = "";
      if (statusLabel) statusLabel.textContent = "";
      if (finishBtn) finishBtn.disabled = true;

      const catalogEntry = await getCatalogEntry(_onboardModelFilename);
      if (!catalogEntry?.hf_url) {
        if (statusLabel) statusLabel.textContent = "Could not find download URL. You can download later in Settings → Models.";
        if (finishBtn) finishBtn.disabled = false;
        return;
      }
      _onboardDownloadingFilename = _onboardModelFilename;
      try {
        await api("/models/internal/download", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ filename: _onboardModelFilename, hf_url: catalogEntry.hf_url }),
        });
      } catch (err) {
        if (statusLabel) statusLabel.textContent = `Download failed: ${err.message}. You can retry in Settings → Models.`;
        if (finishBtn) finishBtn.disabled = false;
        _onboardDownloadingFilename = null;
      }
    } else {
      document.getElementById("step5-download-section")?.classList.add("hidden");
      document.getElementById("step5-no-model")?.classList.remove("hidden");
      if (finishBtn) finishBtn.disabled = false;
    }
  } else {
    stdContent.classList.add("hidden");
    devContent.classList.remove("hidden");
    if (finishBtn) finishBtn.disabled = false;
  }
}

function goToOnboardStep(n) {
  document.querySelectorAll(".onboard-page").forEach((p) => p.classList.remove("active"));
  document.querySelectorAll(".step-dot").forEach((d) => d.classList.remove("active"));
  const page = document.querySelector(`.onboard-page[data-page="${n}"]`);
  const dot  = document.querySelector(`.step-dot[data-step="${n}"]`);
  if (page) page.classList.add("active");
  if (dot)  dot.classList.add("active");
}

async function probeModels() {
  const container = document.getElementById("model-probe-results");
  if (!container) return;
  const servers = [
    { name: "LM Studio", url: "http://localhost:1234/v1" },
    { name: "Ollama",    url: "http://localhost:11434/v1" },
  ];
  container.innerHTML = servers.map((s) =>
    `<div class="probe-item scanning" data-url="${s.url}">
      <span class="probe-label">${s.name} (${s.url})</span>
      <span class="probe-status">scanning...</span>
    </div>`
  ).join("");
  for (const s of servers) {
    const el = container.querySelector(`[data-url="${s.url}"]`);
    try {
      // Probe directly from renderer (not via daemon) with short timeout
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2000);
      let models = [];
      try {
        const r = await fetch(`${s.url}/models`, { signal: controller.signal });
        clearTimeout(timer);
        if (r.ok) {
          const data = await r.json();
          models = (data.data || []).map((m) => m.id || m).filter(Boolean);
        } else { throw new Error("not ok"); }
      } finally {
        clearTimeout(timer);
      }
      el.classList.remove("scanning");
      el.classList.add("found");
      el.querySelector(".probe-status").textContent =
        models.length > 0 ? `Found: ${models.slice(0, 3).join(", ")}` : "server online";

      if (models.length > 0) {
        el.querySelector(".probe-status").textContent = `Testing ${models[0].id || models[0]}...`;
        try {
          const testController = new AbortController();
          const testTimer = setTimeout(() => testController.abort(), 8000);
          const testResp = await fetch(`${s.url}/chat/completions`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            signal: testController.signal,
            body: JSON.stringify({
              model: models[0].id || models[0],
              messages: [{ role: "user", content: "hi" }],
              max_tokens: 5,
            }),
          });
          clearTimeout(testTimer);
          if (testResp.ok) {
            el.querySelector(".probe-status").textContent =
              `✓ Ready — ${models[0].id || models[0]}`;
            el.dataset.verified = "true";
          } else {
            el.querySelector(".probe-status").textContent =
              `Found but test failed (HTTP ${testResp.status})`;
            el.classList.replace("found", "not-found");
          }
        } catch (_) {
          el.querySelector(".probe-status").textContent = `Found but test timed out`;
          el.classList.replace("found", "not-found");
        }
      }
    } catch (_) {
      el.classList.remove("scanning");
      el.classList.add("not-found");
      el.querySelector(".probe-status").textContent = "not found";
    }
  }
}

async function finishOnboarding() {
  const btn = document.getElementById("onboard-finish");
  btn.disabled = true;
  btn.textContent = "Saving…";

  // Persist user_mode (was saved in step 0, but confirm)
  await api("/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: "user_mode", value: _onboardMode }) });

  let useInternalModel = false;

  if (_onboardMode === "developer") {
    const compute = document.querySelector('input[name="compute"]:checked')?.value || "local";
    if (compute === "local") {
      const found = document.querySelector(".probe-item[data-verified='true']") ||
                    document.querySelector(".probe-item.found");
      const url = found ? found.getAttribute("data-url") : "http://localhost:1234/v1";
      await api("/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: "model.provider_mode", value: "local" }) });
      await api("/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: "model.base_url", value: url }) });
    } else if (compute === "builtin") {
      await api("/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: "model.provider_mode", value: "internal" }) });
      useInternalModel = true;
    } else {
      const apiUrl = document.getElementById("onboard-api-url")?.value.trim() || "";
      const apiKey = document.getElementById("onboard-api-key")?.value.trim() || "";
      await api("/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: "model.provider_mode", value: "cloud" }) });
      if (apiUrl) await api("/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: "model.cloud_base_url", value: apiUrl }) });
      if (apiKey) await api("/secrets", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: "openai.api_key", value: apiKey }) });
    }
  } else {
    // Standard mode: model was already downloading / will be loaded automatically
    if (_onboardModelFilename) {
      await api("/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: "model.provider_mode", value: "internal" }) });
    }
  }

  // Connectors
  const fsEnabled      = document.getElementById("onboard-fs")?.checked !== false;
  const emailEnabled   = document.getElementById("onboard-email")?.checked === true;
  const browserEnabled = document.getElementById("onboard-browser")?.checked === true;
  const macosEnabled   = document.getElementById("onboard-macos")?.checked === true;
  await api("/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: "connectors.filesystem_enabled", value: fsEnabled }) });
  await api("/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: "connectors.email.enabled", value: emailEnabled }) });
  await api("/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: "connectors.browser_enabled", value: browserEnabled }) });
  await api("/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: "connectors.macos_automation_enabled", value: macosEnabled }) });

  // Workspace
  const workspace = document.getElementById("onboard-workspace")?.value.trim();
  if (workspace) await api("/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: "settings.workspace_dir", value: workspace }) });

  await api("/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: "onboarded", value: true }) });

  _onboardDownloadingFilename = null;
  btn.disabled = false;
  btn.textContent = "Start chatting";
  onboardingEl.classList.add("hidden");
  await refreshConfig();

  if (useInternalModel) {
    document.querySelectorAll(".nav-item").forEach((b) => b.classList.remove("active"));
    const settingsBtn = document.querySelector('.nav-item[data-view="settings"]');
    if (settingsBtn) settingsBtn.classList.add("active");
    document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
    document.getElementById("view-settings").classList.add("active");
    activateSettingsTab("models");
    _updateBuiltinModeToggle("internal");
    await loadBuiltinSection();
    showToast("To get started, download a model in the Models tab. We recommend Llama 3.2 3B (2GB).", "success", 8000);
  }
}

// ── Config & Indicators ──

async function refreshConfig() {
  try {
    const r = await api("/config");
    if (r.ok) {
      cachedConfig = await r.json();
      applyUserMode(cachedConfig.user_mode || "standard");
    }
  } catch (_) {}
  updateIndicators();
}

function updateIndicators() {
  if (!cachedConfig) return;
  const providerMode  = cachedConfig.model?.provider_mode || "local";
  const localBaseUrl  = cachedConfig.model?.base_url || "";
  const cloudBaseUrl  = cachedConfig.model?.cloud_base_url || "";
  const modelName     = providerMode === "cloud"
    ? cachedConfig.model?.cloud_model || ""
    : cachedConfig.model?.model || "";
  const activeBaseUrl = providerMode === "cloud" ? cloudBaseUrl : localBaseUrl;
  modelIndicator.textContent =
    modelName || activeBaseUrl.replace(/https?:\/\//, "").split("/")[0] || "--";

  const isLocal = providerMode !== "cloud" && (
    localBaseUrl.includes("localhost") || localBaseUrl.includes("127.0.0.1")
  );
  const isAuto  = providerMode === "auto";
  privacyIndicator.textContent = isLocal ? "Local" : isAuto ? "Hybrid" : "Cloud";
  privacyIndicator.className   = "indicator " + (isLocal ? "privacy-local" : isAuto ? "privacy-hybrid" : "privacy-cloud");
}

// ── User mode ──

function applyUserMode(mode) {
  const isStandard = mode === "standard";

  // Hide entire settings groups in standard mode
  ["sg-mode-toggle", "sg-provider-routing", "sg-local-provider", "sg-detected-servers"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.toggle("mode-hidden", isStandard);
  });

  // In standard mode, hide specific Security sub-groups but keep the tab visible
  ["sec-keychain-toggle", "sec-domains", "sec-connectors"].forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      const grp = el.closest(".settings-group");
      if (grp) grp.classList.toggle("mode-hidden", isStandard);
    }
  });

  // Update the mode badge in the topbar
  const badge = document.getElementById("mode-badge");
  if (badge) {
    badge.textContent = mode === "developer" ? "Developer" : "Standard";
    badge.className = "indicator " + (mode === "developer" ? "mode-badge-developer" : "mode-badge-standard");
    badge.title = "Click to switch mode";
  }
}

// ── Approvals (inline in message stream) ──

async function refreshApprovals() {
  let data;
  try {
    const r = await api("/approvals/pending");
    data = await readJsonOrThrow(r);
  } catch (_) { return; }

  // Remove any existing inline approval cards
  messagesEl.querySelectorAll(".msg-approval-wrap").forEach((el) => el.remove());

  const pending = data.pending || [];
  for (const a of pending) {
    // Auto-approve tools the user has already approved for this session
    if (sessionAllowedTools.has(a.tool_name)) {
      try {
        await api(`/approvals/${a.id}/resolve`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ decision: "allow" }),
        });
        if (currentSessionId) {
          const r2 = await api("/chat/continue", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ session_id: currentSessionId, approval_id: a.id }),
          });
          const d2 = await readJsonOrThrow(r2);
          addMsg("assistant", d2.reply);
        }
      } catch (_) {}
      continue;
    }

    addTimelineEvent("approval", `${a.tool_name}: approval requested`);

    let detail = a.summary || "";
    if (a.tool_arguments) {
      const args = a.tool_arguments;
      if (a.tool_name === "exec.run") {
        detail = `Command: ${args.command || "?"}`;
        if (args.cwd) detail += `\nDirectory: ${args.cwd}`;
      } else if (a.tool_name === "email.send") {
        detail = `To: ${args.to || "?"}\nSubject: ${args.subject || "?"}\nBody: ${(args.body || "").slice(0, 200)}`;
      } else {
        detail = JSON.stringify(args, null, 2);
      }
    }

    const wrap = document.createElement("div");
    wrap.className = "msg-approval-wrap";

    const card = document.createElement("div");
    card.className = "approval-card";
    card.innerHTML = `
      <div class="approval-header">
        <strong>${escapeHtml(a.tool_name)}</strong>
        <span class="badge">Requires approval</span>
      </div>
      <div class="approval-detail">${escapeHtml(detail)}</div>
      <div class="approval-actions">
        <button class="btn primary btn-sm"   data-id="${a.id}" data-decision="allow"         >Approve once</button>
        <button class="btn secondary btn-sm" data-id="${a.id}" data-decision="allow-session" data-tool="${escapeHtml(a.tool_name)}">Allow for session</button>
        <button class="btn danger btn-sm"    data-id="${a.id}" data-decision="deny"          >Deny</button>
      </div>`;

    card.querySelectorAll("button[data-id]").forEach((btn) => {
      btn.onclick = async () => {
        const id       = btn.getAttribute("data-id");
        const decision = btn.getAttribute("data-decision");

        if (decision === "allow-session") {
          sessionAllowedTools.add(btn.getAttribute("data-tool"));
        }

        const resolveDecision = decision === "allow-session" ? "allow" : decision;
        try {
          await api(`/approvals/${id}/resolve`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ decision: resolveDecision }),
          });
          addTimelineEvent("approval_resolved", `${resolveDecision}: ${id.slice(0, 8)}`);
          await refreshApprovals();
          if (currentSessionId && resolveDecision === "allow") {
            const r2 = await api("/chat/continue", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ session_id: currentSessionId, approval_id: id }),
            });
            const d2 = await readJsonOrThrow(r2);
            addMsg("assistant", d2.reply);
          }
        } catch (err) {
          showToast(err.message);
        }
      };
    });

    wrap.appendChild(card);
    messagesEl.appendChild(wrap);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }
}

// ── Session history (localStorage) ──

const SESSION_STORAGE_KEY = "rovot_sessions";
const MAX_STORED_SESSIONS = 20;

function getSessions() {
  try { return JSON.parse(localStorage.getItem(SESSION_STORAGE_KEY) || "[]"); }
  catch (_) { return []; }
}

function saveSession(sessionId, firstMsg) {
  if (!sessionId || !firstMsg) return;
  const sessions = getSessions().filter((s) => s.id !== sessionId);
  sessions.unshift({ id: sessionId, title: firstMsg.slice(0, 70), ts: Date.now() });
  if (sessions.length > MAX_STORED_SESSIONS) sessions.splice(MAX_STORED_SESSIONS);
  localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(sessions));
}

function renderSessionHistory() {
  const list = document.getElementById("session-history-list");
  if (!list) return;
  const sessions = getSessions();
  if (sessions.length === 0) {
    list.innerHTML = '<div class="session-dropdown-empty">No saved sessions yet.</div>';
    return;
  }
  list.innerHTML = sessions.map((s) => `
    <div class="session-item" data-session-id="${escapeHtml(s.id)}">
      <div class="session-item-title">${escapeHtml(s.title)}</div>
      <div class="session-item-meta">${new Date(s.ts).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</div>
    </div>`).join("");

  list.querySelectorAll(".session-item").forEach((item) => {
    item.addEventListener("click", () => {
      const sid = item.getAttribute("data-session-id");
      restoreSession(sid, item.querySelector(".session-item-title")?.textContent || "");
      list.classList.add("hidden"); // hide dropdown immediately; restoreSession is async
    });
  });
}

async function restoreSession(sessionId, title) {
  currentSessionId = sessionId;
  messagesEl.innerHTML = "";
  const emptyState = document.getElementById("chat-empty-state");
  if (emptyState) { emptyState.classList.add("hidden"); }
  try {
    const r = await api(`/sessions/${sessionId}/messages`);
    if (r.ok) {
      const data = await r.json();
      const msgs = data.messages || [];
      if (msgs.length === 0) {
        addMsg("assistant", `Session restored: "${title}"\n\nNo messages found.`);
      } else {
        for (const m of msgs) {
          addMsg(m.role === "user" ? "user" : "assistant", m.content);
        }
      }
    } else {
      addMsg("assistant", `Continuing session: "${title}"`);
    }
  } catch (_) {
    addMsg("assistant", `Continuing session: "${title}"`);
  }
}

document.getElementById("session-history-btn").addEventListener("click", (e) => {
  e.stopPropagation();
  const list = document.getElementById("session-history-list");
  renderSessionHistory();
  list.classList.toggle("hidden");
});

// Close dropdown when clicking outside
document.addEventListener("click", () => {
  document.getElementById("session-history-list")?.classList.add("hidden");
});

// ── Tool steps section (non-streaming) ──

function getToolStepLabel(name, args) {
  if (name === "browser.navigate" && args.url) {
    try { return new URL(args.url).hostname; } catch (_) { return String(args.url).slice(0, 40); }
  }
  if (name === "browser.search" && args.query) {
    return `"${String(args.query).slice(0, 35)}"`;
  }
  if (name === "macos.applescript" && args.script) {
    return String(args.script).slice(0, 35) + "…";
  }
  if (name === "macos.screenshot") return args.region || "full screen";
  if (name === "exec.run" && args.command) return String(args.command).slice(0, 40);
  if (name === "fs.read" && args.path) return args.path;
  if (name === "fs.write" && args.path) return args.path;
  if (name === "fs.list_dir") return args.path || ".";
  if (name === "email.send" && args.to) return `to: ${args.to}`;
  const key = Object.values(args)[0] || "";
  return String(key).slice(0, 40);
}

function renderToolSteps(toolCalls) {
  if (!toolCalls || toolCalls.length === 0) return null;
  const section = document.createElement("div");
  section.className = "tool-steps";

  const isExpanded = toolCalls.length > 3;
  const header = document.createElement("div");
  header.className = "tool-steps-header";
  header.innerHTML = `<span>⚙ Steps taken (${toolCalls.length})</span>
    <button class="tool-steps-toggle">${isExpanded ? "collapse" : "expand"}</button>`;

  const body = document.createElement("div");
  body.className = "tool-steps-body" + (isExpanded ? "" : " hidden");

  toolCalls.forEach((tc, i) => {
    const name = tc.name || tc.tool_name || "tool";
    const args = tc.arguments || tc.args || {};
    const keyStr = getToolStepLabel(name, args);
    const step = document.createElement("div");
    step.className = "tool-step";
    step.innerHTML = `<span class="tool-step-status">✓</span>
      <span class="tool-step-name">${escapeHtml(name)}</span>
      ${keyStr ? `<span class="tool-step-arg">${escapeHtml(keyStr)}</span>` : ""}`;

    const argDetails = document.createElement("pre");
    argDetails.className = "tool-step-args hidden";
    argDetails.textContent = JSON.stringify(args, null, 2);
    step.appendChild(argDetails);
    step.addEventListener("click", () => argDetails.classList.toggle("hidden"));
    body.appendChild(step);
  });

  header.querySelector(".tool-steps-toggle").addEventListener("click", (e) => {
    e.stopPropagation();
    const hidden = body.classList.toggle("hidden");
    e.target.textContent = hidden ? "expand" : "collapse";
  });

  section.appendChild(header);
  section.appendChild(body);
  return section;
}

// ── Image attachments ──

const attachedImages = [];  // {base64: string, mediaType: string}

function addImagePreview(base64, mediaType, previewDataUrl) {
  attachedImages.push({ base64, mediaType });
  const strip = document.getElementById("image-previews");
  const wrap = document.createElement("div");
  wrap.className = "image-preview-thumb";
  const idx = attachedImages.length - 1;
  wrap.innerHTML = `<img src="${previewDataUrl}" alt="attached image" /><button class="image-remove-btn" data-idx="${idx}" title="Remove">&#x2715;</button>`;
  wrap.querySelector(".image-remove-btn").addEventListener("click", (e) => {
    const i = parseInt(e.currentTarget.dataset.idx);
    attachedImages.splice(i, 1);
    wrap.remove();
    // Re-index remaining buttons
    strip.querySelectorAll(".image-remove-btn").forEach((btn, j) => { btn.dataset.idx = j; });
  });
  strip.appendChild(wrap);
}

function clearImagePreviews() {
  attachedImages.length = 0;
  document.getElementById("image-previews").innerHTML = "";
}

document.getElementById("attach-image").addEventListener("click", () => {
  document.getElementById("image-file-input").click();
});

document.getElementById("image-file-input").addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (evt) => {
    const dataUrl = evt.target.result;
    const base64 = dataUrl.split(",")[1];
    addImagePreview(base64, file.type || "image/png", dataUrl);
  };
  reader.readAsDataURL(file);
  e.target.value = "";
});

document.addEventListener("paste", (e) => {
  const items = e.clipboardData?.items;
  if (!items) return;
  for (const item of items) {
    if (item.type.startsWith("image/")) {
      const file = item.getAsFile();
      if (!file) continue;
      const reader = new FileReader();
      reader.onload = (evt) => {
        const dataUrl = evt.target.result;
        const base64 = dataUrl.split(",")[1];
        addImagePreview(base64, item.type, dataUrl);
      };
      reader.readAsDataURL(file);
    }
  }
});

// ── Chat ──

async function sendMessage() {
  const msg = inputEl.value.trim();
  if (!msg || isSending) return;

  const imagesToSend = attachedImages.map((img) => ({
    base64_data: img.base64,
    media_type: img.mediaType,
  }));

  inputEl.value = "";
  resetInputHeight();
  clearImagePreviews();
  addMsg("user", msg);
  addTimelineEvent("chat", "Message sent");
  setSendingState(true);
  showTypingIndicator();

  streamAbortController = new AbortController();

  try {
    const response = await fetch(baseUrl + "/chat/stream", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${getToken()}`,
      },
      body: JSON.stringify({ message: msg, session_id: currentSessionId, images: imagesToSend }),
      signal: streamAbortController.signal,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Request failed (${response.status}): ${text}`);
    }

    // Create streaming assistant bubble
    removeTypingIndicator();
    const emptyState = document.getElementById("chat-empty-state");
    if (emptyState) emptyState.classList.add("hidden");

    const wrapper = document.createElement("div");
    wrapper.className = "msg-wrapper assistant";
    const bubble = document.createElement("div");
    bubble.className = "msg assistant streaming";
    wrapper.appendChild(bubble);

    // Tool steps container (built incrementally during stream)
    const stepsContainer = document.createElement("div");
    stepsContainer.className = "tool-steps";
    stepsContainer.style.display = "none";
    const stepsHeader = document.createElement("div");
    stepsHeader.className = "tool-steps-header";
    stepsHeader.innerHTML = `<span>⚙ Steps taken (<span class="steps-count">0</span>)</span>
      <button class="tool-steps-toggle">expand</button>`;
    const stepsBody = document.createElement("div");
    stepsBody.className = "tool-steps-body hidden";
    stepsContainer.appendChild(stepsHeader);
    stepsContainer.appendChild(stepsBody);
    stepsHeader.querySelector(".tool-steps-toggle").addEventListener("click", (e) => {
      e.stopPropagation();
      const hidden = stepsBody.classList.toggle("hidden");
      e.target.textContent = hidden ? "expand" : "collapse";
    });

    // Meta row
    const meta = document.createElement("div");
    meta.className = "msg-meta";
    const ts = document.createElement("span");
    ts.className = "msg-timestamp";
    ts.textContent = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    meta.appendChild(ts);

    // Insert stepsContainer before bubble, then bubble, then meta
    messagesEl.insertBefore(stepsContainer, null);
    messagesEl.appendChild(stepsContainer);
    messagesEl.appendChild(wrapper);
    wrapper.appendChild(meta);
    messagesEl.scrollTop = messagesEl.scrollHeight;

    let fullText = "";
    let stepCount = 0;
    let pendingSessionId = currentSessionId;

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    let lastTokenTs = Date.now();
    const TOKEN_TIMEOUT_MS = 30000;
    const stallInterval = setInterval(() => {
      if (Date.now() - lastTokenTs > TOKEN_TIMEOUT_MS && isSending) {
        clearInterval(stallInterval);
        removeTypingIndicator();
        bubble.classList.remove("streaming");
        const notice = document.createElement("div");
        notice.className = "stream-stall-notice";
        notice.innerHTML = `<span style="color:var(--warning)">⚠ Model stopped responding.</span>
          <button class="btn secondary btn-sm" onclick="sendMessage()">Retry</button>`;
        wrapper.appendChild(notice);
        setSendingState(false);
      }
    }, 5000);

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const raw = line.slice(6).trim();
        if (!raw) continue;

        let event;
        try { event = JSON.parse(raw); } catch (_) { continue; }

        switch (event.type) {
          case "token":
            fullText += event.content;
            bubble.innerHTML = renderMarkdown(fullText);
            messagesEl.scrollTop = messagesEl.scrollHeight;
            lastTokenTs = Date.now();
            break;

          case "tool_call": {
            const name = event.name || "tool";
            const args = event.args || {};
            const keyStr = getToolStepLabel(name, args);
            stepCount++;
            stepsContainer.style.display = "";
            stepsContainer.querySelector(".steps-count").textContent = stepCount;

            const step = document.createElement("div");
            step.className = "tool-step tool-step-running";
            step.innerHTML = `<span class="tool-step-status">
                <span class="tool-spinner"></span>
              </span>
              <span class="tool-step-name">${escapeHtml(name)}</span>
              ${keyStr ? `<span class="tool-step-arg">${escapeHtml(keyStr)}</span>` : ""}`;
            step.dataset.tool = name;
            step.dataset.stepIndex = String(stepCount - 1);
            stepsBody.appendChild(step);

            addTimelineEvent("tool_call", `${name}(${JSON.stringify(args).slice(0, 80)})`);
            break;
          }

          case "tool_result": {
            const name = event.name || "tool";
            // Find the running step by index (preferred) or fall back to name match
            const idx = event.step_index ?? -1;
            const runningSteps = Array.from(stepsBody.querySelectorAll('.tool-step-running'));
            const runningStep = idx >= 0
              ? runningSteps.find(el => el.dataset.stepIndex === String(idx))
              : runningSteps.find(el => el.dataset.tool === name);
            if (runningStep) {
              runningStep.classList.remove("tool-step-running");
              runningStep.querySelector(".tool-step-status").innerHTML = "✓";
              const summary = event.summary || "done";
              const argDetails = document.createElement("pre");
              argDetails.className = "tool-step-args hidden";
              argDetails.textContent = summary;
              runningStep.appendChild(argDetails);
              runningStep.style.cursor = "pointer";
              runningStep.addEventListener("click", () => argDetails.classList.toggle("hidden"));
            }
            break;
          }

          case "approval_required":
            await refreshApprovals();
            break;

          case "done":
            if (event.session_id) {
              currentSessionId = event.session_id;
              pendingSessionId = event.session_id;
            }
            if (event.pending_approval_id) {
              await refreshApprovals();
            }
            break;

          case "error":
            showToast(event.message || "Streaming error");
            addTimelineEvent("error", event.message || "Streaming error");
            break;
        }
      }
    }

    clearInterval(stallInterval);

    // Finalize bubble
    bubble.classList.remove("streaming");
    if (fullText) {
      bubble.innerHTML = renderMarkdown(fullText);
    }

    // Add copy button to meta
    const copyBtn = document.createElement("button");
    copyBtn.className = "btn-copy";
    copyBtn.title = "Copy to clipboard";
    copyBtn.innerHTML =
      '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
      '<rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>' +
      '<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> Copy';
    copyBtn.addEventListener("click", () => {
      navigator.clipboard.writeText(fullText).catch(() => {});
    });
    meta.appendChild(copyBtn);

    if (pendingSessionId) saveSession(pendingSessionId, msg);
    addTimelineEvent("chat", "Reply received");

  } catch (err) {
    removeTypingIndicator();
    if (err.name !== "AbortError") {
      // Fall back to non-streaming on error
      try {
        const r = await api("/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: msg, session_id: currentSessionId }),
        });
        const data = await readJsonOrThrow(r);
        currentSessionId = data.session_id;

        // Render tool steps before reply
        const wrapper = document.createElement("div");
        wrapper.className = "msg-wrapper assistant";
        if (data.tool_calls && data.tool_calls.length > 0) {
          const stepsEl = renderToolSteps(data.tool_calls);
          if (stepsEl) wrapper.insertBefore(stepsEl, wrapper.firstChild);
        }
        const bubble2 = document.createElement("div");
        bubble2.className = "msg assistant";
        bubble2.innerHTML = renderMarkdown(data.reply);
        wrapper.appendChild(bubble2);
        const meta2 = document.createElement("div");
        meta2.className = "msg-meta";
        const ts2 = document.createElement("span");
        ts2.className = "msg-timestamp";
        ts2.textContent = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
        meta2.appendChild(ts2);
        wrapper.appendChild(meta2);
        messagesEl.appendChild(wrapper);
        messagesEl.scrollTop = messagesEl.scrollHeight;

        saveSession(data.session_id, msg);
        addTimelineEvent("chat", "Reply received (non-streaming)");
        if (data.tool_calls) {
          data.tool_calls.forEach((tc) => {
            addTimelineEvent("tool_call",
              `${tc.name || "tool"}(${JSON.stringify(tc.arguments || {}).slice(0, 80)})`
            );
          });
        }
        await refreshApprovals();
      } catch (fallbackErr) {
        showToast(fallbackErr.message);
        addTimelineEvent("error", fallbackErr.message);
      }
    }
  } finally {
    setSendingState(false);
  }
}

sendBtn.onclick = sendMessage;

inputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

// ── Prompt chips (empty state) ──

document.querySelectorAll(".prompt-chip").forEach((chip) => {
  chip.addEventListener("click", () => {
    inputEl.value = chip.textContent.trim();
    inputEl.focus();
    resetInputHeight();
    // trigger resize
    inputEl.dispatchEvent(new Event("input"));
  });
});

// ── New Chat ──

document.getElementById("new-chat").addEventListener("click", () => {
  currentSessionId = null;
  messagesEl.innerHTML = "";
  // Restore empty state
  const emptyState = document.getElementById("chat-empty-state");
  if (emptyState) {
    emptyState.classList.remove("hidden");
    messagesEl.appendChild(emptyState);
  }
  addTimelineEvent("chat", "New conversation started");
});

// ── Auto-resize textarea ──

function resetInputHeight() {
  inputEl.style.height = "";
}

inputEl.addEventListener("input", () => {
  inputEl.style.height = "auto";
  inputEl.style.height = Math.min(inputEl.scrollHeight, 160) + "px";
});

// ── WebSocket ──

function connectWs() {
  if (wsRetryCount >= WS_MAX_RETRIES) {
    statusEl.textContent = "ws off";
    statusEl.title = "Real-time updates unavailable after repeated failures";
    addTimelineEvent("error", "Realtime updates unavailable (/ws not reachable).");
    return;
  }
  ws = new WebSocket(`ws://127.0.0.1:18789/ws?token=${encodeURIComponent(getToken())}`);
  ws.onopen = () => { wsRetryCount = 0; statusEl.textContent = "connected"; };
  ws.onerror = () => { wsRetryCount += 1; };
  ws.onclose = () => {
    statusEl.textContent = "disconnected";
    setTimeout(connectWs, Math.min(3000 * (wsRetryCount + 1), 15000));
  };
  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.event === "chat.reply")         { refreshApprovals(); addTimelineEvent("chat", "Server pushed reply"); }
      if (msg.event === "approval.resolved")  { refreshApprovals(); addTimelineEvent("approval_resolved", "Approval resolved via WS"); }
      if (msg.event === "tool.call")          { addTimelineEvent("tool_call", msg.payload?.tool || "tool invoked"); }
      if (msg.event === "tool.result")        { addTimelineEvent("tool_call", `Result: ${(msg.payload?.summary || "done").slice(0, 80)}`); }

      // Model download progress
      if (msg.event === "model_download_progress") {
        const { filename, progress } = msg.payload || {};
        const pct = Math.round((progress || 0) * 100);

        // Onboarding wizard progress bar
        if (filename === _onboardDownloadingFilename) {
          const fill  = document.querySelector("#step5-progress-bar .progress-fill");
          const label = document.querySelector("#step5-progress-bar .progress-label");
          if (fill)  fill.style.width  = pct + "%";
          if (label) label.textContent = pct + "%";
        }

        const progressBox = document.getElementById(`progress-${CSS.escape(filename || "")}`);
        if (progressBox) {
          progressBox.classList.remove("hidden");
          const fill  = progressBox.querySelector(".progress-fill");
          const label = progressBox.querySelector(".progress-label");
          if (fill)  fill.style.width  = pct + "%";
          if (label) label.textContent = pct + "%";
        }
      }
      if (msg.event === "model_download_complete") {
        const { filename } = msg.payload || {};

        if (filename === _onboardDownloadingFilename) {
          const statusLabel = document.getElementById("step5-status-label");
          if (statusLabel) statusLabel.textContent = "Download complete. Loading model…";
          const fill = document.querySelector("#step5-progress-bar .progress-fill");
          if (fill) fill.style.width = "100%";
          // Auto-load the model
          api("/models/internal/load", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ model_filename: filename }),
          }).catch(() => {
            if (statusLabel) statusLabel.textContent = "Download complete. Load the model in Settings → Models.";
            const finishBtn = document.getElementById("onboard-finish");
            if (finishBtn) finishBtn.disabled = false;
            _onboardDownloadingFilename = null;
          });
          return;
        }

        showToast(`Downloaded ${filename || "model"} successfully.`, "success", 4000);
        loadBuiltinSection();
      }
      if (msg.event === "model_download_error") {
        const { filename, error } = msg.payload || {};

        if (filename === _onboardDownloadingFilename) {
          const statusLabel = document.getElementById("step5-status-label");
          if (statusLabel) statusLabel.textContent = `Download failed: ${error || "unknown error"}. You can retry in Settings → Models.`;
          const finishBtn = document.getElementById("onboard-finish");
          if (finishBtn) finishBtn.disabled = false;
          _onboardDownloadingFilename = null;
          return;
        }

        showToast(`Download failed for ${filename || "model"}: ${error || "unknown error"}`, "error", 6000);
        loadBuiltinSection();
      }
      if (msg.event === "model_load_complete") {
        const { filename } = msg.payload || {};

        if (filename === _onboardDownloadingFilename) {
          const statusLabel = document.getElementById("step5-status-label");
          if (statusLabel) statusLabel.textContent = "Ready!";
          const finishBtn = document.getElementById("onboard-finish");
          if (finishBtn) finishBtn.disabled = false;
          _onboardDownloadingFilename = null;
          return;
        }

        showToast(`Model loaded: ${filename || ""}`, "success", 3000);
        loadBuiltinSection();
        refreshConfig();
      }
      if (msg.event === "model_load_error") {
        const { filename, error, error_type, install_cmd } = msg.payload || {};
        if (error_type === "llama_cpp_not_installed") {
          const cmd = install_cmd || "pip install llama-cpp-python";
          showToast(`llama-cpp-python is not installed. Install with: ${cmd}`, "error", 12000);
          document.title = "Rovot — install llama-cpp-python";
          setTimeout(() => { document.title = "Rovot"; }, 10000);
          checkLlamaCppStatus();
        } else {
          showToast(`Failed to load ${filename || "model"}: ${error || "unknown error"}`, "error", 6000);
        }
        loadBuiltinSection();
      }
    } catch (_) {}
  };
}

// ── Voice ──

let recorder = null;
let chunks   = [];
recBtn.onclick = async () => {
  if (recorder && recorder.state === "recording") {
    recorder.stop();
    recBtn.classList.remove("recording");
    return;
  }
  chunks = [];
  try {
    const stream   = await navigator.mediaDevices.getUserMedia({ audio: true });
    recorder       = new MediaRecorder(stream);
    recorder.ondataavailable = (e) => chunks.push(e.data);
    recorder.onstop = async () => {
      const blob = new Blob(chunks, { type: "audio/webm" });
      const fd   = new FormData();
      fd.append("audio", blob, "audio.webm");
      try {
        const r = await fetch(baseUrl + "/voice/transcribe", {
          method: "POST",
          headers: { Authorization: `Bearer ${getToken()}` },
          body: fd,
        });
        if (r.ok) {
          const d = await r.json();
          if (d.text) { inputEl.value = d.text; inputEl.dispatchEvent(new Event("input")); }
        }
      } catch (_) {}
    };
    recorder.start();
    recBtn.classList.add("recording");
  } catch (_) {}
};

// ── Built-in Models ──

const _downloadProgress = {}; // filename -> progress element

// Cache for the static catalog (avoids repeated fetches in onboarding)
let _catalogCache = null;

async function getCatalogEntry(filename) {
  if (!_catalogCache) {
    try {
      const r = await api("/models/internal/catalog");
      _catalogCache = await r.json();
    } catch (_) { return null; }
  }
  return (_catalogCache || []).find(e => e.filename === filename) || null;
}

async function getRecommendedModel() {
  try {
    const r = await api("/models/internal/recommend");
    if (r.ok) return await r.json();
  } catch (_) {}
  return null;
}

function _updateBuiltinModeToggle(mode) {
  document.getElementById("mode-builtin").classList.toggle("active", mode === "internal");
  document.getElementById("mode-external").classList.toggle("active", mode !== "internal");
  document.getElementById("builtin-models-section").classList.toggle("hidden", mode !== "internal");
}

// ── llama-cpp-python install guide ──────────────────────────────────────────
// Call this once when entering Built-in Models mode.
async function checkLlamaCppStatus() {
  const section = document.getElementById("builtin-models-section");
  const existing = document.getElementById("llama-cpp-banner");
  if (existing) existing.remove();

  try {
    const r = await api("/models/internal/status");
    const data = await r.json();
    if (data.installed) return; // All good, no banner needed

    const banner = document.createElement("div");
    banner.id = "llama-cpp-banner";
    banner.className = "llama-cpp-banner";
    const isAppleSilicon = data.is_apple_silicon;
    const cmd = data.install_cmd || "pip install llama-cpp-python";

    // Check if running packaged (no Python path visible to user)
    const isPackaged = (await window.rovot?.isPackaged?.()) ?? false;

    if (isPackaged) {
      // Packaged build — different message, no pip command
      banner.innerHTML = `
        <div class="llama-cpp-banner-icon">⚠</div>
        <div class="llama-cpp-banner-body">
          <strong>Built-in model engine unavailable</strong>
          <p>The inference engine could not be loaded. Please reinstall Rovot or use an external model provider (LM Studio, Ollama) instead.</p>
        </div>`;
    } else {
      // Dev build — show install command
      banner.innerHTML = `
        <div class="llama-cpp-banner-icon">⚠</div>
        <div class="llama-cpp-banner-body">
          <strong>llama-cpp-python not installed</strong>
          <p>Built-in inference requires llama-cpp-python.
          ${isAppleSilicon ? "You're on Apple Silicon — use the Metal build:" : "Install with pip:"}</p>
          <div class="llama-cpp-cmd-wrap">
            <code id="llama-install-cmd">${escapeHtml(cmd)}</code>
            <button class="btn secondary btn-sm" onclick="copyInstallCmd()">Copy</button>
          </div>
          ${isAppleSilicon ? `<p class="settings-desc" style="margin-top:6px">The Metal build offloads model layers to the Apple GPU.</p>` : ""}
        </div>`;
    }

    section.insertBefore(banner, section.firstChild);

    // Disable all Load buttons while llama-cpp-python is missing
    document.querySelectorAll('#builtin-available-list button').forEach(btn => {
      btn.disabled = true;
      btn.title = "Install llama-cpp-python first";
    });
    document.querySelectorAll('.catalog-load-btn').forEach(btn => {
      btn.disabled = true;
      btn.title = "Install llama-cpp-python first";
    });
  } catch (_) {}
}

function copyInstallCmd() {
  const cmd = document.getElementById("llama-install-cmd")?.textContent || "";
  navigator.clipboard.writeText(cmd).then(() => showToast("Copied install command.", "success", 2000));
}

window.copyInstallCmd = copyInstallCmd;

// ── Catalog tabs: Static / Scan / Search ────────────────────────────────────
let _catalogTab = "static";

function setupCatalogTabs() {
  const container = document.getElementById("catalog-tab-container");
  if (!container || container.dataset.initialized) return;
  container.dataset.initialized = "true";

  container.querySelectorAll(".catalog-tab-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      container.querySelectorAll(".catalog-tab-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      _catalogTab = btn.dataset.tab;
      if (_catalogTab === "static") loadStaticCatalog();
      if (_catalogTab === "scan") loadScanCatalog();
      if (_catalogTab === "search") focusCatalogSearch();
    });
  });
}

async function loadStaticCatalog() {
  const el = document.getElementById("builtin-catalog-list");
  el.innerHTML = '<div class="info-box">Loading catalog…</div>';
  try {
    const r = await api("/models/internal/catalog");
    const catalog = await r.json();
    renderCatalogCards(catalog, el);
  } catch (_) {
    el.innerHTML = '<div class="info-box">Could not load catalog.</div>';
  }
}

async function loadScanCatalog() {
  const el = document.getElementById("builtin-catalog-list");
  el.innerHTML = '<div class="info-box"><span class="status-spinner" style="display:inline-block;width:14px;height:14px;margin-right:8px;vertical-align:middle"></span>Scanning HuggingFace for latest models…</div>';
  try {
    const r = await api("/models/internal/catalog/scan");
    const data = await r.json();
    if (!data.models || data.models.length === 0) {
      el.innerHTML = '<div class="info-box">No results returned from HuggingFace. Check your internet connection.</div>';
      return;
    }
    renderCatalogCards(data.models, el);
    const note = document.createElement("p");
    note.className = "settings-desc";
    note.style.marginTop = "10px";
    note.textContent = `Scanned ${data.scanned_repos} repos · found ${data.found} GGUF models`;
    el.appendChild(note);
  } catch (_) {
    el.innerHTML = '<div class="info-box">Scan failed. Check your internet connection.</div>';
  }
}

function focusCatalogSearch() {
  const el = document.getElementById("builtin-catalog-list");
  el.innerHTML = `
    <div class="catalog-search-bar">
      <input id="catalog-search-input" type="text" placeholder="Search HuggingFace for GGUF models…" style="flex:1;padding:8px 10px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg);color:var(--text);font-size:14px;outline:none;" />
      <button class="btn secondary" id="catalog-search-btn">Search</button>
    </div>
    <div id="catalog-search-results" style="margin-top:10px"></div>`;

  const input = document.getElementById("catalog-search-input");
  const btn = document.getElementById("catalog-search-btn");
  const resultsEl = document.getElementById("catalog-search-results");

  const doSearch = async () => {
    const q = input.value.trim();
    if (!q) return;
    resultsEl.innerHTML = '<div class="info-box"><span class="status-spinner" style="display:inline-block;width:14px;height:14px;margin-right:8px;vertical-align:middle"></span>Searching…</div>';
    try {
      const r = await api("/models/internal/catalog/search?q=" + encodeURIComponent(q));
      const data = await r.json();
      if (!data.models || data.models.length === 0) {
        resultsEl.innerHTML = '<div class="info-box">No GGUF models found for that query.</div>';
        return;
      }
      // Enrich with size placeholders for search results
      const enriched = data.models.map(m => ({
        ...m,
        name: m.name,
        size_gb: null,
        ram_required_gb: null,
        description: `${m.downloads?.toLocaleString() || "?"} downloads · ${m.likes || 0} likes`,
        hf_url: m.hf_url,
        filename: m.filename,
      }));
      renderCatalogCards(enriched, resultsEl);
    } catch (_) {
      resultsEl.innerHTML = '<div class="info-box">Search failed. Try again.</div>';
    }
  };

  btn.addEventListener("click", doSearch);
  input.addEventListener("keydown", e => { if (e.key === "Enter") doSearch(); });
  input.focus();
}

function renderCatalogCards(items, container) {
  // Get locally downloaded filenames for cross-checking
  const downloaded = new Set();
  api("/models/internal/available").then(r => r.json()).then(d => {
    (d.models || []).forEach(f => downloaded.add(f));
    container.innerHTML = "";
    items.forEach(item => {
      const isDownloaded = item.downloaded || downloaded.has(item.filename);
      const card = document.createElement("div");
      card.className = "catalog-card";

      const metaParts = [];
      if (item.size_gb) metaParts.push(`${item.size_gb} GB`);
      if (item.ram_required_gb) metaParts.push(`${item.ram_required_gb} GB RAM`);
      const metaStr = metaParts.join(" · ");

      card.innerHTML = `
        <div class="catalog-info">
          <strong>${escapeHtml(item.name)}</strong>
          ${isDownloaded ? '<span class="badge badge-green">Downloaded</span>' : ""}
          ${metaStr ? `<span class="catalog-meta">${escapeHtml(metaStr)}</span>` : ""}
          <span class="catalog-desc">${escapeHtml(item.description || "")}</span>
        </div>
        <div class="catalog-action">
          ${isDownloaded
            ? `<button class="btn primary btn-sm catalog-load-btn" data-filename="${escapeHtml(item.filename)}">Load</button>`
            : `<button class="btn secondary btn-sm catalog-dl-btn" data-filename="${escapeHtml(item.filename)}" data-url="${escapeHtml(item.hf_url)}">Download</button>`}
          <div class="catalog-progress hidden" id="progress-${escapeHtml(item.filename)}">
            <div class="progress-bar"><div class="progress-fill" style="width:0%"></div></div>
            <span class="progress-label">0%</span>
          </div>
        </div>`;

      const dlBtn = card.querySelector(".catalog-dl-btn");
      if (dlBtn) {
        dlBtn.addEventListener("click", async () => {
          dlBtn.disabled = true;
          dlBtn.textContent = "Downloading…";
          const progressBox = card.querySelector(`#progress-${CSS.escape(item.filename)}`);
          if (progressBox) progressBox.classList.remove("hidden");
          await api("/models/internal/download", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ filename: item.filename, hf_url: item.hf_url }),
          });
        });
      }

      const loadBtn = card.querySelector(".catalog-load-btn");
      if (loadBtn) {
        loadBtn.addEventListener("click", () => _loadModel(item.filename, loadBtn));
      }

      container.appendChild(card);
    });
  }).catch(() => {
    // If available check fails, just render without cross-check
    container.innerHTML = "";
    items.forEach(item => {
      const isDownloaded = item.downloaded;
      const card = document.createElement("div");
      card.className = "catalog-card";
      card.innerHTML = `<div class="catalog-info"><strong>${escapeHtml(item.name)}</strong></div>
        <div class="catalog-action">
          ${isDownloaded
            ? `<button class="btn primary btn-sm catalog-load-btn" data-filename="${escapeHtml(item.filename)}">Load</button>`
            : `<button class="btn secondary btn-sm">Download</button>`}
        </div>`;
      container.appendChild(card);
    });
  });
}

async function _loadModel(filename, btn) {
  if (btn) { btn.disabled = true; btn.textContent = "Loading…"; }
  const r = await api("/models/internal/load", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model_filename: filename }),
  });
  if (!r.ok) {
    const data = await r.json().catch(() => ({}));
    const detail = typeof data.detail === "object" ? data.detail : { message: data.detail };
    if (detail.error_type === "llama_cpp_not_installed" || detail.install_cmd) {
      const cmd = detail.install_cmd || "pip install llama-cpp-python";
      showToast(`llama-cpp-python is not installed. Install with: ${cmd}`, "error", 12000);
      await checkLlamaCppStatus();
    } else {
      const msg = detail.message || detail.error || (typeof data.detail === "string" ? data.detail : null) || "Failed to start model load.";
      showToast(msg, "error");
    }
    if (btn) { btn.disabled = false; btn.textContent = "Load"; }
    return;
  }
  document.getElementById("builtin-loaded-status").innerHTML =
    '<span class="status-spinner" style="display:inline-block;width:14px;height:14px;margin-right:6px"></span>Loading model…';
  await api("/config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: "model.provider_mode", value: "internal" }),
  });
  await refreshConfig();
}

// ── Revised loadBuiltinSection ───────────────────────────────────────────────
async function loadBuiltinSection() {
  await checkLlamaCppStatus();

  // Loaded model status
  const statusEl = document.getElementById("builtin-loaded-status");
  try {
    const r = await api("/models/internal/loaded");
    const data = await r.json();
    if (data.loading) {
      statusEl.innerHTML = '<span class="status-spinner" style="display:inline-block;width:14px;height:14px;margin-right:6px"></span>Loading model…';
    } else if (data.loaded) {
      statusEl.innerHTML = `<strong>${escapeHtml(data.loaded)}</strong> loaded &nbsp;
        <button class="btn danger btn-sm" id="unload-model-btn">Unload</button>`;
      document.getElementById("unload-model-btn").addEventListener("click", async () => {
        await api("/models/internal/unload", { method: "POST", headers: { "Content-Type": "application/json" } });
        await loadBuiltinSection();
        await refreshConfig();
      });
    } else {
      statusEl.textContent = "No model loaded";
    }
  } catch (_) {
    statusEl.textContent = "Built-in inference unavailable";
  }

  // Available (downloaded) models list
  const availEl = document.getElementById("builtin-available-list");
  availEl.innerHTML = "";
  try {
    const r2 = await api("/models/internal/available");
    const data2 = await r2.json();
    const models = data2.models || [];
    if (models.length === 0) {
      availEl.innerHTML = '<div class="info-box">No models downloaded yet. Use the catalog below.</div>';
    } else {
      models.forEach(filename => {
        const el = document.createElement("div");
        el.className = "probe-item found";
        el.innerHTML = `<span class="probe-label">${escapeHtml(filename)}</span>
          <button class="btn primary btn-sm" data-filename="${escapeHtml(filename)}">Load</button>`;
        el.querySelector("button").addEventListener("click", () =>
          _loadModel(filename, el.querySelector("button"))
        );
        availEl.appendChild(el);
      });
    }
  } catch (_) {}

  // Catalog section with tabs
  setupCatalogTabs();
  if (_catalogTab === "static") loadStaticCatalog();
}

document.getElementById("mode-builtin").addEventListener("click", async () => {
  await api("/config", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${getToken()}` },
    body: JSON.stringify({ path: "model.provider_mode", value: "internal" }),
  });
  _updateBuiltinModeToggle("internal");
  await loadBuiltinSection();
  await refreshConfig();
});

document.getElementById("mode-external").addEventListener("click", async () => {
  const mode = document.getElementById("provider-mode").value || "local";
  await api("/config", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${getToken()}` },
    body: JSON.stringify({ path: "model.provider_mode", value: mode }),
  });
  _updateBuiltinModeToggle(mode);
  await refreshConfig();
});

// ── Standard mode simplified models view ──

async function _loadStandardModelsView() {
  // Show/refresh llama-cpp banner in the standard view's banner slot
  const bannerWrap = document.getElementById("std-llama-banner-wrap");
  if (bannerWrap) {
    bannerWrap.innerHTML = "";
    try {
      const r = await api("/models/internal/status");
      const data = await r.json();
      if (!data.installed) {
        const cmd = data.install_cmd || "pip install llama-cpp-python";
        const banner = document.createElement("div");
        banner.className = "llama-cpp-banner";
        banner.innerHTML = `
          <div class="llama-cpp-banner-icon">⚠</div>
          <div class="llama-cpp-banner-body">
            <strong>llama-cpp-python not installed</strong>
            <p>${data.is_apple_silicon ? "Apple Silicon detected — use the Metal build:" : "Install with pip:"}</p>
            <div class="llama-cpp-cmd-wrap">
              <code id="llama-install-cmd">${escapeHtml(cmd)}</code>
              <button class="btn secondary btn-sm" onclick="copyInstallCmd()">Copy</button>
            </div>
          </div>`;
        bannerWrap.appendChild(banner);
      }
    } catch (_) {}
  }

  // Current model status
  const statusEl = document.getElementById("std-model-status");
  if (statusEl) {
    try {
      const r = await api("/models/internal/loaded");
      const data = await r.json();
      if (data.loading) {
        statusEl.innerHTML = '<span class="status-spinner" style="display:inline-block;width:14px;height:14px;margin-right:6px"></span>Loading model…';
      } else if (data.loaded) {
        statusEl.innerHTML = `<strong>${escapeHtml(data.loaded)}</strong> is loaded and ready.`;
      } else {
        statusEl.textContent = "No model loaded. Download a model to get started.";
      }
    } catch (_) {
      statusEl.textContent = "Could not check model status.";
    }
  }

  // "Change model" button toggles catalog section
  const changeBtn = document.getElementById("std-change-model-btn");
  if (changeBtn && !changeBtn.dataset.init) {
    changeBtn.dataset.init = "true";
    changeBtn.addEventListener("click", async () => {
      const catalogSection = document.getElementById("std-catalog-section");
      if (!catalogSection) return;
      catalogSection.classList.toggle("hidden");
      if (!catalogSection.classList.contains("hidden")) {
        await _loadStandardCatalog();
      }
    });
  }
}

async function _loadStandardCatalog() {
  const listEl = document.getElementById("std-catalog-list");
  if (!listEl || listEl.dataset.loaded) return;
  listEl.dataset.loaded = "true";
  listEl.innerHTML = '<div class="info-box">Loading…</div>';

  try {
    const [catalogRes, recRes] = await Promise.all([
      api("/models/internal/catalog"),
      api("/models/internal/recommend"),
    ]);
    const catalog = await catalogRes.json();
    const rec = recRes.ok ? await recRes.json() : null;

    listEl.innerHTML = "";
    catalog.forEach(item => {
      const isRec = rec && item.filename === rec.recommended_filename;
      const card = document.createElement("div");
      card.className = "catalog-card";
      const metaParts = [];
      if (item.size_gb) metaParts.push(`${item.size_gb} GB`);
      if (item.ram_required_gb) metaParts.push(`${item.ram_required_gb} GB RAM`);
      card.innerHTML = `
        <div class="catalog-info">
          <strong>${escapeHtml(item.name)}</strong>
          ${isRec ? '<span class="badge badge-green" style="margin-left:6px">Recommended for your device</span>' : ""}
          ${metaParts.length ? `<span class="catalog-meta" style="display:block;margin-top:4px">${escapeHtml(metaParts.join(" · "))}</span>` : ""}
          <span class="catalog-desc" style="display:block">${escapeHtml(item.description || "")}</span>
        </div>
        <div class="catalog-action">
          ${item.downloaded
            ? `<button class="btn primary btn-sm catalog-load-btn" data-filename="${escapeHtml(item.filename)}">Load</button>`
            : `<button class="btn secondary btn-sm catalog-dl-btn" data-filename="${escapeHtml(item.filename)}" data-url="${escapeHtml(item.hf_url)}">Download</button>`}
          <div class="catalog-progress hidden" id="progress-std-${escapeHtml(item.filename)}">
            <div class="progress-bar"><div class="progress-fill" style="width:0%"></div></div>
            <span class="progress-label">0%</span>
          </div>
        </div>`;

      const dlBtn = card.querySelector(".catalog-dl-btn");
      if (dlBtn) {
        dlBtn.addEventListener("click", async () => {
          dlBtn.disabled = true;
          dlBtn.textContent = "Downloading…";
          await api("/models/internal/download", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ filename: item.filename, hf_url: item.hf_url }),
          });
        });
      }
      const loadBtn = card.querySelector(".catalog-load-btn");
      if (loadBtn) {
        loadBtn.addEventListener("click", () => _loadModel(item.filename, loadBtn));
      }
      listEl.appendChild(card);
    });
  } catch (_) {
    listEl.innerHTML = '<div class="info-box">Could not load catalog.</div>';
  }
}

// ── Models view ──

async function loadModelsView() {
  await refreshConfig();

  const userMode = cachedConfig?.user_mode || "standard";
  const fullView = document.querySelector("#settings-panel-models .view-inner:not(#standard-models-view)");
  const stdView = document.getElementById("standard-models-view");

  if (userMode === "standard") {
    if (fullView) fullView.classList.add("hidden");
    if (stdView) stdView.classList.remove("hidden");
    await _loadStandardModelsView();
    return;
  }

  // Developer mode: show full view
  if (fullView) fullView.classList.remove("hidden");
  if (stdView) stdView.classList.add("hidden");

  if (cachedConfig) {
    document.getElementById("provider-mode").value        = cachedConfig.model?.provider_mode || "local";
    document.getElementById("provider-fallback").checked  = cachedConfig.model?.fallback_to_cloud === true;
    document.getElementById("cloud-base-url").value       = cachedConfig.model?.cloud_base_url || "";
    document.getElementById("cloud-model-name").value     = cachedConfig.model?.cloud_model || "";
    document.getElementById("cloud-api-key").value        = "";
    document.getElementById("model-base-url").value       = cachedConfig.model?.base_url || "";
    document.getElementById("model-name").value           = cachedConfig.model?.model || "";

    const mode = cachedConfig.model?.provider_mode || "local";
    _updateBuiltinModeToggle(mode);
    if (mode === "internal") await loadBuiltinSection();
  }

  const container = document.getElementById("detected-models");
  container.innerHTML =
    '<div class="probe-item scanning"><span class="probe-label">Scanning...</span><span class="probe-status">...</span></div>';

  const servers = [
    { name: "LM Studio", url: "http://localhost:1234/v1" },
    { name: "Ollama",    url: "http://localhost:11434/v1" },
    { name: "vLLM",      url: "http://localhost:8000/v1" },
  ];

  container.innerHTML = "";
  for (const s of servers) {
    const el = document.createElement("div");
    el.className = "probe-item scanning";
    el.innerHTML = `<span class="probe-label">${s.name} (${s.url})</span><span class="probe-status">scanning...</span>`;
    container.appendChild(el);

    try {
      const r = await api("/models/available?base_url=" + encodeURIComponent(s.url));
      if (r.ok) {
        const data   = await r.json();
        const models = data.models || [];
        el.classList.replace("scanning", "found");

        el.querySelector(".probe-status").textContent =
          models.length > 0 ? models.map((m) => m.id || m).join(", ") : "online";

        const actions = document.createElement("div");
        actions.className = "probe-actions";

        const useBtn = document.createElement("button");
        useBtn.className   = "btn primary btn-sm";
        useBtn.textContent = "Use this";
        useBtn.addEventListener("click", async () => {
          document.getElementById("model-base-url").value = s.url;
          await api("/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: "model.provider_mode", value: "local" }) });
          await api("/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: "model.base_url", value: s.url }) });
          await refreshConfig();
        });
        actions.appendChild(useBtn);

        if (models.length > 1) {
          const select = document.createElement("select");
          select.className = "model-select";
          models.forEach((m) => {
            const opt = document.createElement("option");
            opt.value = opt.textContent = m.id || m;
            select.appendChild(opt);
          });
          select.addEventListener("change", async () => {
            document.getElementById("model-name").value = select.value;
            await api("/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: "model.model", value: select.value }) });
            await refreshConfig();
          });
          actions.appendChild(select);
        } else if (models.length === 1) {
          const pickBtn = document.createElement("button");
          pickBtn.className   = "btn secondary btn-sm";
          pickBtn.textContent = models[0].id || models[0];
          pickBtn.addEventListener("click", async () => {
            const mName = models[0].id || models[0];
            document.getElementById("model-name").value     = mName;
            document.getElementById("model-base-url").value = s.url;
            await api("/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: "model.provider_mode", value: "local" }) });
            await api("/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: "model.base_url", value: s.url }) });
            await api("/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: "model.model", value: mName }) });
            await refreshConfig();
          });
          actions.appendChild(pickBtn);
        }
        el.appendChild(actions);
      } else { throw new Error(); }
    } catch (_) {
      el.classList.replace("scanning", "not-found");
      el.querySelector(".probe-status").textContent = "offline";
    }
  }
}

document.getElementById("save-model-config").addEventListener("click", async () => {
  const url   = document.getElementById("model-base-url").value.trim();
  const model = document.getElementById("model-name").value.trim();
  await api("/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: "model.provider_mode", value: "local" }) });
  if (url)   await api("/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: "model.base_url", value: url }) });
  if (model) await api("/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: "model.model", value: model }) });
  await refreshConfig();
  showToast("Local provider saved.", "success", 2500);
});

document.getElementById("save-provider-config").addEventListener("click", async () => {
  const mode        = document.getElementById("provider-mode").value;
  const fallback    = document.getElementById("provider-fallback").checked;
  const cloudUrl    = document.getElementById("cloud-base-url").value.trim();
  const cloudModel  = document.getElementById("cloud-model-name").value.trim();
  const cloudApiKey = document.getElementById("cloud-api-key").value.trim();

  await api("/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: "model.provider_mode", value: mode }) });
  await api("/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: "model.fallback_to_cloud", value: fallback }) });
  if (cloudUrl)    await api("/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: "model.cloud_base_url", value: cloudUrl }) });
  if (cloudModel)  await api("/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: "model.cloud_model", value: cloudModel }) });
  if (cloudApiKey) await api("/secrets", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: "openai.api_key", value: cloudApiKey }) });
  await refreshConfig();
  showToast("Provider routing saved.", "success", 2500);
});

document.getElementById("rescan-models").addEventListener("click", loadModelsView);

// ── Connectors view ──

async function loadConnectorsView() {
  await refreshConfig();
  const list = document.getElementById("connectors-list");
  if (!cachedConfig) { list.innerHTML = "<p>Unable to load config.</p>"; return; }
  const c = cachedConfig.connectors || {};
  const connectors = [
    { name: "Filesystem",      desc: "Read and write files in the workspace",                           enabled: c.filesystem_enabled !== false, configPath: "connectors.filesystem_enabled" },
    { name: "Email (IMAP/SMTP)", desc: "Read inbox and send emails (approval required for sending)",   enabled: c.email?.enabled === true,       configPath: "connectors.email.enabled", consent: c.email?.consent_granted },
    { name: "Browser (Playwright)", desc: "Browse the web and read page content. Requires Chromium (auto-downloaded on first use).", enabled: c.browser_enabled === true, configPath: "connectors.browser_enabled" },
    { name: "macOS Automation", desc: "Control macOS via AppleScript and take screenshots (macOS only, approval required for actions).", enabled: c.macos_automation_enabled === true, configPath: "connectors.macos_automation_enabled" },
    { name: "Calendar",        desc: "Coming soon",                                                    enabled: false, configPath: null, stub: true },
    { name: "Messaging",       desc: "Coming soon",                                                    enabled: false, configPath: null, stub: true },
  ];

  list.innerHTML = "";

  const reconfigBtn = document.getElementById("reconfigure-connectors-btn");
  if (reconfigBtn && !reconfigBtn.dataset.init) {
    reconfigBtn.dataset.init = "true";
    reconfigBtn.addEventListener("click", () => {
      onboardingEl.classList.remove("hidden");
      goToOnboardStep(2);
    });
  }

  connectors.forEach((cn) => {
    const row = document.createElement("label");
    row.className = "toggle-row connector-toggle";
    const cb = document.createElement("input");
    cb.type = "checkbox"; cb.checked = cn.enabled; cb.disabled = cn.stub || false;
    if (cn.configPath) {
      cb.addEventListener("change", async () => {
        await api("/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: cn.configPath, value: cb.checked }) });
        await refreshConfig();
      });
    }
    const info = document.createElement("div");
    let subtitle = cn.desc;
    if (cn.consent === false && cn.enabled) subtitle += " (consent needed — run rovot onboard to grant)";
    info.innerHTML = `<strong>${escapeHtml(cn.name)}</strong><span${cn.stub ? ' class="muted"' : ""}>${escapeHtml(subtitle)}</span>`;
    row.appendChild(cb);
    row.appendChild(info);
    list.appendChild(row);
  });

  // ── MCP Servers section ──
  let mcpSection = document.getElementById("mcp-section");
  if (!mcpSection) {
    mcpSection = document.createElement("div");
    mcpSection.id = "mcp-section";
    mcpSection.className = "settings-group";
    list.parentElement.appendChild(mcpSection);
  }
  const mcpServers = cachedConfig?.connectors?.mcp_servers || [];
  mcpSection.innerHTML = `
    <h3>MCP Servers</h3>
    <p class="settings-desc">Connect to local MCP servers (Model Context Protocol).
    Each server exposes tools the agent can use. Commands are run as subprocesses.</p>
    <div id="mcp-servers-list"></div>
    <div style="margin-top:10px;display:flex;gap:8px;align-items:flex-start;flex-wrap:wrap">
      <input id="mcp-name" type="text" placeholder="Server name (e.g. filesystem)"
        style="flex:1;min-width:120px;padding:7px 10px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg);color:var(--text);font-size:13px;outline:none" />
      <input id="mcp-cmd" type="text" placeholder="Command (e.g. npx -y @modelcontextprotocol/server-filesystem ~/workspace)"
        style="flex:3;min-width:200px;padding:7px 10px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg);color:var(--text);font-size:13px;outline:none" />
      <button class="btn primary btn-sm" id="mcp-add-btn">Add server</button>
    </div>`;

  const mcpList = document.getElementById("mcp-servers-list");
  if (mcpServers.length === 0) {
    mcpList.innerHTML = '<div class="info-box">No MCP servers configured.</div>';
  } else {
    mcpServers.forEach((s, i) => {
      const row = document.createElement("div");
      row.className = "probe-item found";
      row.style.flexWrap = "wrap";
      row.innerHTML = `<span class="probe-label"><strong>${escapeHtml(s.name)}</strong> &mdash; ${escapeHtml(s.command.join(" "))}</span>
        <button class="btn danger btn-sm" data-idx="${i}">Remove</button>`;
      row.querySelector("button").addEventListener("click", async () => {
        const servers = [...(cachedConfig?.connectors?.mcp_servers || [])];
        servers.splice(i, 1);
        await api("/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: "connectors.mcp_servers", value: servers }) });
        await refreshConfig();
        loadConnectorsView();
      });
      mcpList.appendChild(row);
    });
  }

  document.getElementById("mcp-add-btn").addEventListener("click", async () => {
    const name = document.getElementById("mcp-name").value.trim();
    const cmd  = document.getElementById("mcp-cmd").value.trim();
    if (!name || !cmd) return;
    const servers = [...(cachedConfig?.connectors?.mcp_servers || []), { name, command: cmd.split(" "), env: {}, enabled: true }];
    await api("/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: "connectors.mcp_servers", value: servers }) });
    await refreshConfig();
    loadConnectorsView();
  });
}

// ── Security view ──

async function loadSecurityView() {
  await refreshConfig();
  let healthData = null;
  try {
    const hr = await api("/health");
    if (hr.ok) {
      healthData = await hr.json();
      document.getElementById("sec-binding").textContent =
        `${healthData.host || "127.0.0.1"}:${healthData.port || 18789}${healthData.host === "127.0.0.1" ? " (loopback only)" : " (WARNING: not loopback)"}`;
      document.getElementById("sec-workspace").textContent = healthData.workspace_dir || "~/rovot-workspace";
    }
  } catch (_) {
    document.getElementById("sec-binding").textContent   = "127.0.0.1:18789 (loopback only)";
    document.getElementById("sec-workspace").textContent = "~/rovot-workspace (default)";
  }

  const sandboxModeDescriptions = {
    workspace: "workspace — agent can only read/write files inside the workspace directory",
    strict:    "strict — no filesystem access",
    open:      "open — no sandbox restrictions (not recommended)",
  };
  const mode = cachedConfig?.security_mode || "workspace";
  document.getElementById("sec-sandbox").textContent = sandboxModeDescriptions[mode] || mode;
  document.getElementById("sec-token").textContent   = getToken() ? "Token present and loaded" : "No token found";

  const useKeychain   = cachedConfig?.use_keychain !== false;
  const keychainAvail = healthData?.keychain_available === true;
  document.getElementById("sec-keychain").textContent = useKeychain
    ? (keychainAvail ? "OS Keychain active and available" : "OS Keychain enabled but unavailable (using file fallback)")
    : "Disabled — secrets stored in ~/.rovot/secrets.json (chmod 600)";

  const keychainToggle = document.getElementById("sec-keychain-toggle");
  keychainToggle.checked = useKeychain;
  keychainToggle.onchange = async () => {
    await api("/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: "use_keychain", value: keychainToggle.checked }) });
    await loadSecurityView();
  };

  // User mode selector
  const userModeSelect = document.getElementById("user-mode-select");
  if (userModeSelect) {
    userModeSelect.value = cachedConfig?.user_mode || "standard";
    userModeSelect.onchange = async () => {
      await api("/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: "user_mode", value: userModeSelect.value }) });
      await refreshConfig();
      activateSettingsTab("security");
    };
  }

  const domains = cachedConfig?.allowed_domains || [];
  document.getElementById("sec-domains").textContent = domains.length > 0
    ? `Restricted to: ${domains.join(", ")}`
    : "No restrictions (all domains allowed; approval required per fetch)";

  // Load current system prompt
  try {
    const spr = await api("/config/system-prompt");
    if (spr.ok) {
      const spd = await spr.json();
      document.getElementById("system-prompt-editor").value = spd.prompt || "";
    }
  } catch (_) {}
  const cp = cachedConfig?.connectors || {};
  const perms = [];
  if (cp.filesystem_enabled !== false) perms.push("Filesystem: read/write (workspace only)");
  if (cp.email?.enabled)               perms.push("Email: read/send (approval required for sending)");
  if (cp.calendar_enabled)             perms.push("Calendar: enabled");
  if (cp.messaging_enabled)            perms.push("Messaging: enabled");
  document.getElementById("sec-connectors").textContent =
    perms.length > 0 ? perms.join("\n") : "No connectors enabled";
}

document.getElementById("save-system-prompt").onclick = async () => {
  const prompt = document.getElementById("system-prompt-editor").value;
  const r = await api("/config/system-prompt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt }),
  });
  const statusEl = document.getElementById("system-prompt-status");
  statusEl.style.display = "";
  statusEl.textContent = (await r.json()).note || "System prompt saved.";
  setTimeout(() => { statusEl.style.display = "none"; }, 3000);
};
document.getElementById("reset-system-prompt").onclick = async () => {
  await api("/config/system-prompt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: "" }),
  });
  document.getElementById("system-prompt-editor").value = "";
  showToast("System prompt reset to default.", "success", 2500);
};

// ── Memory view ──

let _memoryEditPath = null;

async function loadMemoryView() {
  const memList = document.getElementById("memory-list");
  const editor  = document.getElementById("memory-editor");
  if (!memList) return;

  // Hide editor, load list
  if (editor) editor.classList.add("hidden");
  _memoryEditPath = null;

  memList.innerHTML = '<div class="info-box">Loading…</div>';
  try {
    const r = await api("/memory");
    if (!r.ok) { memList.innerHTML = '<div class="info-box">Could not load memory files.</div>'; return; }
    const data = await r.json();
    const mems = data.memories || [];
    if (mems.length === 0) {
      memList.innerHTML = '<div class="info-box">No memory files yet. Click "+ New file" to create one, or ask the agent to remember something.</div>';
    } else {
      memList.innerHTML = "";
      mems.forEach((m) => {
        const row = document.createElement("div");
        row.className = "probe-item found";
        row.style.cursor = "pointer";
        row.innerHTML = `<span class="probe-label"><strong>${escapeHtml(m.path)}</strong> &nbsp;<span style="color:var(--text-secondary);font-size:12px">${m.size_bytes} B</span></span>
          <span class="probe-label" style="font-size:12px;color:var(--text-secondary);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(m.content_preview)}</span>`;
        row.addEventListener("click", () => _openMemoryEditor(m.path));
        memList.appendChild(row);
      });
    }
  } catch (_) {
    memList.innerHTML = '<div class="info-box">Memory endpoint unavailable.</div>';
  }

  const newBtn = document.getElementById("memory-new-btn");
  if (newBtn && !newBtn.dataset.init) {
    newBtn.dataset.init = "true";
    newBtn.addEventListener("click", () => {
      const filename = prompt("Memory file name (e.g. preferences.md):");
      if (!filename) return;
      _openMemoryEditor(filename, "");
    });
  }
}

async function _openMemoryEditor(path, initialContent) {
  const editor  = document.getElementById("memory-editor");
  const titleEl = document.getElementById("memory-editor-title");
  const contentEl = document.getElementById("memory-editor-content");
  if (!editor) return;

  _memoryEditPath = path;
  titleEl.textContent = `Edit: ${path}`;

  if (initialContent !== undefined) {
    contentEl.value = initialContent;
  } else {
    try {
      const r = await api(`/memory/${encodeURIComponent(path)}`);
      if (r.ok) {
        const d = await r.json();
        contentEl.value = d.content || "";
      } else {
        contentEl.value = "";
      }
    } catch (_) {
      contentEl.value = "";
    }
  }
  editor.classList.remove("hidden");
  contentEl.focus();

  // Wire save/delete/cancel (idempotent via one-time flag)
  const saveBtn   = document.getElementById("memory-save-btn");
  const deleteBtn = document.getElementById("memory-delete-btn");
  const cancelBtn = document.getElementById("memory-cancel-btn");
  if (!saveBtn.dataset.init) {
    saveBtn.dataset.init = "true";
    saveBtn.addEventListener("click", async () => {
      if (!_memoryEditPath) return;
      await api(`/memory/${encodeURIComponent(_memoryEditPath)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: contentEl.value }),
      });
      showToast("Memory saved.", "success", 2000);
      loadMemoryView();
    });
    deleteBtn.addEventListener("click", async () => {
      if (!_memoryEditPath) return;
      if (!confirm(`Delete memory file "${_memoryEditPath}"?`)) return;
      await api(`/memory/${encodeURIComponent(_memoryEditPath)}`, { method: "DELETE" });
      showToast("Memory deleted.", "success", 2000);
      loadMemoryView();
    });
    cancelBtn.addEventListener("click", () => {
      editor.classList.add("hidden");
      _memoryEditPath = null;
    });
  }
}

// ── Logs view ──

async function loadLogsView() {
  const container = document.getElementById("log-entries");
  try {
    const r = await api("/audit/recent");
    if (r.ok) {
      const data    = await r.json();
      const entries = data.entries || [];
      container.innerHTML = entries.length === 0
        ? '<div class="info-box">No log entries yet.</div>'
        : entries.map((e) => `
          <div class="log-entry">
            <span class="log-ts">${new Date(e.ts).toLocaleTimeString()}</span>
            <span class="log-event">${escapeHtml(e.event)}</span>
            <span class="log-payload">${escapeHtml(JSON.stringify(e.payload || {}))}</span>
          </div>`).join("");
    } else {
      container.innerHTML = '<div class="info-box">Audit endpoint not available.</div>';
    }
  } catch (_) {
    container.innerHTML = '<div class="info-box">Could not load logs.</div>';
  }
}

document.getElementById("refresh-logs").addEventListener("click", loadLogsView);

// ── Help Panel ──

function setupHelpPanel() {
  const helpBtn = document.getElementById("help-btn");
  const helpPanel = document.getElementById("help-panel");
  const helpClose = document.getElementById("help-panel-close");
  if (!helpBtn || !helpPanel) return;

  helpBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    helpPanel.classList.toggle("hidden");
  });
  if (helpClose) {
    helpClose.addEventListener("click", () => helpPanel.classList.add("hidden"));
  }

  // Demo prompt chips in help panel
  helpPanel.querySelectorAll(".help-demo-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      inputEl.value = chip.getAttribute("data-prompt") || chip.textContent.trim();
      inputEl.dispatchEvent(new Event("input"));
      inputEl.focus();
      helpPanel.classList.add("hidden");
      // Switch to chat view
      document.querySelectorAll(".nav-item").forEach((b) => b.classList.remove("active"));
      const chatBtn = document.querySelector('.nav-item[data-view="chat"]');
      if (chatBtn) chatBtn.classList.add("active");
      document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
      document.getElementById("view-chat").classList.add("active");
    });
  });
}

// ── Mode switch modal ──

function setupModeSwitchModal() {
  const badge = document.getElementById("mode-badge");
  const modal = document.getElementById("mode-modal");
  if (!badge || !modal) return;

  badge.addEventListener("click", () => {
    // Pre-select current mode
    const currentMode = cachedConfig?.user_mode || "standard";
    document.querySelectorAll('input[name="modal-mode"]').forEach((r) => {
      r.checked = r.value === currentMode;
    });
    document.querySelectorAll("#mode-modal .option-card").forEach((c) => {
      const radio = c.querySelector('input[type="radio"]');
      c.classList.toggle("selected", radio?.checked === true);
    });
    modal.classList.remove("hidden");
  });

  // Radio card selection
  document.querySelectorAll('input[name="modal-mode"]').forEach((radio) => {
    radio.addEventListener("change", () => {
      document.querySelectorAll("#mode-modal .option-card").forEach((c) => c.classList.remove("selected"));
      radio.closest(".option-card")?.classList.add("selected");
    });
  });

  document.getElementById("mode-modal-cancel").addEventListener("click", () => {
    modal.classList.add("hidden");
  });

  document.getElementById("mode-modal-apply").addEventListener("click", async () => {
    const selected = document.querySelector('input[name="modal-mode"]:checked')?.value;
    if (!selected) { modal.classList.add("hidden"); return; }
    await api("/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "user_mode", value: selected }),
    });
    modal.classList.add("hidden");
    await refreshConfig();
    // If currently on settings, refresh the active tab
    const activeNav = document.querySelector(".nav-item.active")?.getAttribute("data-view");
    if (activeNav === "settings") {
      activateSettingsTab(lastSettingsTab);
    }
    showToast(
      selected === "developer"
        ? "Developer mode enabled — advanced settings are now visible."
        : "Standard mode enabled.",
      "success",
      3000
    );
  });

  // Close on backdrop click
  modal.addEventListener("click", (e) => {
    if (e.target === modal) modal.classList.add("hidden");
  });
}

// ── Init ──

setupOnboarding();
setupHelpPanel();
setupModeSwitchModal();

// Fetch the auth token from the main process exactly once, then start the app.
window.rovot.getToken().then((tok) => {
  cachedToken = tok;
  checkOnboarding().then(() => {
    connectWs();
    refreshApprovals();
  });
});
