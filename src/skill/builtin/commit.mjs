export const name = "commit"
export const description = "Stage changes and create a git commit with a descriptive message using AI-powered git automation"

export async function run(args, context = {}) {
  const hasGitAuto = context.config?.git_auto?.enabled !== false
  
  return `Review the current git status and create a well-structured commit.

${hasGitAuto ? `🚀 Git Auto Mode Enabled
The AI can now use ghost commits (temporary snapshots) to safely manage changes before you finalize them.
` : `⚙️ Standard Mode
Consider enabling git_auto in your config for enhanced safety features.
`}

Steps:
1. Run \`git_info\` to understand the repository context.
2. Run \`git_status\` to see all changed, staged, and untracked files.
3. Review the changes to understand what needs to be committed.

${hasGitAuto ? `4. **IMPORTANT**: Before making any edits, create a ghost commit snapshot:
   \`git_snapshot\` - Creates a temporary snapshot you can restore later
   
5. After reviewing, if you need to make changes, the AI will:
   - First create an automatic snapshot (if git_auto.auto_snapshot is enabled)
   - Apply changes using \`edit\`, \`write\`, or \`git_apply_patch\`
   
6. If you're not satisfied with the changes:
   - Use \`git_list_snapshots\` to see available snapshots
   - Use \`git_restore\` with the snapshot_id to revert
   
7. When satisfied with the changes, guide the user to manually run:
   \`bash: git add <files> && git commit -m "<message>"\`
   Note: AI is forbidden from running git commit directly for security.` 
   
: `4. Stage the relevant files with manual git commands (AI cannot run git commit):
   - AI can suggest: \`bash: git add <files>\`
   - But user must manually run: \`git commit -m "<message>"\`
   
5. Note: AI is forbidden from executing git commit/push for security reasons.`}

Commit Message Format (Conventional Commits):
- feat: new feature or capability
- fix: bug fix
- refactor: code restructuring without behavior change
- docs: documentation changes
- style: formatting, whitespace, semicolons
- test: adding or updating tests
- chore: build process, dependencies, tooling

Format: <type>(<optional scope>): <short description>
Example: feat(auth): add JWT token refresh logic

Important:
- Keep the commit focused on a single logical change.
- If there are unrelated changes, create separate commits.
- The commit message subject should be under 72 characters.
- Use imperative mood: "add feature" not "added feature".

${hasGitAuto ? `Safety Features:
- Ghost commits are stored for 7 days then auto-cleaned
- Maximum 50 snapshots per repository
- Snapshots don't interfere with your normal git workflow
- Use \`git_cleanup\` to manually clean up expired snapshots` : ""}`
}
