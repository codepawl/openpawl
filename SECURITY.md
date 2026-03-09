# Security Policy

TeamClaw is a Node.js / TypeScript application that orchestrates AI agents using LangGraph, OpenClaw, and optional ChromaDB. This document explains how we handle security and how to report issues responsibly.

## Supported Versions

TeamClaw is currently in early development (pre‑1.0). We only provide security fixes for the latest minor version on the default branch.

| Version | Status              |
| ------: | ------------------- |
| 0.1.x   | Supported           |
| < 0.1   | Not supported       |

Security patches are generally released against:

- The `main` branch
- The latest published `0.1.x` version on npm (if applicable)

If you are running a fork or significantly modified version, you are responsible for backporting security fixes.

## Reporting a Vulnerability

If you believe you have found a security vulnerability in TeamClaw:

1. **Do not open a public GitHub issue or PR describing the vulnerability.**
2. **Submit a private report instead:**
   - Use GitHub’s **“Report a vulnerability”** workflow for this repository (if available), which creates a private security advisory with the maintainers.
   - If that is not available, contact the maintainers using the contact information listed in the repository or owner profile and mention that your report is security‑sensitive.

When reporting, please include as much detail as possible:

- A clear description of the issue and its potential impact
- Steps to reproduce (including sample configuration, commands, and any relevant logs with secrets redacted)
- The version/commit you tested, your Node.js version, and OS
- Any suggested fixes or mitigations, if you have them

### Our Commitment and Disclosure Process

- We will **acknowledge your report within 7 calendar days** whenever possible.
- We will **investigate and provide a follow‑up within 14 calendar days**, which may include:
  - Confirmation of the vulnerability and an estimated timeline for a fix
  - Request for additional information
  - Explanation if we determine the issue is out of scope or not a vulnerability
- Once a fix is ready and released, we may publish a security advisory with:
  - A description of the issue and affected versions
  - The severity (e.g. CVSS score if applicable)
  - Mitigation and upgrade instructions

We prefer to **coordinate a responsible disclosure timeline** with you so users have time to upgrade before full technical details are widely shared.

## Security Best Practices for Deployers

When deploying or running TeamClaw in your own environment:

- **Keep dependencies and runtime up to date**
  - Use **Node.js ≥ 20** as required by the project.
  - Regularly update using `pnpm` and review dependency changelogs and security advisories.
- **Protect secrets and configuration**
  - Use `.env` or equivalent mechanisms as described in `.env.example`.
  - Never commit real API keys, tokens, or credentials to the repository or share them in bug reports.
- **Secure external services**
  - Restrict access to OpenClaw, ChromaDB, and any other backing services to trusted networks (e.g. localhost, VPN, or internal subnets).
  - Apply authentication and TLS where applicable.
- **Harden your deployment environment**
  - Run TeamClaw with least‑privilege accounts and minimal filesystem permissions.
  - Prefer containerized or sandboxed deployments where appropriate.
  - Monitor logs for unusual activity and configure rate‑limiting or other controls at your ingress layer if exposing endpoints publicly.

## Out of Scope

The following are generally considered out of scope for this project’s security policy:

- Vulnerabilities in third‑party dependencies that have not yet published a fix (though we may still track and patch them once available).
- Issues requiring physical access, social engineering, or attacks against infrastructure not controlled by this project (e.g. your cloud provider, GitHub itself, or OpenClaw/ChromaDB installations not configured by this repository).
- Misconfigurations in your own deployment (firewalls, Kubernetes, CI/CD, etc.) unrelated to defects in TeamClaw’s code.

If you are unsure whether something is in scope, we still encourage you to submit a private report; we will let you know how we classify it.
