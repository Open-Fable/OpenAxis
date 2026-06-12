/*
 * OpenHub → Open-Design — task completion config
 *
 * Activates the shared task-done detector with Open-Design's generation theater.
 */
(function () {
  if (window.__openhubTaskDone) {
    window.__openhubTaskDone('[data-phase="running"]', "design");
  }
})();
