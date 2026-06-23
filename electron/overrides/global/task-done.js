/*
 * OpenAxis — shared task completion detector factory
 *
 * Exposes window.__openaxisTaskDone(selector, source) for per-app task-done
 * scripts to call with their own busy-state selector and source name.
 */
(function () {
  if (window.__openaxisTaskDone) return;

  window.__openaxisTaskDone = function (selector, source) {
    if (!window.openaxis || !window.openaxis.notifyTaskDone) return;
    if (window.__OPENAXIS_TASK_DONE_INJECTED__) return;
    window.__OPENAXIS_TASK_DONE_INJECTED__ = true;

    var POLL_MS = 1500;
    var MIN_RUN_MS = 2000;
    var COOLDOWN_MS = 5000;

    var sawIdle = false;
    var runningSince = 0;
    var lastNotifiedAt = 0;

    setInterval(function () {
      var busy = !!document.querySelector(selector);

      if (busy) {
        if (sawIdle && runningSince === 0) runningSince = Date.now();
        return;
      }

      if (runningSince !== 0) {
        var ranFor = Date.now() - runningSince;
        runningSince = 0;
        if (ranFor >= MIN_RUN_MS && Date.now() - lastNotifiedAt >= COOLDOWN_MS) {
          lastNotifiedAt = Date.now();
          window.openaxis.notifyTaskDone(source);
        }
      }
      sawIdle = true;
    }, POLL_MS);
  };
})();
