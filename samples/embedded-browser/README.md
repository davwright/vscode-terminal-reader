# Embedded browser sample

A minimal page Claude can use to verify the `browser_*` MCP tools work
end-to-end. It has a counter button, exposes `window.appState`, defines
`window.greet(name)` (async), and emits three console messages at startup.

## Try it

In Claude (with this extension loaded and the MCP server connected):

1. **Open the page:**
   ```
   browser_open with file: "samples/embedded-browser/index.html"
   ```
2. **Read a property:**
   ```
   browser_eval with expression: "window.appState.user.name"
   ```
   Expected: `"Sample"`.
3. **Read recent console messages:**
   ```
   browser_console_read with tail: 10
   ```
   Expected: at least `app loaded`, the warning, and the error.
4. **Click the button three times, then read the counter:**
   ```
   browser_eval expression: "document.getElementById('incr').click()"   (3x)
   browser_eval expression: "window.appState.counter"
   ```
   Expected: `3`.
5. **Verify await/Promise plumbing:**
   ```
   browser_eval expression: "window.greet('Claude')"
   ```
   Expected: `"hello Claude"` (the controller defaults `awaitPromise: true`).
6. **Snapshot a piece of the DOM:**
   ```
   browser_query_selector with selector: "#count"
   ```
7. **Take a screenshot:**
   ```
   browser_screenshot
   ```
8. **Tear down:**
   ```
   browser_close
   ```

## What's intentionally NOT here

- No build step. Plain HTML + CSS + ES2017 JS.
- No bundler, no framework. Everything is inline-readable.
- No external assets — `logo.svg` is hand-written so the page works fully
  offline (file://).
