export const name = "backend-patterns"
export const description = "Backend development patterns reference: API design, repository pattern, middleware, error handling, authentication"

export async function run(ctx) {
  const topic = (ctx.args || "").trim().toLowerCase()

  const sections = {
    api: `## API Design Patterns

### RESTful Conventions
- GET /resources — list (with pagination: ?page=1&limit=20)
- GET /resources/:id — get single
- POST /resources — create (return 201 + Location header)
- PUT /resources/:id — full replace
- PATCH /resources/:id — partial update
- DELETE /resources/:id — remove (return 204)

### Response Format
\`\`\`json
{
  "data": { ... },
  "meta": { "page": 1, "total": 42, "limit": 20 },
  "error": null
}
\`\`\`

### Error Responses
\`\`\`json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Email is required",
    "details": [{ "field": "email", "rule": "required" }]
  }
}
\`\`\`
Status codes: 400 validation, 401 unauthenticated, 403 unauthorized, 404 not found, 409 conflict, 422 unprocessable, 429 rate limited, 500 server error`,

    repository: `## Repository Pattern

Separate data access from business logic:
\`\`\`
Controller → Service → Repository → Database
\`\`\`

- **Repository**: handles queries, CRUD, caching. Returns domain objects.
- **Service**: business rules, validation, orchestration. Calls repositories.
- **Controller**: HTTP concerns only. Parses request, calls service, formats response.

Benefits: testable (mock repository in service tests), swappable storage, clear boundaries.`,

    middleware: `## Middleware Patterns

Execution order matters. Typical chain:
1. **CORS** — set access headers
2. **Request ID** — assign unique ID for tracing
3. **Logger** — log method, path, duration, status
4. **Rate limiter** — throttle by IP or API key
5. **Auth** — verify JWT/session, attach user to request
6. **Validation** — validate request body/params against schema
7. **Handler** — actual business logic
8. **Error handler** — catch errors, format response (always LAST)`,

    auth: `## Authentication Patterns

### JWT (Stateless)
- Access token (short-lived: 15min) + Refresh token (long-lived: 7d)
- Store refresh in httpOnly cookie, access in memory (NOT localStorage)
- Rotate refresh tokens on use (one-time use)

### Session (Stateful)
- Server-side session store (Redis for multi-server)
- Session ID in httpOnly, Secure, SameSite=Strict cookie
- Regenerate session ID after login (prevent fixation)

### OAuth 2.0
- Always validate \`state\` parameter (CSRF protection)
- Use PKCE for public clients (SPAs, mobile)
- Exchange code for tokens server-side (never client-side)`,

    error: `## Error Handling

### Layered Error Strategy
- **Repository**: throw typed errors (NotFoundError, ConflictError)
- **Service**: catch repo errors, add business context, re-throw
- **Controller/Middleware**: catch all, map to HTTP status, log, respond

### Custom Error Classes
\`\`\`javascript
class AppError extends Error {
  constructor(message, code, statusCode = 500) {
    super(message)
    this.code = code
    this.statusCode = statusCode
  }
}
class NotFoundError extends AppError {
  constructor(resource, id) {
    super(\`\${resource} \${id} not found\`, "NOT_FOUND", 404)
  }
}
\`\`\`

### Never expose internals
- Log full stack trace server-side
- Return sanitized message to client
- Never leak database errors, file paths, or config values`
  }

  if (topic && sections[topic]) {
    return sections[topic]
  }

  // Return overview with all sections
  const overview = Object.values(sections).join("\n\n---\n\n")
  return `# Backend Development Patterns

Use \`/backend-patterns <topic>\` for a specific section: api, repository, middleware, auth, error

---

${overview}`
}
