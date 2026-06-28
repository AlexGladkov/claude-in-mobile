# Desktop-Only Commands

Commands exclusive to the Desktop platform. Require `--companion-path` flag or `MOBILE_TOOLS_COMPANION` env var.

---

### get-window-info

List all open desktop windows with their IDs, titles, positions, and sizes.

```bash
mcp-devices get-window-info --companion-path /path/to/companion
```

---

### focus-window

Bring a desktop window to front by its ID (from `get-window-info`).

```bash
mcp-devices focus-window "window-id" --companion-path /path/to/companion
```

---

### resize-window

Resize a desktop window to specified width and height.

```bash
mcp-devices resize-window "window-id" 800 600 --companion-path /path/to/companion
```

---

### launch-desktop-app

Launch a desktop application by path.

```bash
mcp-devices launch-desktop-app /path/to/app --companion-path /path/to/companion
```

---

### stop-desktop-app

Stop a running desktop application by name.

```bash
mcp-devices stop-desktop-app "AppName" --companion-path /path/to/companion
```

---

### get-performance-metrics

Get CPU/memory usage metrics for running desktop applications.

```bash
mcp-devices get-performance-metrics --companion-path /path/to/companion
```

---

### get-monitors

List connected monitors with resolutions and positions.

```bash
mcp-devices get-monitors --companion-path /path/to/companion
```
