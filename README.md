# OpenClaw Command for Obsidian

This plugin adds commands that send the current selection or an instruction to OpenClaw and insert the final response into the active Markdown note.
It uses the local Gateway WebSocket API so the temporary block can show streaming assistant output while OpenClaw is running.

## Install locally

Create the plugin directory in your vault and copy only the plugin files:

```bash
TARGET="<your-vault>/.obsidian/plugins/openclaw-command"
mkdir -p "$TARGET"
cp main.js ws-runner.js manifest.json styles.css package.json "$TARGET/"
```

Then install runtime dependencies in that plugin directory:

```bash
cd "$TARGET"
npm install --omit=dev
```

Then enable `OpenClaw Command` in Obsidian community plugins.

## Commands

- `OpenClaw Command: Send selection to OpenClaw`
- `OpenClaw Command: Ask OpenClaw with instruction`
- `OpenClaw Command: Clear OpenClaw context for current note`

The second command opens a prompt where you can enter an instruction such as:

```text
总结这篇文章，并提取待办事项
```

Only selected text is sent as note content. If nothing is selected, the plugin sends only your instruction. Each Markdown file gets its own persisted OpenClaw session id. Use `Clear OpenClaw context for current note` to create a fresh session for the current file.

## Defaults

The plugin is configured for the local Gateway:

```text
ws://127.0.0.1:18789
```

It reads the local paired CLI device identity from `~/.openclaw/identity/` and signs the Gateway handshake.

The old CLI fallback path used:

```bash
ELECTRON_RUN_AS_NODE=1 /Applications/ClawX.app/Contents/MacOS/ClawX /Applications/ClawX.app/Contents/Resources/openclaw/openclaw.mjs agent --agent main --message "..." --json
```

If your OpenClaw CLI is installed elsewhere, update the plugin settings.
