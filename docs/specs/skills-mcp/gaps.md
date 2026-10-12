# Gaps: Skills and MCP

| ID | Question | Impact | Ask | Status |
|-------|-------------------------------|--------------------------|-----------------|--------|

## Resolved

| ID | Question | Resolution | Evidence |
|-------|-------------------------------|--------------------------|-----------------|
| G-001 | When you add an MCP server to a shared project, should every environment variable and header value be kept out of the shared file, or only the ones you mark as secret? | Neither. Multi-Code never asks for, stores or writes a value. It writes references only, and after the install it reminds the builder of each variable that is not set: which server, which variable, the absolute path of the file to put it in, and the line to add. A server that logs in instead gets "log in through `/mcp`". Which file the reminder names, per backend and scope, is PRD Open Question 6, measured in T-609. PRD v1.2. | Builder, 2026-10-13, in session; `docs/timeline/2026-10-13_mcp-env-vars-experiment.md` |
