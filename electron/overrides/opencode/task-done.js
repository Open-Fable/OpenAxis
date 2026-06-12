/*
 * OpenHub → OpenCode — task completion config
 *
 * Activates the shared task-done detector with OpenCode's working spinner.
 */
(function () {
  if (window.__openhubTaskDone) {
    window.__openhubTaskDone('[data-component="spinner"]', "code");
  }
})();
