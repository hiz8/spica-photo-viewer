---
allowed-tools: Bash(gh:*), Bash(git:*), Read, Grep, Glob
description: Create a GitHub Pull Request with auto-generated title and description
---

# Create Pull Request

Create a GitHub Pull Request with an auto-generated title and description based on branch changes.

## Steps

1. Run the following commands in parallel to understand the current state:
   - `git status` to check for uncommitted changes (never use `-uall` flag)
   - `git branch --show-current` to get the current branch name
   - `git log --oneline -10` to see recent commits
   - `git remote -v` to verify the remote

2. Determine the base branch (default: `main`, or use the user-specified base branch). Run the following in parallel:
   - `git log <base-branch>..HEAD --oneline` to see all commits on this branch
   - `git diff <base-branch>...HEAD --stat` to see a summary of changed files

3. If there are uncommitted changes (unstaged or staged), warn the user and STOP — do not create a PR with uncommitted work.

4. If the current branch is `main`, warn the user and STOP — do not create a PR from the main branch.

5. Ensure the branch is pushed to the remote:
   - If there is no upstream tracking branch, run `git push -u origin <current-branch>`
   - If local is ahead of remote, run `git push`

6. Analyze all commits and changes to draft a PR title and body:
   - PR title: concise, under 70 characters, in English
   - PR body format:
     ```
     ## Summary
     <1-3 bullet points describing the changes>

     ## Test plan
     <Bulleted checklist of testing steps>

     🤖 Generated with [Claude Code](https://claude.com/claude-code)
     ```

7. Create the PR using `gh pr create`:
   ```
   gh pr create --base <base-branch> --title "the pr title" --body "$(cat <<'EOF'
   ## Summary
   - ...

   ## Test plan
   - [ ] ...

   🤖 Generated with [Claude Code](https://claude.com/claude-code)
   EOF
   )"
   ```

8. Output the created PR URL to the user.

## Important Rules

- NEVER force push (`--force`, `--force-with-lease`)
- NEVER create a PR from the `main` branch
- NEVER create a PR when there are uncommitted changes
- ALWAYS write the title and body in English
- Base branch defaults to `main` — use user-specified base if provided
- If `gh` CLI is not authenticated or not installed, inform the user and stop
