const baseUrl = window.rovot.baseUrl();

// DOM refs
const statusEl = document.getElementById("connection-status");
const modelIndicator = document.getElementById("model-indicator");
const privacyIndicator = document.getElementById("privacy-indicator");
const messagesEl = document.getElementById("messages");
const approvalsEl = document.getElementById("approvals");
const inputEl = document.getElementById("input");
const sendBtn = document.getElementById("send");
const recBtn = document.getElementById("record");
const onboardingEl = document.getElementById("onboarding");
const timelineEventsEl = document.getElementById("timeline-events");
const backendOverlay = document.getElementById("backend-status-overlay");
const backendConnecting = document.getElementById("backend-connecting");
const backendError = document.getElementById("backend-error");

let currentSessionId = null;
let ws = null;
let cachedConfig = null;
let isSending = false;
let timelineCollapsed = false;

// ── Helpers ──

function getToken() {
  return window.rovot.readToken();
}

async function api(path, opts = {}) {
  const headers = opts.headers || {};
  headers["Authorization"] = `Bearer ${getToken()}`;
  return fetch(baseUrl + path, { ...opts, headers });
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function renderMarkdown(text) {
  let html = escapeHtml(text);
  html = html.replace(/```([\s\S]*?)```/g, '<pre class="md-code-block"><code>$1</code></pre>');
  html = html.replace(/`([^`]+)`/g, '<code class="md-inline-code">$1</code>');
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/\n/g, "<br>");
  return html;
}

function addMsg(role, text) {
  removeTypingIndicator();
  const div = document.createElement("div");
  div.className = `msg ${role}`;
  if (role === "assistant") {
    div.innerHTML = renderMarkdown(text);
  } else {
    div.textContent = text;
  }
  messagesEl.appendChild(div);
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
  sendBtn.textContent = sending ? "..." : "Send";
  inputEl.disabled = sending;
}

// ── Activity Timeline ──

function addTimelineEvent(type, detail) {
  const item = document.createElement("div");
  item.className = `timeline-item timeline-${type}`;

  const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const icons = {
    tool_call: "&#9881;",
    approval: "&#9888;",
    approval_resolved: "&#10003;",
    error: "&#10007;",
    chat: "&#9993;",
  };

  item.innerHTML = `
    <div class="timeline-icon">${icons[type] || "&#8226;"}</div>
    <div class="timeline-body">
      <div class="timeline-meta">
        <span class="timeline-type">${escapeHtml(type.replace("_", " "))}</span>
        <span class="timeline-time">${time}</span>
      </div>
      <div class="timeline-detail">${escapeHtml(detail)}</div>
    </div>
  `;

  timelineEventsEl.prepend(item);

  while (timelineEventsEl.children.length > 200) {
    timelineEventsEl.removeChild(timelineEventsEl.lastChild);
  }
}

document.getElementById("toggle-timeline").addEventListener("click", () => {
  timelineCollapsed = !timelineCollapsed;
  document.getElementById("activity-timeline").classList.toggle("collapsed", timelineCollapsed);
});

// ── Sidebar navigation ──

document.querySelectorAll(".nav-item").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".nav-item").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    const target = btn.getAttribute("data-view");
    document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
    document.getElementById(`view-${target}`).classList.add("active");
    if (target === "models") loadModelsView();
    if (target === "connectors") loadConnectorsView();
    if (target === "security") loadSecurityView();
    if (target === "logs") loadLogsView();
  });
});

// ── Backend connection & Onboarding ──

async function waitForBackend(maxAttempts = 15) {
  backendOverlay.classList.remove("hidden");
  backendConnecting.classList.remove("hidden");
  backendError.classList.add("hidden");

  for (let i = 0; i < maxAttempts; i++) {
    try {
      const r = await api("/health");
      if (r.ok) {
        backendOverlay.classList.add("hidden");
        return true;
      }
    } catch (_) {}
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  backendConnecting.classList.add("hidden");
  backendError.classList.remove("hidden");

  try {
    const errMsg = await window.rovot.getDaemonError();
    if (errMsg) {
      const detail = document.getElementById("backend-error-detail");
      if (detail) detail.textContent = errMsg.slice(-500);
    }
  } catch (_) {}

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
  } catch (_) {
    return;
  }
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
    btn.addEventListener("click", () => {
      goToOnboardStep(parseInt(btn.getAttribute("data-prev")));
    });
  });

  document.getElementById("onboard-finish").addEventListener("click", finishOnboarding);
}

function goToOnboardStep(n) {
  document.querySelectorAll(".onboard-page").forEach((p) => p.classList.remove("active"));
  document.querySelectorAll(".step-dot").forEach((d) => d.classList.remove("active"));
  const page = document.querySelector(`.onboard-page[data-page="${n}"]`);
  const dot = document.querySelector(`.step-dot[data-step="${n}"]`);
  if (page) page.classList.add("active");
  if (dot) dot.classList.add("active");
}

async function probeModels() {
  const container = document.getElementById("model-probe-results");
  const servers = [
    { name: "LM Studio", url: "http://localhost:1234/v1" },
    { name: "Ollama", url: "http://localhost:11434/v1" },
  ];

  container.innerHTML = servers
    .map(
      (s) =>
        `<div class="probe-item scanning" data-url="${s.url}">
          <span class="probe-label">${s.name} (${s.url})</span>
          <span class="probe-status">scanning...</span>
        </div>`
    )
    .join("");

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
      } else {
        throw new Error("not ok");
      }
    } catch (_) {
      el.classList.remove("scanning");
      el.classList.add("not-found");
      el.querySelector(".probe-status").textContent = "not found";
    }
  }
}

async function finishOnboarding() {
  const compute = document.querySelector('input[name="compute"]:checked').value;

  if (compute === "local") {
    const found = document.querySelector(".probe-item.found");
    const url = found ? found.getAttribute("data-url") : "http://localhost:1234/v1";
    await api("/config", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${getToken()}` },
      body: JSON.stringify({ path: "model.base_url", value: url }),
    });
  } else {
    const apiUrl = document.getElementById("onboard-api-url").value.trim();
    const apiKey = document.getElementById("onboard-api-key").value.trim();
    if (apiUrl) {
      await api("/config", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${getToken()}` },
        body: JSON.stringify({ path: "model.base_url", value: apiUrl }),
      });
    }
    if (apiKey) {
      await api("/secrets", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${getToken()}` },
        body: JSON.stringify({ key: "model.api_key", value: apiKey }),
      });
    }
  }

  const fsEnabled = document.getElementById("onboard-fs").checked;
  const emailEnabled = document.getElementById("onboard-email").checked;
  await api("/config", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${getToken()}` },
    body: JSON.stringify({ path: "connectors.filesystem_enabled", value: fsEnabled }),
  });
  await api("/config", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${getToken()}` },
    body: JSON.stringify({ path: "connectors.email.enabled", value: emailEnabled }),
  });

  await api("/config", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${getToken()}` },
    body: JSON.stringify({ path: "onboarded", value: true }),
  });

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
  const modelBaseUrl = cachedConfig.model?.base_url || "";
  const modelName = cachedConfig.model?.model || "";
  modelIndicator.textContent = modelName || modelBaseUrl.replace(/https?:\/\//, "").split("/")[0] || "--";

  const isLocal = modelBaseUrl.includes("localhost") || modelBaseUrl.includes("127.0.0.1");
  privacyIndicator.textContent = isLocal ? "Local" : "Cloud";
  privacyIndicator.className = "indicator " + (isLocal ? "privacy-local" : "privacy-cloud");
}

// ── Approvals ──

async function refreshApprovals() {
  const r = await api("/approvals/pending");
  const data = await r.json();
  approvalsEl.innerHTML = "";
  (data.pending || []).forEach((a) => {
    const card = document.createElement("div");
    card.className = "approval-card";

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

    card.innerHTML = `
      <div class="approval-header">
        <strong>${escapeHtml(a.tool_name)}</strong>
        <span class="badge">Requires approval</span>
      </div>
      <div class="approval-detail">${escapeHtml(detail)}</div>
      <div class="approval-actions">
        <button class="btn primary" data-id="${a.id}" data-decision="allow">Approve once</button>
        <button class="btn danger" data-id="${a.id}" data-decision="deny">Deny</button>
      </div>
    `;
    approvalsEl.appendChild(card);

    addTimelineEvent("approval", `${a.tool_name}: approval requested`);
  });

  approvalsEl.querySelectorAll("button[data-id]").forEach((btn) => {
    btn.onclick = async () => {
      const id = btn.getAttribute("data-id");
      const decision = btn.getAttribute("data-decision");
      await api(`/approvals/${id}/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${getToken()}` },
        body: JSON.stringify({ decision }),
      });
      addTimelineEvent("approval_resolved", `${decision}: ${id.slice(0, 8)}`);
      await refreshApprovals();
      if (currentSessionId) {
        const r2 = await api("/chat/continue", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${getToken()}` },
          body: JSON.stringify({ session_id: currentSessionId, approval_id: id }),
        });
        const d2 = await r2.json();
        addMsg("assistant", d2.reply);
      }
    };
  });
}

// ── Chat ──

async function sendMessage() {
  const msg = inputEl.value.trim();
  if (!msg || isSending) return;
  inputEl.value = "";
  addMsg("user", msg);
  addTimelineEvent("chat", "Message sent");
  setSendingState(true);
  showTypingIndicator();
  try {
    const r = await api("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${getToken()}` },
      body: JSON.stringify({ message: msg, session_id: currentSessionId }),
    });
    const data = await r.json();
    currentSessionId = data.session_id;
    addMsg("assistant", data.reply);
    addTimelineEvent("chat", "Reply received");

    if (data.tool_calls) {
      data.tool_calls.forEach((tc) => {
        addTimelineEvent("tool_call", `${tc.name || tc.tool_name || "tool"}(${JSON.stringify(tc.arguments || tc.args || {}).slice(0, 80)})`);
      });
    }

    await refreshApprovals();
  } catch (err) {
    removeTypingIndicator();
    addMsg("assistant", `Error: ${err.message}`);
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

// ── New Chat ──

document.getElementById("new-chat").addEventListener("click", () => {
  currentSessionId = null;
  messagesEl.innerHTML = "";
  approvalsEl.innerHTML = "";
  addTimelineEvent("chat", "New conversation started");
});

// ── WebSocket ──

function connectWs() {
  ws = new WebSocket(`ws://127.0.0.1:18789/ws?token=${encodeURIComponent(getToken())}`);
  ws.onopen = () => (statusEl.textContent = "connected");
  ws.onclose = () => {
    statusEl.textContent = "disconnected";
    setTimeout(connectWs, 3000);
  };
  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.event === "chat.reply") {
        refreshApprovals();
        addTimelineEvent("chat", "Server pushed reply");
      }
      if (msg.event === "approval.resolved") {
        refreshApprovals();
        addTimelineEvent("approval_resolved", "Approval resolved via WS");
      }
      if (msg.event === "tool.call") {
        addTimelineEvent("tool_call", msg.data?.tool || "tool invoked");
      }
      if (msg.event === "tool.result") {
        addTimelineEvent("tool_call", `Result: ${(msg.data?.summary || "done").slice(0, 80)}`);
      }
    } catch (_) {}
  };
}

// ── Voice ──

let recorder = null;
let chunks = [];
recBtn.onclick = async () => {
  if (recorder && recorder.state === "recording") {
    recorder.stop();
    recBtn.classList.remove("recording");
    return;
  }
  chunks = [];
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    recorder = new MediaRecorder(stream);
    recorder.ondataavailable = (e) => chunks.push(e.data);
    recorder.onstop = async () => {
      const blob = new Blob(chunks, { type: "audio/webm" });
      const fd = new FormData();
      fd.append("audio", blob, "audio.webm");
      try {
        const r = await fetch(baseUrl + "/voice/transcribe", {
          method: "POST",
          headers: { Authorization: `Bearer ${getToken()}` },
          body: fd,
        });
        if (r.ok) {
          const d = await r.json();
          if (d.text) inputEl.value = d.text;
        }
      } catch (_) {}
    };
    recorder.start();
    recBtn.classList.add("recording");
  } catch (_) {}
};

// ── Models view ──

async function loadModelsView() {
  await refreshConfig();
  if (cachedConfig) {
    document.getElementById("model-base-url").value = cachedConfig.model?.base_url || "";
    document.getElementById("model-name").value = cachedConfig.model?.model || "";
  }

  const container = document.getElementById("detected-models");
  container.innerHTML =
    '<div class="probe-item scanning"><span class="probe-label">Scanning...</span><span class="probe-status">...</span></div>';

  const servers = [
    { name: "LM Studio", url: "http://localhost:1234/v1" },
    { name: "Ollama", url: "http://localhost:11434/v1" },
    { name: "vLLM", url: "http://localhost:8000/v1" },
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
        const data = await r.json();
        const models = data.models || [];
        el.classList.remove("scanning");
        el.classList.add("found");

        let statusHtml = models.length > 0
          ? models.map((m) => m.id || m).join(", ")
          : "online";

        el.querySelector(".probe-status").textContent = statusHtml;

        const actions = document.createElement("div");
        actions.className = "probe-actions";

        const useBtn = document.createElement("button");
        useBtn.className = "btn primary btn-sm";
        useBtn.textContent = "Use this";
        useBtn.addEventListener("click", async () => {
          document.getElementById("model-base-url").value = s.url;
          await api("/config", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${getToken()}` },
            body: JSON.stringify({ path: "model.base_url", value: s.url }),
          });
          await refreshConfig();
        });
        actions.appendChild(useBtn);

        if (models.length > 1) {
          const select = document.createElement("select");
          select.className = "model-select";
          models.forEach((m) => {
            const opt = document.createElement("option");
            opt.value = m.id || m;
            opt.textContent = m.id || m;
            select.appendChild(opt);
          });
          select.addEventListener("change", async () => {
            document.getElementById("model-name").value = select.value;
            await api("/config", {
              method: "POST",
              headers: { "Content-Type": "application/json", Authorization: `Bearer ${getToken()}` },
              body: JSON.stringify({ path: "model.model", value: select.value }),
            });
            await refreshConfig();
          });
          actions.appendChild(select);
        } else if (models.length === 1) {
          const pickBtn = document.createElement("button");
          pickBtn.className = "btn secondary btn-sm";
          pickBtn.textContent = models[0].id || models[0];
          pickBtn.addEventListener("click", async () => {
            const mName = models[0].id || models[0];
            document.getElementById("model-name").value = mName;
            document.getElementById("model-base-url").value = s.url;
            await api("/config", {
              method: "POST",
              headers: { "Content-Type": "application/json", Authorization: `Bearer ${getToken()}` },
              body: JSON.stringify({ path: "model.base_url", value: s.url }),
            });
            await api("/config", {
              method: "POST",
              headers: { "Content-Type": "application/json", Authorization: `Bearer ${getToken()}` },
              body: JSON.stringify({ path: "model.model", value: mName }),
            });
            await refreshConfig();
          });
          actions.appendChild(pickBtn);
        }

        el.appendChild(actions);
      } else {
        throw new Error();
      }
    } catch (_) {
      el.classList.remove("scanning");
      el.classList.add("not-found");
      el.querySelector(".probe-status").textContent = "offline";
    }
  }
}

document.getElementById("save-model-config").addEventListener("click", async () => {
  const url = document.getElementById("model-base-url").value.trim();
  const model = document.getElementById("model-name").value.trim();
  if (url) {
    await api("/config", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${getToken()}` },
      body: JSON.stringify({ path: "model.base_url", value: url }),
    });
  }
  if (model) {
    await api("/config", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${getToken()}` },
      body: JSON.stringify({ path: "model.model", value: model }),
    });
  }
  await refreshConfig();
});

document.getElementById("rescan-models").addEventListener("click", loadModelsView);

// ── Connectors view ──

async function loadConnectorsView() {
  await refreshConfig();
  const list = document.getElementById("connectors-list");
  if (!cachedConfig) {
    list.innerHTML = "<p>Unable to load config.</p>";
    return;
  }
  const c = cachedConfig.connectors || {};
  const connectors = [
    {
      name: "Filesystem",
      desc: "Read and write files in the workspace",
      enabled: c.filesystem_enabled !== false,
      configPath: "connectors.filesystem_enabled",
    },
    {
      name: "Email (IMAP/SMTP)",
      desc: "Read inbox and send emails (approval required for sending)",
      enabled: c.email?.enabled === true,
      configPath: "connectors.email.enabled",
      consent: c.email?.consent_granted,
    },
    {
      name: "Calendar",
      desc: "Local calendar integration",
      enabled: c.calendar_enabled === true,
      configPath: null,
      stub: true,
    },
    {
      name: "Messaging",
      desc: "Local messaging integration",
      enabled: c.messaging_enabled === true,
      configPath: null,
      stub: true,
    },
  ];

  list.innerHTML = "";
  connectors.forEach((cn) => {
    const row = document.createElement("label");
    row.className = "toggle-row connector-toggle";

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = cn.enabled;
    cb.disabled = cn.stub || false;

    if (cn.configPath) {
      cb.addEventListener("change", async () => {
        await api("/config", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${getToken()}` },
          body: JSON.stringify({ path: cn.configPath, value: cb.checked }),
        });
        await refreshConfig();
      });
    }

    const info = document.createElement("div");
    let subtitle = cn.desc;
    if (cn.stub) subtitle = "Coming soon";
    else if (cn.consent === false && cn.enabled) subtitle += " (needs consent)";
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
      document.getElementById("sec-workspace").textContent =
        healthData.workspace_dir || "~/rovot-workspace";
    }
  } catch (_) {
    document.getElementById("sec-binding").textContent = "127.0.0.1:18789 (loopback only)";
    document.getElementById("sec-workspace").textContent = "~/rovot-workspace (default)";
  }

  document.getElementById("sec-sandbox").textContent =
    cachedConfig?.security_mode || "workspace";
  document.getElementById("sec-token").textContent = getToken()
    ? "Token file present and loaded"
    : "No token file found";

  const useKeychain = cachedConfig?.use_keychain !== false;
  const keychainAvail = healthData?.keychain_available === true;
  const keychainStatus = useKeychain
    ? keychainAvail
      ? "OS Keychain active and available"
      : "OS Keychain enabled but unavailable (using file fallback)"
    : "Disabled -- secrets stored in ~/.rovot/secrets.json (chmod 600)";
  document.getElementById("sec-keychain").textContent = keychainStatus;

  const keychainToggle = document.getElementById("sec-keychain-toggle");
  keychainToggle.checked = useKeychain;
  keychainToggle.onchange = async () => {
    await api("/config", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${getToken()}` },
      body: JSON.stringify({ path: "use_keychain", value: keychainToggle.checked }),
    });
    await loadSecurityView();
  };

  const domains = cachedConfig?.allowed_domains || [];
  document.getElementById("sec-domains").textContent =
    domains.length > 0
      ? `Restricted to: ${domains.join(", ")}`
      : "No restrictions (all domains allowed, approval required per fetch)";

  const c = cachedConfig?.connectors || {};
  const perms = [];
  if (c.filesystem_enabled !== false) perms.push("Filesystem: read/write (workspace only)");
  if (c.email?.enabled) perms.push("Email: read/send (approval required for sending)");
  if (c.calendar_enabled) perms.push("Calendar: enabled");
  if (c.messaging_enabled) perms.push("Messaging: enabled");
  document.getElementById("sec-connectors").textContent =
    perms.length > 0 ? perms.join("\n") : "No connectors enabled";
}

// ── Logs view ──

async function loadLogsView() {
  const container = document.getElementById("log-entries");
  try {
    const r = await api("/audit/recent");
    if (r.ok) {
      const data = await r.json();
      const entries = data.entries || [];
      container.innerHTML =
        entries.length === 0
          ? '<div class="info-box">No log entries yet.</div>'
          : entries
              .map(
                (e) => `<div class="log-entry">
              <span class="log-ts">${new Date(e.ts).toLocaleTimeString()}</span>
              <span class="log-event">${escapeHtml(e.event)}</span>
              <span class="log-payload">${escapeHtml(JSON.stringify(e.payload || {}))}</span>
            </div>`
              )
              .join("");
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
checkOnboarding().then(() => {
  connectWs();
  refreshApprovals();
});
