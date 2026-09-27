# BreakPoint AI 🎯

> **Autonomous AI-Powered Security Engineering & Continuous Fuzzing Platform**  
> *Built for IBM Bob 2.0 / BreakPoint AI Hackathon*

[![Live Demo](https://img.shields.io/badge/Vercel-Live--Demo-000000?style=for-the-badge&logo=vercel&logoColor=white)](https://breakpoint-ai-dashboard.vercel.app)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-green?style=for-the-badge&logo=node.js)](https://nodejs.org/)
[![React](https://img.shields.io/badge/React-18-blue?style=for-the-badge&logo=react)](https://react.dev/)

---

## 📌 Executive Summary

**BreakPoint AI** is an autonomous security testing platform designed to discover, fuzz, and remediate high-risk API vulnerabilities before code reaches production. By pairing continuous red-teaming agents with Model Context Protocol (MCP) tooling and an interactive Command & Control (C2) dashboard, BreakPoint AI automatically stress-tests business logic, concurrency flaws, and authorization bypasses during active development and CI/CD pipelines.

---

## ✨ Core Features

* 📊 **Command & Control (C2) Dashboard:** Real-time visibility into active agent threat telemetry, attack surfaces, SSE log streaming, and automated merge confidence scoring.
* 🤖 **Autonomous Red-Team Fuzzer:** Generates stateful, high-entropy test vectors targeting concurrency gaps, edge cases, and dynamic API endpoints.
* ⚡ **MCP Server Integration:** Seamlessly connects with AI-native IDEs (Cursor, Windsurf, Claude Desktop) to enable direct natural-language auditing and threat simulations.
* 🔄 **Automated CI/CD Guardrails:** Integrates into GitHub Actions workflows to evaluate Pull Request merge risks and block critical vulnerability regressions automatically.
* 🛠️ **Developer-First CLI:** Simple, lightweight command-line suite for immediate local scanning, discovery, and test execution.

---

## 🏗️ Architecture & Tech Stack

```text
               ┌──────────────────────────────────────────────┐
               │         Command & Control Dashboard          │
               │            (React + Vite + SSE)              │
               └──────────────────────▲───────────────────────┘
                                      │ Live Telemetry
┌─────────────────────────┐    ┌──────┴──────┐    ┌─────────────────────────┐
│     Developer CLI       ├────► Core Engine ◄────┤   MCP Server (IDE)      │
│  (Node.js / Express)    │    │ (IBM Bob/   │    │  (Cursor/Claude Desktop)│
└─────────────────────────┘    │  watsonx)   │    └─────────────────────────┘
                               └──────┬──────┘
                                      │ Autonomous Fuzzing
                               ┌──────▼──────┐
                               │ Target Apps │
                               └─────────────┘

```

* **Frontend Dashboard:** React 18, Vite, Tailwind CSS, Recharts, Server-Sent Events (SSE).
* **CLI & Orchestration:** Node.js, Express, Axios.
* **Protocol & AI Integration:** Model Context Protocol (MCP), IBM watsonx AI / IBM Bob Orchestration.

---

## 🚀 Quickstart Guide

### 1. Prerequisites

* Node.js v18 or higher
* npm or yarn

### 2. Local Installation

```bash
# Clone the repository
git clone [https://github.com/aryavgulla/BreakPoint-AI.git](https://github.com/aryavgulla/BreakPoint-AI.git)
cd BreakPoint-AI

# Install CLI dependencies
cd cli
npm install

# Install Dashboard dependencies
cd ../dashboard/client
npm install

```

### 3. Running the Dashboard

```bash
# Start client dashboard
cd dashboard/client
npm run dev

```

Open [http://localhost:5173](http://localhost:5173?utm_source=gemini) in your browser to view the Command & Control UI.

---

## 💻 CLI Command Reference

Execute security audits and autonomous fuzzing directly from your terminal:

```bash
# Scan target project directory for endpoints and security surface area
npx breakpoint scan

# Trigger automated red-team fuzzing suite against defined target routes
npx breakpoint run-tests

# Launch local dashboard proxy listener
npx breakpoint dash

```

---

## 🔌 MCP Integration (Cursor / Claude Desktop)

To enable BreakPoint AI inside your IDE, add the server to your `.cursor/mcp.json` or Claude configuration:

```json
{
  "mcpServers": {
    "breakpoint-ai": {
      "command": "node",
      "args": ["/path/to/BreakPoint-AI/mcp-server/src/index.ts"]
    }
  }
}

```

Once linked, prompt your AI agent directly:

> *"@breakpoint-ai audit the /routes/transfer.js endpoint for race conditions and return a remediation patch."*

---

## 📂 Repository Structure

```text
BreakPoint-AI/
├── .bob/                  # IBM Bob task prompts & orchestrator configuration
├── .github/workflows/     # CI/CD security pipeline actions
├── cli/                   # Developer CLI tools & scan engines
├── dashboard/             # C2 Dashboard server & React frontend
│   └── client/            # Vite + React UI source
├── mcp-server/            # Model Context Protocol server implementation
├── demo-app/              # Sample vulnerable microservice targets for testing
├── scripts/               # Fuzzing orchestrator scripts
└── screenshots/           # Hackathon task session evidence & dashboard previews

```

---

## 📑 Hackathon Deliverables & Evidence

* **IBM Bob Task Summaries:** Located in `.bob/` and root session summaries (`bob-tasks-*.md`).
* **Session Screenshots:** Saved under the `screenshots/` directory for verification.

---

## 📜 License

This project is open-source and available under the [MIT License](https://www.google.com/search?q=LICENSE&utm_source=gemini).

```

### Push the README to GitHub:
```powershell
git add README.md
git commit -m "docs: add official repo README"
git push origin main

```