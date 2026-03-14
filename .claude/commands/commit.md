---
allowed-tools: Bash(git:*), Read, Grep, Glob
description: Analyze changes and create a Conventional Commits style commit
---

# Git Commit

Create a git commit with an auto-generated Conventional Commits message.

## Steps

1. Run the following commands in parallel to understand the current state:
   - `git status` to see untracked and modified files (never use `-uall` flag)
   - `git diff` and `git diff --staged` to see unstaged and staged changes
   - `git log --oneline -10` to check recent commit message style

2. Analyze all changes and draft a commit message:
   - Use Conventional Commits format: `type(scope): description`
   - Types: `feat`, `fix`, `chore`, `ci`, `docs`, `refactor`, `test`, etc.
   - Scope is optional: `chore(deps):`, `feat(viewer):`, etc.
   - Write the message in English
   - Keep the first line concise (under 72 characters)
   - Add a body if the changes need more explanation
   - Do NOT commit files that likely contain secrets (`.env`, credentials, etc.)

3. Stage relevant files using `git add` with specific file names (avoid `git add -A` or `git add .`)

4. Create the commit using a HEREDOC for the message:
   ```
   git commit -m "$(cat <<'EOF'
   type(scope): description

   Optional body explaining why.

   Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
   EOF
   )"
   ```

5. Run `git status` after the commit to verify success.

## Important Rules

- NEVER amend existing commits — always create a new commit
- NEVER push to remote unless explicitly asked
- NEVER skip hooks (no `--no-verify`)
- NEVER use `git add -A` or `git add .` — add specific files
- If pre-commit hook fails, fix the issue and create a NEW commit (do not amend)
- If there are no changes to commit, inform the user and do nothing
