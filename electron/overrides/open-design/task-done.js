/*
 * OpenAxis → Open-Design — task completion config
 *
 * Activates the shared task-done detector with Open-Design's generation theater.
 */
(function () {
  if (window.__openaxisTaskDone) {
    window.__openaxisTaskDone('[data-phase="running"]', "design");
  }
})();
