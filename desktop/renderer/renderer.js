const baseUrl = window.rovot.baseUrl();
const token = window.rovot.readToken();
const statusEl = document.getElementById("status");
const messagesEl = document.getElementById("messages");
const approvalsEl = document.getElementById("approvals");
const traceEl = document.getElementById("trace");
const inputEl = document.getElementById("input");
const sendBtn = document.getElementById("send");
const recBtn = document.getElementById("record");

let currentSessionId = null;
let ws = null;

function addMsg(role, text) {
  const div = document.createElement("div");
  div.className = `msg ${role}`;
  div.textContent = text;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

async function api(path, opts = {}) {
  const headers = opts.headers || {};
  headers["Authorization"] = `Bearer ${token}`;
  return fetch(baseUrl + path, { ...opts, headers });
}

async function refreshApprovals() {
  const r = await api("/approvals/pending");
  const data = await r.json();
  approvalsEl.innerHTML = "";
  (data.pending || []).forEach((a) => {
    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = `
      <div><b>${a.tool_name}</b></div>
      <div>${a.summary}</div>
      <div style="margin-top:8px; display:flex; gap:8px;">
        <button data-id="${a.id}" data-decision="allow">Approve</button>
        <button data-id="${a.id}" data-decision="deny">Deny</button>
      </div>
    `;
    approvalsEl.appendChild(card);
  });
  approvalsEl.querySelectorAll("button").forEach((btn) => {
    btn.onclick = async () => {
      const id = btn.getAttribute("data-id");
      const decision = btn.getAttribute("data-decision");
      await api(`/approvals/${id}/resolve`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ decision }),
      });
      await refreshApprovals();
      if (currentSessionId) {
        const r2 = await api("/chat/continue", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ session_id: currentSessionId }),
        });
        const d2 = await r2.json();
        addMsg("assistant", d2.reply);
        traceEl.textContent += `\ncontinue -> pending=${d2.pending_approval_id || ""}`;
      }
    };
  });
}

async function sendMessage() {
  const msg = inputEl.value.trim();
  if (!msg) return;
  inputEl.value = "";
  addMsg("user", msg);
  const r = await api("/chat", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ message: msg, session_id: currentSessionId }),
  });
  const data = await r.json();
  currentSessionId = data.session_id;
  addMsg("assistant", data.reply);
  traceEl.textContent += `\nchat -> session=${currentSessionId}, pending=${data.pending_approval_id || ""}`;
  await refreshApprovals();
}

sendBtn.onclick = sendMessage;
inputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) sendMessage();
});

function connectWs() {
  ws = new WebSocket(
    `ws://127.0.0.1:18789/ws?token=${encodeURIComponent(token)}`
  );
  ws.onopen = () => (statusEl.textContent = "connected");
  ws.onclose = () => (statusEl.textContent = "disconnected");
  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      traceEl.textContent += `\n[event] ${msg.event}`;
    } catch {}
  };
}
connectWs();
refreshApprovals();

let recorder = null;
let chunks = [];
recBtn.onclick = async () => {
  if (recorder && recorder.state === "recording") {
    recorder.stop();
    recBtn.textContent = "🎙";
    return;
  }
  chunks = [];
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
      if (!r.ok) return;
      const d = await r.json();
      if (d.text) inputEl.value = d.text;
    } catch {}
  };
  recorder.start();
  recBtn.textContent = "⏹";
};
