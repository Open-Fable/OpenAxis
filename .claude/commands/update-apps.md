# Update Upstream Apps

Update all 3 apps to their latest upstream versions:

1. Run `bash scripts/update.sh`
2. Run `npm run check:selectors` to verify overrides still work
3. Report any broken selectors or build failures
4. If selectors broke, suggest fixes for the affected override files
