# ACP UI

A browser client for the [Agent Client Protocol (ACP)](https://agentclientprotocol.com/). It connects to remote ACP-compatible agents over WebSocket and provides chat, sessions, permissions, model/mode selection, authentication prompts, and a traffic monitor.

![ACP UI Screenshot](assets/screenshot.png)

## Try It

Open [https://acp-ui.github.io/](https://acp-ui.github.io/) and connect to a remote ACP agent over WebSocket.

Pages served over HTTPS can only open `wss://` URLs due to browser mixed-content rules. For LAN `ws://` access, run the app locally with `npm run dev` or `npm run preview`, or expose the agent through a `wss://` tunnel.

## Features

- Remote ACP agents over `ws://` / `wss://`
- Browser persistence with `localStorage`
- Session creation, resume, and management
- Markdown chat rendering and tool call visualization
- Permission approval dialog
- Agent modes, slash commands, and model picker
- Authentication method selection
- ACP traffic monitor
- Foreground reconnect after tab visibility or network changes

## Configuration

Agent configuration is stored in browser `localStorage` under the key `acp-ui:agents` and is managed through the Settings dialog.

Example remote agent:

```json
{
  "agents": {
    "Copilot CLI (remote)": {
      "transport": "websocket",
      "url": "wss://acp.example.com/v1"
    }
  }
}
```

Filesystem RPCs (`fs/read_text_file`, `fs/write_text_file`) are not available in the browser app. The client advertises those capabilities as `false`, and any incoming `fs/*` request is rejected with JSON-RPC `-32601 Method not found`. For remote agents, the working directory path is interpreted on the agent host.

## Expose A Local Agent

The browser cannot spawn local stdio agents directly. Use a bridge such as [`@rebornix/stdio-to-ws`](https://www.npmjs.com/package/@rebornix/stdio-to-ws):

```sh
npx @rebornix/stdio-to-ws "copilot --acp" --port 3000 --persist --grace-period -1
```

Then add a WebSocket agent in ACP UI with a URL such as `ws://localhost:3000/` when running locally, or `wss://...` when using the hosted HTTPS app.

For public access, pair the bridge with [Microsoft Dev Tunnels](https://learn.microsoft.com/en-us/azure/developer/dev-tunnels/):

```sh
npx @rebornix/stdio-to-ws "copilot --acp" --port 3000 --persist --grace-period -1
devtunnel host -p 3000
```

Use the printed tunnel URL with `https://` replaced by `wss://`.

## Development

### Prerequisites

- [Node.js](https://nodejs.org/) 18+

### Setup

```sh
npm install
npm run dev
```

### Production Build

```sh
npm run build
npm run preview
```

The production bundle is emitted to `dist/`.

## Links

- [Agent Client Protocol](https://agentclientprotocol.com/)

## License

MIT License
