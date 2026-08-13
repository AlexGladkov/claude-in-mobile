# claude-in-mobile (compatibility shim)

`claude-in-mobile` was **renamed to [`mcp-devices`](https://www.npmjs.com/package/mcp-devices)** in 4.0.

This package is a thin compatibility shim so the old name keeps working and
updating. It depends on `mcp-devices` and forwards the `claude-in-mobile`
command to it. You don't have to change anything — but the canonical name going
forward is `mcp-devices`:

```sh
npm i -g mcp-devices        # or keep using: npm i -g claude-in-mobile
brew install mcp-devices    # or keep using: brew upgrade claude-in-mobile
```

Both the `mcp-devices` and `claude-in-mobile` commands are available after
install and behave identically.
