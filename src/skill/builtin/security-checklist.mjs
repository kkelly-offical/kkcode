export const name = "security-checklist"
export const description = "Security review checklist: OWASP Top 10, dependency audit, secret management, authentication"

export async function run(ctx) {
  const scope = (ctx.args || "").trim()

  return `# Security Review Checklist
${scope ? `\nScope: ${scope}\n` : ""}
Run through each category below. For each item, check the codebase and report findings.

## 1. Injection (OWASP A03)
- [ ] SQL queries use parameterized statements (never string concatenation)
- [ ] NoSQL queries avoid operator injection (\`$gt\`, \`$ne\` in user input)
- [ ] Shell commands avoid user input (or use \`execFile\` with explicit args, never \`exec\` with template strings)
- [ ] LDAP queries are properly escaped
- [ ] Path traversal: \`path.resolve\` + verify result is within allowed directory

## 2. Authentication (OWASP A07)
- [ ] Passwords hashed with bcrypt/argon2 (NOT MD5/SHA1/SHA256)
- [ ] Rate limiting on login endpoint (e.g., 5 attempts per minute)
- [ ] Session/JWT expires (access: 15min, refresh: 7d max)
- [ ] Password reset tokens are single-use and time-limited
- [ ] Multi-factor authentication available for sensitive operations

## 3. Access Control (OWASP A01)
- [ ] Every endpoint checks authorization (not just authentication)
- [ ] No IDOR: users cannot access other users' resources by changing ID
- [ ] Admin endpoints require admin role verification
- [ ] CORS configured with explicit allowed origins (not \`*\` in production)
- [ ] File uploads validate type, size, and scan for malware

## 4. Sensitive Data (OWASP A02)
- [ ] HTTPS enforced (HSTS header set)
- [ ] Sensitive data encrypted at rest (database, backups)
- [ ] PII never logged (emails, passwords, tokens, SSN)
- [ ] API responses don't leak internal errors or stack traces
- [ ] Cookies: HttpOnly, Secure, SameSite=Strict/Lax

## 5. Secrets Management
- [ ] No hardcoded API keys, passwords, or tokens in source code
- [ ] \`.env\` files listed in \`.gitignore\`
- [ ] Secrets loaded from environment variables or secret manager
- [ ] Different secrets for dev/staging/production
- [ ] Run: \`grep -rn "password\\|secret\\|api.key\\|token" --include="*.{js,ts,py,go}" .\`

## 6. Dependencies
- [ ] Run \`npm audit\` / \`pip audit\` / \`cargo audit\` / \`go mod tidy\`
- [ ] No critical/high severity vulnerabilities unresolved
- [ ] Lock file committed and up to date
- [ ] No deprecated packages with known CVEs
- [ ] Dependabot or Renovate configured for automated updates

## 7. XSS Prevention (OWASP A03)
- [ ] User input escaped before rendering in HTML
- [ ] No \`dangerouslySetInnerHTML\` / \`v-html\` with user content
- [ ] No \`eval()\`, \`new Function()\`, or \`innerHTML\` with user data
- [ ] Content-Security-Policy header set
- [ ] SVG uploads sanitized (can contain scripts)

## 8. CSRF Protection
- [ ] State-changing requests require CSRF token
- [ ] SameSite cookie attribute set
- [ ] Custom headers required for API calls (e.g., X-Requested-With)

## 9. Infrastructure
- [ ] Docker containers don't run as root
- [ ] No secrets in Dockerfile or docker-compose.yml
- [ ] CI/CD secrets stored in platform secret manager (not in config files)
- [ ] Production: debug mode disabled, verbose errors disabled
- [ ] Logging: audit trail for auth events, data access, admin actions

## 10. Summary Template

After review, fill in:
- **Critical Issues**: (must fix before deploy)
- **High Issues**: (fix within this sprint)
- **Medium Issues**: (plan to fix)
- **Low Issues**: (nice to have)
- **Overall Risk**: LOW / MEDIUM / HIGH / CRITICAL`
}
