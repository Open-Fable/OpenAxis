# Add Override

Create a new CSS or JS override for one of the apps.

Arguments: $ARGUMENTS (format: "<app-name> <override-name> <css|js>")

Steps:
1. Create the file in `electron/overrides/<app-name>/<override-name>.<ext>`
2. Register it in `electron/overrides/index.json` (enabled by default)
3. Use semantic selectors (data-*, aria-*, role, id) — avoid utility classes
4. For JS overrides: use MutationObserver for SPA route changes
5. NEVER include secrets in the override file
6. Run `npm run check:selectors` to verify the selectors target real elements
