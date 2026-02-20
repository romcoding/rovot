const baseUrl = window.rovot.baseUrl();
const token = window.rovot.readToken();

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

let currentSessionId = null;
let ws = null;
let cachedConfig = null;

// ── Helpers ──

async function api(path, opts = {}) {
  const headers = opts.headers || {};
  headers["Authorization"] = `Bearer ${token}`;
  return fetch(baseUrl + path, { ...opts, headers });
}

function addMsg(role, text) {
  const div = document.createElement("div");
  div.className = `msg ${role}`;
  div.textContent = text;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

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

// ── Onboarding ──

async function checkOnboarding() {
  try {
    const r = await api("/config");
    if (r.ok) {
      cachedConfig = await r.json();
      onboardingEl.classList.add("hidden");
      updateIndicators();
      return;
    }
  } catch (_) {}
  onboardingEl.classList.remove("hidden");
}

function setupOnboarding() {
  // Compute mode radio cards
  document.querySelectorAll('.option-card input[name="compute"]').forEach((radio) => {
    radio.addEventListener("change", () => {
      document.querySelectorAll(".option-card").forEach((c) => c.classList.remove("selected"));
      radio.closest(".option-card").classList.add("selected");
      const apiSection = document.getElementById("api-key-section");
      apiSection.classList.toggle("hidden", radio.value !== "api");
    });
  });

  // Step navigation
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
    // Pick the first detected server or default to LM Studio
    const found = document.querySelector(".probe-item.found");
    const url = found ? found.getAttribute("data-url") : "http://localhost:1234/v1";
    await api("/config", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ path: "model.base_url", value: url }),
    });
  } else {
    const apiUrl = document.getElementById("onboard-api-url").value.trim();
    const apiKey = document.getElementById("onboard-api-key").value.trim();
    if (apiUrl) {
      await api("/config", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ path: "model.base_url", value: apiUrl }),
      });
    }
    if (apiKey) {
      await api("/secrets", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ key: "model.api_key", value: apiKey }),
      });
    }
  }

  const fsEnabled = document.getElementById("onboard-fs").checked;
  const emailEnabled = document.getElementById("onboard-email").checked;
  await api("/config", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ path: "connectors.filesystem_enabled", value: fsEnabled }),
  });
  await api("/config", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ path: "connectors.email.enabled", value: emailEnabled }),
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
  const baseUrl = cachedConfig.model?.base_url || "";
  const modelName = cachedConfig.model?.model || "";
  modelIndicator.textContent = modelName || baseUrl.replace(/https?:\/\//, "").split("/")[0] || "--";

  const isLocal = baseUrl.includes("localhost") || baseUrl.includes("127.0.0.1");
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
        <strong>${a.tool_name}</strong>
        <span class="badge">Requires approval</span>
      </div>
      <div class="approval-detail">${escapeHtml(detail)}</div>
      <div class="approval-actions">
        <button class="btn primary" data-id="${a.id}" data-decision="allow">Approve once</button>
        <button class="btn danger" data-id="${a.id}" data-decision="deny">Deny</button>
      </div>
    `;
    approvalsEl.appendChild(card);
  });

  approvalsEl.querySelectorAll("button[data-id]").forEach((btn) => {
    btn.onclick = async () => {
      const id = btn.getAttribute("data-id");
      const decision = btn.getAttribute("data-decision");
      await api(`/approvals/${id}/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ decision }),
      });
      await refreshApprovals();
      if (currentSessionId) {
        const r2 = await api("/chat/continue", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ session_id: currentSessionId, approval_id: id }),
        });
        const d2 = await r2.json();
        addMsg("assistant", d2.reply);
      }
    };
  });
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// ── Chat ──

async function sendMessage() {
  const msg = inputEl.value.trim();
  if (!msg) return;
  inputEl.value = "";
  addMsg("user", msg);
  try {
    const r = await api("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ message: msg, session_id: currentSessionId }),
    });
    const data = await r.json();
    currentSessionId = data.session_id;
    addMsg("assistant", data.reply);
    await refreshApprovals();
  } catch (err) {
    addMsg("assistant", `Error: ${err.message}`);
  }
}

sendBtn.onclick = sendMessage;
inputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) sendMessage();
});

// ── WebSocket ──

function connectWs() {
  ws = new WebSocket(`ws://127.0.0.1:18789/ws?token=${encodeURIComponent(token)}`);
  ws.onopen = () => (statusEl.textContent = "connected");
  ws.onclose = () => {
    statusEl.textContent = "disconnected";
    setTimeout(connectWs, 3000);
  };
  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.event === "chat.reply") refreshApprovals();
      if (msg.event === "approval.resolved") refreshApprovals();
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
          headers: { Authorization: `Bearer ${token}` },
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
  container.innerHTML = '<div class="probe-item scanning"><span class="probe-label">Scanning...</span><span class="probe-status">...</span></div>';

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
        el.querySelector(".probe-status").textContent =
          models.length > 0 ? models.map((m) => m.id || m).join(", ") : "online";
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
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ path: "model.base_url", value: url }),
    });
  }
  if (model) {
    await api("/config", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
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
      configurable: true,
      path: "connectors.filesystem_enabled",
    },
    {
      name: "Email (IMAP/SMTP)",
      desc: "Read inbox and send emails",
      enabled: c.email?.enabled === true,
      configurable: true,
      path: "connectors.email.enabled",
      consent: c.email?.consent_granted,
    },
    {
      name: "Calendar",
      desc: "Local calendar integration",
      enabled: c.calendar_enabled === true,
      configurable: false,
      stub: true,
    },
    {
      name: "Messaging",
      desc: "Local messaging integration",
      enabled: c.messaging_enabled === true,
      configurable: false,
      stub: true,
    },
  ];

  list.innerHTML = connectors
    .map((cn) => {
      let statusClass = cn.stub ? "stub" : cn.enabled ? "enabled" : "disabled";
      let statusText = cn.stub ? "Coming soon" : cn.enabled ? "Enabled" : "Disabled";
      if (cn.consent === false && cn.enabled) statusText = "Needs consent";
      return `
        <div class="connector-card">
          <div class="connector-info">
            <strong>${cn.name}</strong>
            <span>${cn.desc}</span>
          </div>
          <span class="connector-status ${statusClass}">${statusText}</span>
        </div>`;
    })
    .join("");
}

// ── Security view ──

async function loadSecurityView() {
  await refreshConfig();
  document.getElementById("sec-binding").textContent = "127.0.0.1:18789 (loopback only)";
  document.getElementById("sec-sandbox").textContent =
    cachedConfig?.security_mode || "workspace";
  document.getElementById("sec-workspace").textContent =
    "~/rovot-workspace (default)";
  document.getElementById("sec-token").textContent = token ? "Token file present and loaded" : "No token file found";

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
      container.innerHTML = entries.length === 0
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

connectWs();
refreshApprovals();
setupOnboarding();
checkOnboarding();
