# claude-in-mobile — all-in-one edition

`claude-in-mobile` is the **all-in-one edition of
[`mcp-devices`](https://www.npmjs.com/package/mcp-devices)**. It bundles the
mcp-devices engine plus every platform plugin (Android, iOS, Web, Desktop,
Aurora) and runs with **all platforms enabled by default** — install once and
everything works, no per-platform setup.

```sh
npm i -g claude-in-mobile     # everything in one package, all platforms ready
```

Prefer a slim base and install only the platforms you need? Use the modular
edition instead:

```sh
npm i -g mcp-devices
npm i -g @mcp-devices/plugin-android   # add platforms on demand
mcp-devices install android
```

Both editions ship the same engine and the same tools; they differ only in
whether platforms come bundled (`claude-in-mobile`) or on demand (`mcp-devices`).
The `claude-in-mobile` command sets `MCP_DEVICES_PLATFORMS=all` for you unless
you override it.
