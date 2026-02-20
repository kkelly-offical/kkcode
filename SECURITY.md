# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| x.x.x   | :white_check_mark: |

## Reporting a Vulnerability

If you discover a security vulnerability in kkcode, please report it responsibly.

**Do NOT open a public issue.**

Instead, please email: **drliuxk@ecupl.edu.cn** (or replace with your actual contact)

### What to include

- Description of the vulnerability
- Steps to reproduce
- Affected version(s)
- Potential impact

### Response timeline

- **Acknowledgment**: within 48 hours
- **Initial assessment**: within 7 days
- **Fix or mitigation**: depends on severity, typically within 30 days

### Scope

The following are in scope:
- Command injection via tool inputs
- Arbitrary file read/write outside workspace
- Credential or API key leakage
- Permission bypass (e.g., executing tools in restricted modes)

The following are out of scope:
- Vulnerabilities in third-party dependencies (report upstream)
- Issues requiring physical access to the machine
- Social engineering attacks

## Responsible Disclosure

We appreciate security researchers who follow responsible disclosure. Contributors who report valid vulnerabilities will be credited in release notes (unless they prefer anonymity).
