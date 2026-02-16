export const name = "commit"
export const description = "Stage changes and create a git commit with a descriptive message"

export async function run() {
  return `Review the current git status and staged changes, then create a well-structured commit.

Steps:
1. Run \`git status\` to see all changed, staged, and untracked files.
2. Run \`git diff\` to review unstaged changes. Run \`git diff --staged\` if files are already staged.
3. Stage the relevant files with \`git add <files>\`. Do NOT stage:
   - .env files or files containing secrets/API keys
   - node_modules/, dist/, build/ directories
   - Large binary files or generated files
4. Write a commit message following Conventional Commits format:
   - feat: new feature or capability
   - fix: bug fix
   - refactor: code restructuring without behavior change
   - docs: documentation changes
   - style: formatting, whitespace, semicolons
   - test: adding or updating tests
   - chore: build process, dependencies, tooling
   Format: <type>(<optional scope>): <short description>
   Example: feat(auth): add JWT token refresh logic
5. Run \`git commit -m "<message>"\` to create the commit.
6. Show the result with \`git log --oneline -3\`.

Important:
- Keep the commit focused on a single logical change.
- If there are unrelated changes, create separate commits.
- The commit message subject should be under 72 characters.
- Use imperative mood: "add feature" not "added feature".`
}
