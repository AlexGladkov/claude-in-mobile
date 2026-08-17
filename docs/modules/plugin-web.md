# Platform Plugin: Web

Automate web browsers via Chrome DevTools Protocol (CDP). Supports Chrome, Chromium, Edge, Brave, and other Chromium-based browsers.

---

## Overview

Full web automation: navigate, evaluate JavaScript, interact with DOM, take screenshots, inspect network requests, manage cookies & tabs, and monitor performance. Browser is launched on-demand.

## When to use it

- **Web app testing:** Automate form submission, multi-page flows, user interactions
- **Visual regression:** Compare page screenshots across builds/environments
- **Network inspection:** Monitor requests/responses, validate API calls
- **Performance testing:** Measure page load times, resource sizes, render performance
- **Accessibility audit:** Check web app for WCAG compliance
- **JavaScript evaluation:** Run custom JS for complex assertions or data extraction

---

## Prerequisites

### Chrome/Chromium (required)

A Chromium-based browser must be available on the system. Browser is launched on-demand; no pre-launch needed.

**Supported browsers:**
- Google Chrome
- Chromium (open source)
- Brave
- Edge (Chromium-based)
- Other Chromium-based browsers

**Check status:**

```sh
mcp-devices doctor web
```

This verifies that a Chromium browser is discoverable and launchable.

**Install (if needed):**

```sh
# macOS (Homebrew)
brew install chromium

# Linux (Ubuntu/Debian)
sudo apt-get install chromium-browser

# Windows (Chocolatey)
choco install chromium

# macOS (Google Chrome instead)
brew install --cask google-chrome
```

---

## Install & Enable

### 1. Install npm package

```sh
npm i -g @mcp-devices/plugin-web@dev
```

### 2. Enable the platform

```sh
mcp-devices install web
```

### 3. Restart MCP server

Web platform loads on next server start.

### 4. Verify

```sh
mcp-devices platforms
# Output: "web: enabled"

mcp-devices doctor web
# Checks Chrome/Chromium availability
```

---

## Tools & Actions

Web platform uses core modules + `browser` (web-specific):

| Module | Key Actions | Use |
|--------|-------------|-----|
| **browser** (web-specific) | `navigate` (URL), `evaluate` (JS), `tabs`, `cookies`, `network`, `console` | Web automation via Chrome DevTools Protocol |
| **input** | `tap` (click), `text` (type), `key`, `swipe` | Mouse/keyboard input on web page |
| **ui** | `tree` (DOM), `find` (element search), `find_tap` (click), `assert_visible` | DOM inspection & assertions |
| **screen** | `capture`, `annotate` | Screenshots |
| **device** | `list`, `set_target`, `enable_module` | Device/tab management |
| **flow** | `batch`, `run`, `parallel` | Multi-step automation |

Optional: `recorder`, `performance`, `visual`, `accessibility`, `autopilot`.

### Example invocations (action syntax)

```json
// Navigate to URL
browser(action: 'navigate', url: 'https://example.com')

// Evaluate JavaScript and return result
browser(action: 'evaluate', script: 'document.title')
→ { value: 'Example Domain' }

// Get all tabs
browser(action: 'tabs')
→ { tabs: [{ url: 'https://example.com', title: 'Example' }] }

// Get cookies
browser(action: 'cookies', url: 'https://example.com')
→ { cookies: [{ name: 'session_id', value: '...' }] }

// Inspect network requests
browser(action: 'network')
→ { requests: [{ method: 'GET', url: 'https://...', status: 200 }] }

// Find element by text and click
ui(action: 'find_tap', text: 'Sign In')

// Type in focused input
input(action: 'text', text: 'user@example.com')

// Take screenshot
screen(action: 'capture', preset: 'low')

// Execute console command
browser(action: 'console', command: 'window.localStorage.getItem("user")')
```

---

## Example Workflows

### Workflow 1: Automate web form submission + verify

```
// 1. Navigate to form
browser(action: 'navigate', url: 'https://myapp.com/signup')

// 2. Wait for page to load
ui(action: 'wait', text: 'Sign Up', timeout: 5000)

// 3. Fill form fields
ui(action: 'find_tap', placeholder: 'Email')
input(action: 'text', text: 'test@example.com')

ui(action: 'find_tap', placeholder: 'Password')
input(action: 'text', text: 'SecurePassword123')

// 4. Submit form
ui(action: 'find_tap', text: 'Create Account')

// 5. Verify success (redirect to home)
ui(action: 'wait', text: 'Dashboard', timeout: 3000)

// 6. Verify URL changed
browser(action: 'evaluate', script: 'window.location.pathname')
→ { value: '/dashboard' }
```

### Workflow 2: Network request inspection

```
// 1. Navigate to app
browser(action: 'navigate', url: 'https://myapi.example.com')

// 2. Trigger API call (e.g., click button)
ui(action: 'find_tap', text: 'Fetch Data')

// 3. Wait a moment for requests
system(action: 'wait', seconds: 1)

// 4. Inspect network log
browser(action: 'network')
→ {
     requests: [
       { method: 'GET', url: 'https://api.example.com/users', status: 200, size: 2048 },
       { method: 'GET', url: 'https://api.example.com/posts', status: 200, size: 5120 }
     ]
   }

// 5. Verify API response
browser(action: 'evaluate', script: 'fetch("/api/users").then(r => r.json()).then(d => d.length)')
→ { value: 42 }  // 42 users returned
```

### Workflow 3: Visual regression testing

```
// 1. Navigate to page
browser(action: 'navigate', url: 'https://myapp.com/pricing')

// 2. Wait for render
system(action: 'wait', seconds: 2)

// 3. Enable visual module
device(action: 'enable_module', module: 'visual')

// 4. Capture low-quality screenshot (faster)
screen(action: 'capture', preset: 'low')

// 5. Create baseline (first run)
visual(action: 'baseline', name: 'pricing-page-current')

// 6. On next build, compare
screen(action: 'capture', preset: 'low')
visual(action: 'compare', baseline: 'pricing-page-current')
→ { match: true } or { match: false, diff: '...' }
```

### Workflow 4: JavaScript evaluation for data extraction

```
// 1. Navigate to page
browser(action: 'navigate', url: 'https://example.com/products')

// 2. Wait for product list
ui(action: 'wait', text: 'Product', timeout: 5000)

// 3. Extract product names via JS
browser(action: 'evaluate', script: 'Array.from(document.querySelectorAll(".product-name")).map(el => el.textContent)')
→ { value: ['Product A', 'Product B', 'Product C'] }

// 4. Extract prices
browser(action: 'evaluate', script: 'Array.from(document.querySelectorAll(".product-price")).map(el => el.textContent)')
→ { value: ['$9.99', '$19.99', '$29.99'] }

// 5. Evaluate complex expression
browser(action: 'evaluate', script: 'localStorage.getItem("cartCount")')
→ { value: '3' }
```

### Workflow 5: Cookie & session management

```
// 1. Set a cookie
browser(action: 'cookies', action: 'set', name: 'user_id', value: '12345', url: 'https://myapp.com')

// 2. Navigate with cookie present
browser(action: 'navigate', url: 'https://myapp.com/dashboard')

// 3. Verify cookie persists
browser(action: 'cookies', url: 'https://myapp.com')
→ { cookies: [{ name: 'user_id', value: '12345' }, ...] }

// 4. Verify app recognized session
ui(action: 'assert_visible', text: 'Welcome, User 12345')
```

---

## Troubleshooting

| Problem | Cause | Solution |
|---------|-------|----------|
| "Chrome not found" | Browser not installed or not in PATH | Install Chrome or Chromium; ensure it's in PATH |
| "Port already in use" | Another Chrome instance on same debug port | Close other Chrome windows or use different port |
| "Element not found" | Element text/selector is different or dynamic | Use `ui(action: 'tree')` to inspect DOM or use JS evaluation |
| "Navigation timeout" | Page takes too long to load | Increase timeout: `ui(action: 'wait', ..., timeout: 10000)` |
| "Cookie not set" | Domain/path mismatch | Ensure cookie URL matches page URL |
| "JavaScript error" | Script has syntax error or references missing variables | Test JS in browser console first |

---

## Related Documentation

- [Modules & Tools Overview](./README.md) — Architecture, profiles, module visibility
- [Android Platform](./plugin-android.md) — Mobile web automation (via Android WebView)
- [Built-in Tools Reference](./built-in-tools.md) — Full action catalog for all modules
- [Chrome DevTools Protocol](https://chromedevtools.github.io/devtools-protocol/) — Official CDP reference
