# Contributing to kkcode

[中文版 / Chinese Version](CONTRIBUTING.zh-CN.md)

Thank you for your interest in contributing to kkcode! This guide will help you get started.

## How to Contribute

### Reporting Issues

Everyone is welcome to [open an issue](https://github.com/kkelly-offical/kkcode/issues/new/choose). We provide templates for:

- **Bug Report** — Found a bug? Let us know.
- **Feature Request** — Have an idea for a new feature?
- **Enhancement** — Want to improve an existing feature?
- **Question** — Need help or have a question?

### Pull Requests

We welcome pull requests from the community. However, please note:

- All PRs require **review and approval** from a team member before merging.
- For large changes, please open an issue first to discuss your approach.
- Keep PRs focused — one concern per PR.

## Development Setup

### Prerequisites

- **Node.js** >= 22
- **pnpm** (recommended) or npm

### Getting Started

```bash
git clone https://github.com/kkelly-offical/kkcode.git
cd kkcode
npm install
npm run start
```

### Running Tests

```bash
npm test
npm run test:e2e
```

## Code Style

- Pure ESM (`.mjs` files) — no transpilation
- No TypeScript — plain JavaScript with JSDoc where needed
- Minimal dependencies — think twice before adding a new package
- Functions over classes where possible
- Descriptive variable names, no abbreviations

## Commit Convention

We follow a simple commit message convention:

```
<type>: <short description>

[optional body]
```

**Types:**

| Type | Description |
|------|-------------|
| `feat` | New feature |
| `fix` | Bug fix |
| `enhance` | Improvement to existing feature |
| `refactor` | Code refactoring (no behavior change) |
| `docs` | Documentation |
| `test` | Tests |
| `chore` | Build, CI, tooling |

**Examples:**

```
feat: add websearch tool
fix: prevent file lock deadlock in parallel writes
docs: update LongAgent section in README
```

## Branch Strategy

- `main` — stable release branch, protected
- Feature branches: `feat/<name>`, `fix/<name>`, `enhance/<name>`
- Create your branch from `main`, submit PR back to `main`

## Project Structure

See [README.md — Project Structure](README.md#项目结构) for a detailed overview.

## Security

If you discover a security vulnerability, **do NOT open a public issue**. Please follow the [Security Policy](SECURITY.md).

## License

By contributing, you agree that your contributions will be licensed under the [GPL-3.0 License](LICENSE).
