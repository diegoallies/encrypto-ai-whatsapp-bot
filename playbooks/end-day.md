# End of Work Day
> Summarize today's work: commits, hours billed, activity

Triggers: "end my day", "end my working day", "end work day", "end workday", "/endday"

Run the end-of-day work summary:

1. **Load config** from `worklog/config.json` - get the PSA repos list and activity watch repo path.

2. **Git pull all repos** - for each PSA repo, run `git pull --rebase` to get latest changes.

3. **Count today's commits** - for each repo, run:
   ```
   git log --oneline --since="midnight" --author="you@example.com" | wc -l
   ```
   Collect repo name + commit count.

4. **Check activity watch export** - go to the activity watch repo:
   - `git pull --rebase`
   - Check if there's a commit for today: `git log --oneline --since="midnight" | head -1`
   - If there's an export file for today, parse it to get total hours worked.
   - Look for files like `exports/YYYY-MM-DD.json` or similar.

5. **Calculate hours billed** - from activity watch data, sum up the productive time.

6. **Save to worklog** - create/append to `worklog/YYYY-MM-DD.md` with:
   ```
   # Work Log - YYYY-MM-DD

   ## Commits
   - psa-rest-services: X commits
   - psa-grower-vue-js: X commits
   - ...
   **Total: X commits**

   ## Hours Billed
   X.X hours (from ActivityWatch)

   ## Notes
   (any notes from the day)
   ```

7. **Send summary** - format a WhatsApp-friendly summary:
   ```
   Work day summary for [date]:
   - Commits: X total across Y repos
   - Hours billed: X.X hours
   - Top repo: [repo with most commits]
   ```

Keep the response concise and WhatsApp-friendly.
