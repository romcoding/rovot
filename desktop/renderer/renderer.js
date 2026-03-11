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
  sendBtn.disabled = sending;
  sendBtn.textContent = sending ? "…" : "Send";
  inputEl.disabled = sending;
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
  if (tab === "logs")       loadLogsView();
}

// ── Backend connection & Onboarding ──

async function waitForBackend(maxAttempts = 15) {
  backendOverlay.classList.remove("hidden");
  backendConnecting.classList.remove("hidden");
  backendError.classList.add("hidden");
  let lastHealthError = "";

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
        updateIndicators();
        return;
      }
    }
  } catch (_) { return; }
  onboardingEl.classList.remove("hidden");
}

function setupOnboarding() {
  document.querySelectorAll('.option-card input[name="compute"]').forEach((radio) => {
    radio.addEventListener("change", () => {
      document.querySelectorAll(".option-card").forEach((c) => c.classList.remove("selected"));
      radio.closest(".option-card").classList.add("selected");
      const apiSection = document.getElementById("api-key-section");
      apiSection.classList.toggle("hidden", radio.value !== "api");
    });
  });

  document.querySelectorAll("[data-next]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const next = parseInt(btn.getAttribute("data-next"));
      goToOnboardStep(next);
      if (next === 1) probeModels();
    });
  });
  document.querySelectorAll("[data-prev]").forEach((btn) => {
    btn.addEventListener("click", () => goToOnboardStep(parseInt(btn.getAttribute("data-prev"))));
  });
  document.getElementById("onboard-finish").addEventListener("click", finishOnboarding);
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
      const r = await api("/models/available?base_url=" + encodeURIComponent(s.url));
      if (r.ok) {
        const data = await r.json();
        const models = data.models || [];
        el.classList.remove("scanning");
        el.classList.add("found");
        el.querySelector(".probe-status").textContent =
          models.length > 0 ? `${models.length} model(s)` : "server online";
      } else { throw new Error("not ok"); }
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

  const compute = document.querySelector('input[name="compute"]:checked').value;
  if (compute === "local") {
    const found = document.querySelector(".probe-item.found");
    const url = found ? found.getAttribute("data-url") : "http://localhost:1234/v1";
    await api("/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: "model.provider_mode", value: "local" }) });
    await api("/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: "model.base_url", value: url }) });
  } else {
    const apiUrl = document.getElementById("onboard-api-url").value.trim();
    const apiKey = document.getElementById("onboard-api-key").value.trim();
    await api("/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: "model.provider_mode", value: "cloud" }) });
    if (apiUrl) await api("/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: "model.cloud_base_url", value: apiUrl }) });
    if (apiKey) await api("/secrets", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: "openai.api_key", value: apiKey }) });
  }

  const fsEnabled    = document.getElementById("onboard-fs").checked;
  const emailEnabled = document.getElementById("onboard-email").checked;
  await api("/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: "connectors.filesystem_enabled", value: fsEnabled }) });
  await api("/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: "connectors.email.enabled", value: emailEnabled }) });
  await api("/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: "onboarded", value: true }) });

  btn.disabled = false;
  btn.textContent = "Get started";
  onboardingEl.classList.add("hidden");
  await refreshConfig();
}

// ── Config & Indicators ──

async function refreshConfig() {
  try {
    const r = await api("/config");
    if (r.ok) cachedConfig = await r.json();
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
      list.classList.add("hidden");
    });
  });
}

function restoreSession(sessionId, title) {
  currentSessionId = sessionId;
  // Clear chat and show a restore note — full history lives on the daemon
  messagesEl.innerHTML = "";
  const emptyState = document.getElementById("chat-empty-state");
  if (emptyState) {
    emptyState.classList.add("hidden");
    messagesEl.appendChild(emptyState);
  }
  addMsg("assistant",
    `Continuing session: "${title}"\n\nPrevious messages are stored on the daemon. New messages will continue this conversation.`
  );
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

// ── Chat ──

async function sendMessage() {
  const msg = inputEl.value.trim();
  if (!msg || isSending) return;

  inputEl.value = "";
  resetInputHeight();
  addMsg("user", msg);
  addTimelineEvent("chat", "Message sent");
  setSendingState(true);
  showTypingIndicator();

  try {
    const r = await api("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: msg, session_id: currentSessionId }),
    });
    const data = await readJsonOrThrow(r);
    currentSessionId = data.session_id;
    addMsg("assistant", data.reply);
    addTimelineEvent("chat", "Reply received");
    // Save session to history on first message
    saveSession(data.session_id, msg);

    if (data.tool_calls) {
      data.tool_calls.forEach((tc) => {
        addTimelineEvent("tool_call",
          `${tc.name || tc.tool_name || "tool"}(${JSON.stringify(tc.arguments || tc.args || {}).slice(0, 80)})`
        );
      });
    }
    await refreshApprovals();
  } catch (err) {
    removeTypingIndicator();
    showToast(err.message);                          // ← toast, not chat bubble
    addTimelineEvent("error", err.message);
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
      if (msg.event === "tool.call")          { addTimelineEvent("tool_call", msg.data?.tool || "tool invoked"); }
      if (msg.event === "tool.result")        { addTimelineEvent("tool_call", `Result: ${(msg.data?.summary || "done").slice(0, 80)}`); }

      // Model download progress
      if (msg.event === "model_download_progress") {
        const { filename, progress } = msg.data || {};
        const pct = Math.round((progress || 0) * 100);
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
        const { filename } = msg.data || {};
        showToast(`Downloaded ${filename || "model"} successfully.`, "success", 4000);
        loadBuiltinSection();
      }
      if (msg.event === "model_download_error") {
        const { filename, error } = msg.data || {};
        showToast(`Download failed for ${filename || "model"}: ${error || "unknown error"}`, "error", 6000);
        loadBuiltinSection();
      }
      if (msg.event === "model_load_complete") {
        const { filename } = msg.data || {};
        showToast(`Model loaded: ${filename || ""}`, "success", 3000);
        loadBuiltinSection();
        refreshConfig();
      }
      if (msg.event === "model_load_error") {
        const { filename, error } = msg.data || {};
        showToast(`Failed to load ${filename || "model"}: ${error || "unknown error"}`, "error", 6000);
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

function _updateBuiltinModeToggle(mode) {
  document.getElementById("mode-builtin").classList.toggle("active", mode === "internal");
  document.getElementById("mode-external").classList.toggle("active", mode !== "internal");
  document.getElementById("builtin-models-section").classList.toggle("hidden", mode !== "internal");
}

async function loadBuiltinSection() {
  // Loaded model status
  const statusEl = document.getElementById("builtin-loaded-status");
  try {
    const r = await api("/models/internal/loaded");
    const data = await r.json();
    if (data.loading) {
      statusEl.innerHTML = '<span class="status-spinner" style="display:inline-block;width:14px;height:14px;margin-right:6px"></span>Loading model...';
    } else if (data.loaded) {
      statusEl.innerHTML = `<strong>${escapeHtml(data.loaded)}</strong> loaded &nbsp;
        <button class="btn danger btn-sm" id="unload-model-btn">Unload</button>`;
      document.getElementById("unload-model-btn").addEventListener("click", async () => {
        await api("/models/internal/unload", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${getToken()}` } });
        await loadBuiltinSection();
        await refreshConfig();
      });
    } else {
      statusEl.textContent = "No model loaded";
    }
  } catch (_) {
    statusEl.textContent = "Built-in inference unavailable";
  }

  // Available (downloaded) models
  const availEl = document.getElementById("builtin-available-list");
  availEl.innerHTML = "";
  try {
    const r2 = await api("/models/internal/available");
    const data2 = await r2.json();
    const models = data2.models || [];
    if (models.length === 0) {
      availEl.innerHTML = '<div class="info-box">No models downloaded yet. Use the catalog below.</div>';
    } else {
      models.forEach((filename) => {
        const el = document.createElement("div");
        el.className = "probe-item found";
        el.innerHTML = `<span class="probe-label">${escapeHtml(filename)}</span>
          <button class="btn primary btn-sm" data-filename="${escapeHtml(filename)}">Load</button>`;
        el.querySelector("button").addEventListener("click", async () => {
          el.querySelector("button").disabled = true;
          el.querySelector("button").textContent = "Loading...";
          await api("/models/internal/load", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${getToken()}` },
            body: JSON.stringify({ model_filename: filename }),
          });
          document.getElementById("builtin-loaded-status").innerHTML =
            '<span class="status-spinner" style="display:inline-block;width:14px;height:14px;margin-right:6px"></span>Loading model...';
          await api("/config", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${getToken()}` },
            body: JSON.stringify({ path: "model.provider_mode", value: "internal" }),
          });
          await refreshConfig();
        });
        availEl.appendChild(el);
      });
    }
  } catch (_) {}

  // Catalog
  const catalogEl = document.getElementById("builtin-catalog-list");
  catalogEl.innerHTML = "";
  try {
    const r3 = await api("/models/internal/catalog");
    const catalog = await r3.json();
    catalog.forEach((item) => {
      const card = document.createElement("div");
      card.className = "catalog-card";
      card.innerHTML = `
        <div class="catalog-info">
          <strong>${escapeHtml(item.name)}</strong>
          ${item.downloaded ? '<span class="badge badge-green">Downloaded</span>' : ""}
          <span class="catalog-meta">${item.size_gb} GB &bull; ${item.ram_required_gb} GB RAM</span>
          <span class="catalog-desc">${escapeHtml(item.description)}</span>
        </div>
        <div class="catalog-action">
          ${item.downloaded
            ? `<button class="btn primary btn-sm catalog-load-btn" data-filename="${escapeHtml(item.filename)}">Load</button>`
            : `<button class="btn secondary btn-sm catalog-dl-btn" data-filename="${escapeHtml(item.filename)}" data-url="${escapeHtml(item.hf_url)}">Download</button>`}
          <div class="catalog-progress hidden" id="progress-${escapeHtml(item.filename)}">
            <div class="progress-bar"><div class="progress-fill" style="width:0%"></div></div>
            <span class="progress-label">0%</span>
          </div>
        </div>
      `;

      const dlBtn = card.querySelector(".catalog-dl-btn");
      if (dlBtn) {
        dlBtn.addEventListener("click", async () => {
          dlBtn.disabled = true;
          dlBtn.textContent = "Downloading...";
          const progressBox = card.querySelector(`#progress-${CSS.escape(item.filename)}`);
          if (progressBox) progressBox.classList.remove("hidden");
          await api("/models/internal/download", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${getToken()}` },
            body: JSON.stringify({ filename: item.filename, hf_url: item.hf_url }),
          });
        });
      }

      const loadBtn = card.querySelector(".catalog-load-btn");
      if (loadBtn) {
        loadBtn.addEventListener("click", async () => {
          loadBtn.disabled = true;
          loadBtn.textContent = "Loading...";
          await api("/models/internal/load", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${getToken()}` },
            body: JSON.stringify({ model_filename: item.filename }),
          });
          document.getElementById("builtin-loaded-status").innerHTML =
            '<span class="status-spinner" style="display:inline-block;width:14px;height:14px;margin-right:6px"></span>Loading model...';
          await api("/config", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${getToken()}` },
            body: JSON.stringify({ path: "model.provider_mode", value: "internal" }),
          });
          await refreshConfig();
        });
      }

      catalogEl.appendChild(card);
    });
  } catch (_) {}
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

// ── Models view ──

async function loadModelsView() {
  await refreshConfig();
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
    { name: "Calendar",        desc: "Coming soon",                                                    enabled: false, configPath: null, stub: true },
    { name: "Messaging",       desc: "Coming soon",                                                    enabled: false, configPath: null, stub: true },
  ];

  list.innerHTML = "";
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

  const domains = cachedConfig?.allowed_domains || [];
  document.getElementById("sec-domains").textContent = domains.length > 0
    ? `Restricted to: ${domains.join(", ")}`
    : "No restrictions (all domains allowed; approval required per fetch)";

  const cp = cachedConfig?.connectors || {};
  const perms = [];
  if (cp.filesystem_enabled !== false) perms.push("Filesystem: read/write (workspace only)");
  if (cp.email?.enabled)               perms.push("Email: read/send (approval required for sending)");
  if (cp.calendar_enabled)             perms.push("Calendar: enabled");
  if (cp.messaging_enabled)            perms.push("Messaging: enabled");
  document.getElementById("sec-connectors").textContent =
    perms.length > 0 ? perms.join("\n") : "No connectors enabled";
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

// ── Init ──

setupOnboarding();

// Fetch the auth token from the main process exactly once, then start the app.
window.rovot.getToken().then((tok) => {
  cachedToken = tok;
  checkOnboarding().then(() => {
    connectWs();
    refreshApprovals();
  });
});
