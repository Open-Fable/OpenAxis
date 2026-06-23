/*
 * OpenAxis → OpenCode — task completion config
 *
 * Activates the shared task-done detector with OpenCode's working spinner.
 */
(function () {
  if (window.__openaxisTaskDone) {
    window.__openaxisTaskDone('[data-component="spinner"]', "code");
  }
})();
