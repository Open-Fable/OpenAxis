/*
 * OpenAxis → OpenWork — task completion config
 *
 * Activates the shared task-done detector with OpenWork's busy-state selector:
 * the Loader2 spinner wrapped in an aria-labelled span.
 */
(function () {
  if (window.__openaxisTaskDone) {
    window.__openaxisTaskDone("span[aria-label] > svg.animate-spin", "work");
  }
})();
