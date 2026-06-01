// This file is loaded by samples/embedded-browser/index.html and exists so
// Claude can verify the embedded-browser MCP tools work end-to-end:
//   * `window.appState` — `browser_eval` should return it
//   * `window.greet(name)` — proves function-call eval works (and awaitPromise)
//   * Three console messages at startup — `browser_console_read` should see them
//   * Clicking #incr — `browser_eval` on document.getElementById('incr').click()
//     should increment the counter, observable both in the DOM and in appState.

(function () {
  const state = {
    startedAt: new Date().toISOString(),
    user: { name: 'Sample', role: 'tester' },
    counter: 0,
    history: []
  };
  window.appState = state;

  // Exposed for browser_eval to verify await + return value plumbing.
  window.greet = function greet(name) {
    return new Promise(function (resolve) {
      setTimeout(function () { resolve('hello ' + name); }, 50);
    });
  };

  const countEl = document.getElementById('count');
  const stateEl = document.getElementById('state-dump');
  const logEl = document.getElementById('log');
  const btn = document.getElementById('incr');

  function renderState() {
    stateEl.textContent = JSON.stringify(state, null, 2);
    countEl.textContent = String(state.counter);
  }

  function localLog(kind, text) {
    const li = document.createElement('li');
    li.className = kind;
    li.textContent = '[' + kind + '] ' + text;
    logEl.appendChild(li);
    while (logEl.children.length > 30) logEl.removeChild(logEl.firstChild);
  }

  btn.addEventListener('click', function () {
    state.counter += 1;
    state.history.push({ at: Date.now(), counter: state.counter });
    renderState();
    console.log('counter is now', state.counter);
    localLog('log', 'counter is now ' + state.counter);
  });

  renderState();

  // Three startup messages at the three console levels Claude is most likely
  // to want to read separately. browser_console_read with grep:'error' should
  // pick out the third one specifically.
  console.log('app loaded — appState ready');
  localLog('log', 'app loaded');
  console.warn('this is a warning (expected, harmless)');
  localLog('warn', 'this is a warning');
  console.error('this is an error (expected, harmless)');
  localLog('error', 'this is an error');
})();
