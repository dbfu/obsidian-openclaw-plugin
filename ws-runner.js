#!/usr/bin/env node

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const input = JSON.parse(process.argv[2] || "{}");
const gatewayUrl = input.gatewayUrl || "ws://127.0.0.1:18789";
const agent = input.agent || "main";
const sessionId = input.sessionId;
const sessionKey = `agent:${agent}:explicit:${sessionId}`;
const message = input.message || "";
const timeoutMs = Math.max(1, Number(input.timeoutSeconds) || 600) * 1000;

let nextId = 1;
let connectNonce = "";
let activeRunId = "";
let finalText = "";
let settled = false;
const pending = new Map();

function emit(type, payload) {
  process.stdout.write(`${JSON.stringify({ type, ...payload })}\n`);
}

function request(ws, method, params) {
  const id = String(nextId++);
  const promise = new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
  });
  ws.send(JSON.stringify({ type: "req", id, method, params }));
  return promise;
}

function readGatewayToken() {
  try {
    const configPath = path.join(os.homedir(), ".openclaw", "openclaw.json");
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    return config?.gateway?.auth?.token || config?.gateway?.token || "";
  } catch {
    return "";
  }
}

function readDeviceToken() {
  try {
    const configPath = path.join(os.homedir(), ".openclaw", "identity", "device-auth.json");
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    return config?.tokens?.operator?.token || "";
  } catch {
    return "";
  }
}

function readDeviceIdentity() {
  try {
    const configPath = path.join(os.homedir(), ".openclaw", "identity", "device.json");
    return JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch {
    return null;
  }
}

function toBase64Url(bytes) {
  return Buffer.from(bytes)
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/g, "");
}

function signDeviceConnect({ client, role, scopes, token, nonce }) {
  const identity = readDeviceIdentity();
  if (!identity?.deviceId || !identity?.publicKeyPem || !identity?.privateKeyPem) {
    return undefined;
  }

  const signedAt = Date.now();
  const payload = [
    "v2",
    identity.deviceId,
    client.id,
    client.mode,
    role,
    scopes.join(","),
    String(signedAt),
    token || "",
    nonce || "",
  ].join("|");

  const signature = crypto.sign(null, Buffer.from(payload), identity.privateKeyPem);
  const publicKeyDer = crypto
    .createPublicKey(identity.publicKeyPem)
    .export({ format: "der", type: "spki" });

  return {
    id: identity.deviceId,
    publicKey: toBase64Url(publicKeyDer.subarray(-32)),
    signature: toBase64Url(signature),
    signedAt,
    nonce: nonce || "",
  };
}

function textFromMessage(message) {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (part && part.type === "text" ? part.text || "" : ""))
    .filter(Boolean)
    .join("\n\n");
}

function finish(ws, code, payload) {
  if (settled) return;
  settled = true;
  clearTimeout(timer);
  try {
    ws.close();
  } catch {}
  emit(code === 0 ? "final" : "error", payload);
  setTimeout(() => process.exit(code), 20);
}

const timer = setTimeout(() => {
  emit("error", { message: `Timed out after ${timeoutMs / 1000} seconds.` });
  process.exit(1);
}, timeoutMs);

async function main() {
  if (!sessionId) throw new Error("sessionId is required");
  if (!message) throw new Error("message is required");

  let WebSocketClass;
  try {
    const wsModule = require(require("path").join(__dirname, "node_modules", "ws"));
    WebSocketClass = wsModule.WebSocket || wsModule;
  } catch {}
  if (!WebSocketClass && typeof WebSocket === "function") {
    WebSocketClass = WebSocket;
  }
  if (!WebSocketClass) {
    throw new Error("No WebSocket available. Install ws package or use Node.js 22+.");
  }

  const ws = new WebSocketClass(gatewayUrl);

  ws.addEventListener("open", () => {
    emit("progress", { text: "等待认证..." });
  });

  ws.addEventListener("error", () => {
    finish(ws, 1, { message: "Gateway WebSocket connection failed." });
  });

  ws.addEventListener("message", async (event) => {
    let frame;
    try {
      frame = JSON.parse(String(event.data || ""));
    } catch {
      return;
    }

    if (frame.type === "res") {
      const entry = pending.get(frame.id);
      if (!entry) return;
      pending.delete(frame.id);
      if (frame.ok) entry.resolve(frame.payload);
      else entry.reject(new Error(frame.error?.message || JSON.stringify(frame.error || frame)));
      return;
    }

    if (frame.type !== "event") return;

    if (frame.event === "connect.challenge") {
      connectNonce = frame.payload?.nonce || "";
      try {
        const client = {
          id: "cli",
          version: "obsidian-openclaw-command",
          platform: process.platform,
          mode: "cli",
        };
        const role = "operator";
        const scopes = [
          "operator.admin",
          "operator.approvals",
          "operator.pairing",
          "operator.read",
          "operator.write",
        ];
        const token = readDeviceToken() || readGatewayToken();
        const device = signDeviceConnect({ client, role, scopes, token, nonce: connectNonce });

        await request(ws, "connect", {
          minProtocol: 3,
          maxProtocol: 3,
          client,
          role,
          scopes,
          caps: ["tool-events"],
          commands: [],
          permissions: {},
          auth: token ? { token } : undefined,
          device,
          locale: "zh-CN",
          userAgent: "obsidian-openclaw-command/0.1.0",
        });

        await request(ws, "sessions.messages.subscribe", { key: sessionKey });
        const result = await request(ws, "chat.send", {
          sessionKey,
          message,
          deliver: false,
          idempotencyKey: `obsidian-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        });
        activeRunId = result?.runId || "";
        emit("progress", { text: "OpenClaw 已开始生成..." });
      } catch (error) {
        finish(ws, 1, { message: error.message });
      }
      return;
    }

    const payload = frame.payload || {};
    if (payload.sessionKey && payload.sessionKey !== sessionKey) return;
    if (activeRunId && payload.runId && payload.runId !== activeRunId) return;

    if (frame.event === "agent" && payload.stream === "assistant" && payload.data) {
      const text = payload.data.text || payload.data.delta || "";
      if (text) {
        finalText = payload.data.text || finalText + text;
        emit("progress", { text: finalText });
      }
      return;
    }

    if (frame.event === "chat" && payload.state === "delta" && payload.message) {
      const text = textFromMessage(payload.message);
      if (text && text.length > finalText.length) {
        finalText = text;
        emit("progress", { text });
      }
      return;
    }

    if (frame.event === "chat" && payload.state === "final" && payload.message) {
      const text = textFromMessage(payload.message) || finalText;
      finish(ws, 0, { text });
    }
  });
}

main().catch((error) => {
  emit("error", { message: error.message });
  process.exit(1);
});
