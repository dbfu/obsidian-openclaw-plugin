const { App, Modal, Notice, Plugin, PluginSettingTab, Setting } = require("obsidian");
const { spawn } = require("child_process");
const crypto = require("crypto");
const path = require("path");

const isWindows = process.platform === "win32";

const DEFAULT_SETTINGS = {
  agent: "main",
  gatewayUrl: "ws://127.0.0.1:18789",
  timeoutSeconds: 600,
  noteSessions: {},
};

module.exports = class OpenClawCommandPlugin extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());

    this.addCommand({
      id: "send-current-note-to-openclaw",
      name: "发送选中文本到 OpenClaw",
      editorCallback: async (editor) => {
        new InstructionModal(this.app, this, editor, true).open();
      },
    });

    this.addCommand({
      id: "ask-openclaw-with-prompt",
      name: "向 OpenClaw 提问",
      editorCallback: async (editor) => {
        new InstructionModal(this.app, this, editor).open();
      },
    });

    this.addCommand({
      id: "reset-current-note-openclaw-session",
      name: "清除当前笔记的 OpenClaw 上下文",
      callback: async () => {
        const sessionId = await this.getSessionIdForActiveFile(true);
        new Notice(`OpenClaw 上下文已重置: ${sessionId}`);
      },
    });

    this.addRibbonIcon("bot", "Ask OpenClaw", () => {
      const view = this.app.workspace.getActiveViewOfType(require("obsidian").MarkdownView);
      if (!view) {
        new Notice("Open a markdown note first.");
        return;
      }
      new InstructionModal(this.app, this, view.editor).open();
    });

    this.addSettingTab(new OpenClawSettingTab(this.app, this));
  }

  async getSessionIdForActiveFile(reset) {
    const activeFile = this.app.workspace.getActiveFile();
    if (!activeFile || activeFile.extension !== "md") {
      return this.getSessionIdForKey("global", reset);
    }

    return this.getSessionIdForKey(activeFile.path, reset);
  }

  async getSessionIdForKey(key, reset) {
    this.settings.noteSessions = this.settings.noteSessions || {};

    if (!reset && this.settings.noteSessions[key]) {
      return this.settings.noteSessions[key];
    }

    const sessionId = createSessionId(key);
    this.settings.noteSessions[key] = sessionId;
    await this.saveSettings();
    return sessionId;
  }

  async runOpenClaw(message, sessionId, onProgress) {
    return await this.runOpenClawWsRunner(message, sessionId, onProgress);
  }

  resolveNodePath() {
    if (this._nodePath) return this._nodePath;
    const candidates = isWindows
      ? ["node", "C:\\Program Files\\nodejs\\node.exe"]
      : ["node", "/usr/local/bin/node", "/opt/homebrew/bin/node"];
    for (const cmd of candidates) {
      try {
        const result = require("child_process").spawnSync(cmd, ["-e", "process.exit(0)"], { timeout: 3000 });
        if (result.status === 0) {
          this._nodePath = cmd;
          return cmd;
        }
      } catch {}
    }
    return null;
  }

  runOpenClawWsRunner(message, sessionId, onProgress) {
    return new Promise((resolve, reject) => {
      const runnerPath = path.join(this.app.vault.configDir, "plugins", this.manifest.id, "ws-runner.js");
      const args = [
        runnerPath,
        JSON.stringify({
          agent: this.settings.agent || "main",
          gatewayUrl: this.settings.gatewayUrl || DEFAULT_SETTINGS.gatewayUrl,
          message,
          sessionId,
          timeoutSeconds: this.settings.timeoutSeconds,
        }),
      ];

      const nodePath = this.resolveNodePath();
      const useSystemNode = !!nodePath;

      const child = spawn(useSystemNode ? nodePath : process.execPath, args, {
        cwd: this.app.vault.adapter.basePath || process.cwd(),
        env: {
          ...process.env,
          ...(!useSystemNode ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
        },
      });
      let settled = false;
      let buffer = "";
      let stderr = "";

      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        try {
          child.kill("SIGTERM");
        } catch {}
        if (error) reject(error);
        else resolve(value);
      };

      child.stdout.on("data", (chunk) => {
        buffer += chunk.toString();
        let index;
        while ((index = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, index).trim();
          buffer = buffer.slice(index + 1);
          if (!line) continue;

          let event;
          try {
            event = JSON.parse(line);
          } catch {
            onProgress?.(line);
            continue;
          }

          if (event.type === "progress") {
            onProgress?.(event.text || "");
          } else if (event.type === "final") {
            finish(null, event.text || "");
          } else if (event.type === "error") {
            finish(new Error(event.message || "OpenClaw runner failed."));
          }
        }
      });

      child.stderr.on("data", (chunk) => {
        const text = chunk.toString().trim();
        if (text) {
          stderr += `${text}\n`;
          console.error(`[OpenClaw runner] ${text}`);
        }
      });

      child.on("error", (error) => {
        finish(error);
      });

      child.on("close", (code, signal) => {
        if (settled) return;
        if (code === 0) {
          finish(null, "");
        } else {
          const reason = signal ? `signal ${signal}` : `code ${code}`;
          const detail = stderr.trim() ? `: ${stderr.trim()}` : "";
          finish(new Error(`OpenClaw runner exited with ${reason}${detail}`));
        }
      });
    });
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
};

const SYSTEM_HINT = [
  "当前环境为 Obsidian 笔记应用。",
  "如果需要引用文件路径，请使用 [名称](file:///绝对路径) 格式，以便在 Obsidian 中可以直接点击跳转。",
].join("\n");

function buildPrompt(instruction, selectedText) {
  const normalizedInstruction = instruction.trim() || "请根据当前文章会话上下文回复。";
  const normalizedSelection = selectedText.trim();

  const parts = [SYSTEM_HINT, normalizedInstruction];
  if (normalizedSelection) {
    parts.push(`--- 当前选中内容 ---\n${normalizedSelection}`);
  }

  return parts.join("\n\n");
}

function createSessionId(key) {
  const digest = crypto.createHash("sha1").update(key).digest("hex").slice(0, 10);
  const suffix = crypto.randomBytes(4).toString("hex");
  return `obsidian-${digest}-${suffix}`;
}

function formatOpenClawError(error) {
  return error?.message || String(error);
}

function extractOpenClawText(result) {
  if (typeof result === "string") return result;

  const payloads = result && result.result && Array.isArray(result.result.payloads)
    ? result.result.payloads
    : [];

  const text = payloads
    .map((payload) => payload && payload.text)
    .filter(Boolean)
    .join("\n\n");

  return text || JSON.stringify(result, null, 2);
}

class InstructionModal extends Modal {
  constructor(app, plugin, editor, autoSend = false) {
    super(app);
    this.plugin = plugin;
    this.editor = editor;
    this.autoSend = autoSend;
    this.instruction = "";
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();

    this.inputArea = contentEl.createDiv({ cls: "openclaw-modal-input" });
    this.inputArea.createEl("h2", { text: "Ask OpenClaw" });

    const textarea = this.inputArea.createEl("textarea", {
      cls: "openclaw-input",
      attr: {
        placeholder: "输入指令，回车发送，Shift+回车换行",
        rows: 4,
      },
    });
    textarea.value = this.instruction;
    textarea.addEventListener("input", () => {
      this.instruction = textarea.value;
    });
    textarea.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        this.send();
      }
    });
    textarea.focus();

    this.outputArea = contentEl.createDiv({ cls: "openclaw-modal-output" });
    this.outputArea.style.display = "none";

    if (this.autoSend) {
      this.send();
    }
  }

  async send() {
    const instruction = this.instruction.trim();

    this.inputArea.style.display = "none";
    this.outputArea.style.display = "block";
    const responseEl = this.outputArea.createEl("div", { cls: "openclaw-response" });

    const selectedText = this.editor.getSelection() || "";
    const insertAtSelectionEnd = this.autoSend && selectedText.trim()
      ? this.editor.getCursor("to")
      : null;
    if (!instruction && !selectedText.trim()) {
      responseEl.setText("没有选中文本，也没有输入指令。");
      return;
    }

    const sessionId = await this.plugin.getSessionIdForActiveFile(false);
    const prompt = buildPrompt(instruction, selectedText);

    let latestText = "";
    let renderedText = "";
    let flushTimer = null;

    const flush = () => {
      flushTimer = null;
      if (latestText === renderedText) return;

      if (latestText.startsWith(renderedText)) {
        const delta = latestText.slice(renderedText.length);
        responseEl.appendChild(document.createTextNode(delta));
      } else {
        responseEl.setText(latestText);
      }
      renderedText = latestText;
      responseEl.scrollTop = responseEl.scrollHeight;
    };

    try {
      const result = await this.plugin.runOpenClaw(prompt, sessionId, (message) => {
        latestText = message;
        if (!flushTimer) {
          flushTimer = setTimeout(flush, 60);
        }
      });
      clearTimeout(flushTimer);
      flush();
      const text = extractOpenClawText(result);
      if (text && text !== latestText) {
        responseEl.setText(text);
      }

      const finalText = (text || latestText).trim();
      const cursor = insertAtSelectionEnd || this.editor.getCursor();
      const insertedText = insertAtSelectionEnd ? `\n${finalText}\n` : `\n\n${finalText}\n`;
      this.editor.replaceRange(insertedText, cursor);
      new Notice("OpenClaw result inserted.");

      setTimeout(() => this.close(), 600);
    } catch (error) {
      clearTimeout(flushTimer);
      const msg = formatOpenClawError(error);
      responseEl.setText(`OpenClaw failed: ${msg}`);
      new Notice(`OpenClaw failed: ${msg}`);
      console.error(error);
    }
  }
}

class OpenClawSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "OpenClaw Command" });

    new Setting(containerEl)
      .setName("Agent")
      .setDesc("OpenClaw agent id。")
      .addText((text) =>
        text
          .setPlaceholder("main")
          .setValue(this.plugin.settings.agent)
          .onChange(async (value) => {
            this.plugin.settings.agent = value.trim() || "main";
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Gateway URL")
      .setDesc("本地 OpenClaw Gateway WebSocket 地址。")
      .addText((text) =>
        text
          .setPlaceholder("ws://127.0.0.1:18789")
          .setValue(this.plugin.settings.gatewayUrl)
          .onChange(async (value) => {
            this.plugin.settings.gatewayUrl = value.trim() || DEFAULT_SETTINGS.gatewayUrl;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Timeout seconds")
      .addText((text) =>
        text
          .setPlaceholder("600")
          .setValue(String(this.plugin.settings.timeoutSeconds))
          .onChange(async (value) => {
            this.plugin.settings.timeoutSeconds = Number(value) || 600;
            await this.plugin.saveSettings();
          }),
      );
  }
}
