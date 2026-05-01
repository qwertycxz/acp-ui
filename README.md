# ACP UI

<a href="https://apps.microsoft.com/detail/9P76NGS1VF2L?referrer=appbadge&mode=full" target="_blank"  rel="noopener noreferrer">
	<img src="https://get.microsoft.com/images/en-us%20dark.svg" width="200"/>
</a>

A modern, cross-platform client for the [Agent Client Protocol (ACP)](https://agentclientprotocol.com/) on desktop and mobile. Connect to AI coding agents like GitHub Copilot, Claude Code, Gemini CLI, Qwen Code, Codex CLI, OpenCode, OpenClaw, and any ACP-compatible agent from a unified interface.

![ACP UI Screenshot](assets/screenshot.png)

## 📥 Installation

Download the latest release for your platform from [GitHub Releases](https://github.com/formulahendry/acp-ui/releases):

| Platform | Download |
|----------|----------|
| **Windows** | [.msi installer](https://github.com/formulahendry/acp-ui/releases/latest) or [.exe (NSIS)](https://github.com/formulahendry/acp-ui/releases/latest) |
| **macOS (Apple Silicon)** | [.dmg (ARM64)](https://github.com/formulahendry/acp-ui/releases/latest) |
| **macOS (Intel)** | [.dmg (x64)](https://github.com/formulahendry/acp-ui/releases/latest) |
| **Linux (x64)** | [.deb](https://github.com/formulahendry/acp-ui/releases/latest) or [.AppImage](https://github.com/formulahendry/acp-ui/releases/latest) or [.rpm](https://github.com/formulahendry/acp-ui/releases/latest) |
| **Linux (ARM64)** | [.deb](https://github.com/formulahendry/acp-ui/releases/latest) or [.AppImage](https://github.com/formulahendry/acp-ui/releases/latest) or [.rpm](https://github.com/formulahendry/acp-ui/releases/latest) |
| **Android** | [.apk](https://github.com/formulahendry/acp-ui/releases/latest) — sideload via "Install unknown apps" |
| **iOS** | Build from source (see [Building for iOS](#building-for-ios)) — no prebuilt binary |

> Mobile builds connect to remote agents over WebSocket. See [Connecting from your phone](#-connecting-from-your-phone) for how to expose a local agent to your device.

## ✨ Features

- **Multi-Agent Support** — Connect to any ACP-compatible agent
- **Remote agents over WebSocket** — Talk to agents on another machine via `ws://` / `wss://`
- **Mobile** — Android APK shipped on Releases; iOS via local Xcode build
- **Foreground reconnect** — On mobile, automatically reattaches to your session when you switch back to the app
- **Session Management** — Create, resume, and manage conversation sessions
- **Rich Chat Interface** — Markdown rendering, syntax highlighting, tool call visualization
- **Slash Commands** — Quick access to agent capabilities with `/command` syntax
- **Permission Controls** — Approve or deny agent actions before execution
- **Session Modes** — Switch between agent modes (ask, code, architect, etc.)
- **Model Picker** — Select from available AI models (unstable API)
- **Agent Thinking** — View the agent's reasoning process (collapsible)
- **Environment Variables** — Configure per-agent environment variables (API keys, settings)
- **Traffic Monitor** — Debug and inspect ACP protocol messages in real-time
- **Hot-Reload Config** — Edit agent configurations without restarting (desktop)
- **Cross-Platform** — Windows, macOS (ARM/Intel), Linux (x64/ARM64), Android, iOS

## 🎯 Default Agents

ACP UI comes pre-configured with these agents:

| Agent | Package |
|-------|---------|
| [GitHub Copilot](https://github.com/github/copilot-language-server-release?tab=readme-ov-file#agent-client-protocol-acp-preview) | `@github/copilot-language-server` |
| [Claude Code](https://github.com/zed-industries/claude-code-acp) | `@zed-industries/claude-code-acp` |
| [Gemini CLI](https://github.com/google-gemini/gemini-cli) | `@google/gemini-cli` |
| [Qwen Code](https://github.com/QwenLM/qwen-code) | `@qwen-code/qwen-code` |
| [Auggie CLI](https://github.com/AugmentCode/auggie) | `@augmentcode/auggie` |
| [Qoder CLI](https://github.com/qoder-ai/qodercli) | `@qoder-ai/qodercli` |
| [Codex CLI](https://github.com/zed-industries/codex-acp) | `@zed-industries/codex-acp` |
| [OpenCode](https://github.com/opencode-ai/opencode) | `opencode-ai` |
| [OpenClaw](https://github.com/nicobailon/openclaw) | `openclaw` |

## 🛠️ Configuration

Agent configurations are stored in:

| Platform | Path |
|----------|------|
| Windows | `%APPDATA%\acp-ui\agents.json` |
| macOS | `~/Library/Application Support/acp-ui/agents.json` |
| Linux | `~/.config/acp-ui/agents.json` |
| Android | `/data/data/formulahendry.acp_ui/files/agents.json` (managed via Settings UI) |
| iOS | App sandbox — managed via Settings UI |

> On mobile the config file isn't user-accessible — add and edit agents through the in-app **Settings** dialog. Stdio agents are filtered out of the list since they can't run on a phone.

### Local stdio agents (desktop)

### Example Configuration

```json
{
  "agents": {
    "GitHub Copilot": {
      "command": "npx",
      "args": ["@github/copilot-language-server@latest", "--acp"],
      "env": {}
    },
    "Claude Code": {
      "command": "npx",
      "args": ["@zed-industries/claude-code-acp@latest"],
      "env": {
        "ANTHROPIC_API_KEY": "sk-ant-..."
      }
    },
    "Gemini CLI": {
      "command": "npx",
      "args": ["@google/gemini-cli@latest", "--experimental-acp"],
      "env": {}
    },
    "Qwen Code": {
      "command": "npx",
      "args": ["@qwen-code/qwen-code@latest", "--acp", "--experimental-skills"],
      "env": {}
    },
    "Auggie CLI": {
      "command": "npx",
      "args": ["@augmentcode/auggie@latest", "--acp"],
      "env": {"AUGMENT_DISABLE_AUTO_UPDATE": "1"}
    },
    "Qoder CLI": {
      "command": "npx",
      "args": ["@qoder-ai/qodercli@latest", "--acp"],
      "env": {}
    },
    "Codex CLI": {
      "command": "npx",
      "args": ["@zed-industries/codex-acp@latest"],
      "env": {}
    },
    "OpenCode": {
      "command": "npx",
      "args": ["opencode-ai@latest", "acp"],
      "env": {}
    },
    "OpenClaw": {
      "command": "npx",
      "args": ["openclaw", "acp"],
      "env": {}
    }
  }
}
```

> **Note**: Environment variables are passed to the agent process on startup. Use these for API keys, custom settings, or overriding default behavior.

### Remote agents over WebSocket

For agents running on another machine — or for connecting from a phone to an agent on your laptop — use the `websocket` transport instead of `command`:

```json
{
  "agents": {
    "Copilot CLI (remote)": {
      "transport": "websocket",
      "url": "wss://acp.example.com/v1",
      "headers": { "Authorization": "Bearer YOUR_TOKEN" }
    }
  }
}
```

Both `ws://` (cleartext, for LAN / Dev Tunnels) and `wss://` (TLS) are accepted. `Authorization: Bearer <token>` is propagated as a WebSocket subprotocol because browser/WebView WebSocket APIs cannot set custom HTTP headers.

> **Note**: Filesystem RPCs (`fs/read_text_file`, `fs/write_text_file`) respond with JSON-RPC `-32601 Method not found` for remote agents. The agent operates on its own host's filesystem at the path you set as the working directory.

## 🌐 Connecting from your phone

The mobile build can only talk to remote agents (no subprocess on iOS / Android), so you need to expose a local stdio agent over a network endpoint. The recommended bridge is [`@rebornix/stdio-to-ws`](https://www.npmjs.com/package/@rebornix/stdio-to-ws), which speaks ACP-over-WebSocket on one end and stdio on the other.

### Same Wi-Fi (LAN)

On your computer:

```sh
npx @rebornix/stdio-to-ws "copilot --acp" --port 3000 --persist --grace-period -1
```

- Allow inbound TCP 3000 in your OS firewall.
  - Windows (one-time, elevated PowerShell):
    ```powershell
    New-NetFirewallRule -DisplayName "stdio-to-ws" -Direction Inbound -LocalPort 3000 -Protocol TCP -Action Allow -Profile Private
    ```
- Find your computer's LAN IP (`ipconfig` on Windows, `ifconfig`/`ip a` on macOS / Linux).
- In ACP UI on the phone, add a websocket agent with URL `ws://<LAN IP>:3000/`.

> **Android emulator** uses `ws://10.0.2.2:3000/`. **USB-tethered phone** can use `ws://localhost:3000/` after running `adb reverse tcp:3000 tcp:3000`.

### From anywhere (Microsoft Dev Tunnels)

`stdio-to-ws` exposes the agent on `localhost`; pair it with [Microsoft Dev Tunnels](https://learn.microsoft.com/en-us/azure/developer/dev-tunnels/) to get a `wss://` URL reachable from the public internet.

```sh
# Terminal 1 — wrap the agent as a WebSocket on port 3000.
npx @rebornix/stdio-to-ws "copilot --acp" --port 3000 --persist --grace-period -1

# Terminal 2 — expose port 3000 publicly. First-run prompts for login.
devtunnel host -p 3000
```

`devtunnel host` prints a URL like:

```
https://<id>-3000.<region>.devtunnels.ms
```

Use the **`wss://...devtunnels.ms/`** form (replace `https` with `wss`) as the agent URL in ACP UI on the phone.

#### Stable URL across restarts

The ad-hoc URL changes every run. To get a reusable one:

```sh
# One-time setup
devtunnel user login
devtunnel create my-acp -a
devtunnel port create my-acp -p 3000 --protocol https

# Every session afterwards
devtunnel host my-acp
```

Reference: [Dev Tunnels CLI commands](https://learn.microsoft.com/en-us/azure/developer/dev-tunnels/cli-commands).

#### Why `--persist --grace-period -1`?

Mobile OSes freeze backgrounded apps within seconds, dropping the WebSocket. `--persist` tells the bridge to keep the wrapped agent alive across disconnects, and `--grace-period -1` makes that timeout infinite. When ACP UI on the phone returns to the foreground, it transparently reattaches via `session/load` and your conversation resumes. Without persistence, you'd lose the running agent every time you switched apps.

> **Tip**: a future `stdio-to-ws` release will integrate Dev Tunnels into the bridge itself (`--tunnel-name <name>`, currently only on its `dev` branch). Once published you'll be able to collapse the two terminals into one.

## 📖 Usage

1. **Select an Agent** — Choose from the dropdown in the sidebar (☰ on mobile).
2. **Set Working Directory** — Pick a folder on desktop, or type an absolute path on mobile. The path is interpreted on the **agent's host**, not the phone.
3. **Create Session** — Tap **New Session** to start chatting.
4. **Use Slash Commands** — Type `/` to see available commands.
5. **Resume Sessions** — Tap a saved session in the sidebar to resume.

## 🚀 Development

### Prerequisites

- [Node.js](https://nodejs.org/) 18+
- [Rust](https://rustup.rs/) 1.70+
- Platform-specific build tools (see [Tauri Prerequisites](https://tauri.app/start/prerequisites/))

### Setup

```bash
# Clone the repository
git clone https://github.com/formulahendry/acp-ui.git
cd acp-ui

# Install dependencies
npm install

# Run in development mode
npm run tauri dev
```

### Build for Production

```bash
npm run tauri build
```

### Building for Android

Prerequisites:

- JDK 17 (Temurin recommended)
- Android SDK platform 34, build-tools 34, NDK 26
- Rust Android targets: `rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android`
- Set `ANDROID_HOME` and `NDK_HOME` env vars

```sh
# `src-tauri/gen/android/` is gitignored; this regenerates it.
npm run tauri android init

# Allow plain ws:// to LAN agents (the init template defaults this off via
# a Gradle placeholder). Required for ACP UI's LAN-agent UX.
sed -i 's|usesCleartextTraffic="\${usesCleartextTraffic}"|usesCleartextTraffic="true"|' \
  src-tauri/gen/android/app/src/main/AndroidManifest.xml

# Debug-signed APK suitable for sideload.
npm run tauri android build -- --debug --apk
# Output: src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk
```

To run on a device with hot-reload during development:

```sh
npm run tauri android dev
```

If the device can't reach the dev server, allow port `1420` through your firewall, or USB-tether the phone and run `adb reverse tcp:1420 tcp:1420` first.

### Building for iOS

Prerequisites:

- macOS with Xcode 15+
- An Apple Developer team for signing
- Rust iOS targets: `rustup target add aarch64-apple-ios x86_64-apple-ios aarch64-apple-ios-sim`

```sh
npm run tauri ios init
```

Then edit `src-tauri/gen/apple/<app>_iOS/Info.plist` and add:

```xml
<key>NSAppTransportSecurity</key>
<dict>
  <key>NSAllowsArbitraryLoads</key><true/>
</dict>
<key>NSLocalNetworkUsageDescription</key>
<string>ACP UI connects to ACP agents you configure, including agents on your local network.</string>
```

Build and install via Xcode (`.xcworkspace`), or run on a connected device:

```sh
npm run tauri ios dev
```

iOS doesn't ship a binary today because it requires per-developer signing and an Apple Developer Program membership.

## 🔗 Links

- [Agent Client Protocol](https://agentclientprotocol.com/)
- [Tauri Documentation](https://tauri.app/)

## 📄 License

MIT License
