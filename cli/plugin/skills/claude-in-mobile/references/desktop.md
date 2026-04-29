# Desktop-Only Commands

Commands exclusive to the Desktop platform. Require `--companion-path` flag or `MOBILE_TOOLS_COMPANION` env var.

---

### get-window-info

List all open desktop windows with their IDs, titles, positions, and sizes.

```bash
claude-in-mobile get-window-info --companion-path /path/to/companion
```

---

### focus-window

Bring a desktop window to front by its ID (from `get-window-info`).

```bash
claude-in-mobile focus-window "window-id" --companion-path /path/to/companion
```

---

### resize-window

Resize a desktop window to specified width and height.

```bash
claude-in-mobile resize-window "window-id" 800 600 --companion-path /path/to/companion
```

---

### launch-desktop-app

Launch a desktop application by path.

```bash
claude-in-mobile launch-desktop-app /path/to/app --companion-path /path/to/companion
```

---

### stop-desktop-app

Stop a running desktop application by name.

```bash
claude-in-mobile stop-desktop-app "AppName" --companion-path /path/to/companion
```

---

### get-performance-metrics

Get CPU/memory usage metrics for running desktop applications.

```bash
claude-in-mobile get-performance-metrics --companion-path /path/to/companion
```

---

### get-monitors

List connected monitors with resolutions and positions.

```bash
claude-in-mobile get-monitors --companion-path /path/to/companion
```
