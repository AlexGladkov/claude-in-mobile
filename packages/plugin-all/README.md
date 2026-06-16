# @claude-in-mobile/plugin-all

Meta-package that depends on every separately-packaged claude-in-mobile
platform plugin (aurora, web, desktop). Install it to get all packaged
platforms at once:

```sh
npm i -g @claude-in-mobile/plugin-all
claude-in-mobile install all
```

Note: `android` and `ios` ship inside the base `claude-in-mobile` package
(not yet separately packaged), so they need no extra install — just
`claude-in-mobile install android ios`.
