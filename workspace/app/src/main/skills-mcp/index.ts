// The app's Skills and MCP refreshes, on the real modules. The refresh-skills-mcp
// IPC handler drives it; the renderer hears every change on `skills-mcp-update`.

import { BrowserWindow } from "electron";
import os from "os";
import { claudeCliCommand } from "../backends/claude";
import { processManager } from "../process-manager";
import { probeClaude } from "./claudeProbe";
import { readPluginState } from "./claudePlugins";
import { claudeConfigPaths, readLocalConfig } from "./claudeScopes";
import { createSkillsMcp } from "./refresh";

export const UPDATE_CHANNEL = "skills-mcp-update";

export const skillsMcp = createSkillsMcp({
  targetOf: (instanceId) => processManager.probeTargetOf(instanceId),
  probe: (cwd, mcpConfigPath) => probeClaude(cwd, mcpConfigPath),
  pluginState: (cwd) => readPluginState(cwd),
  localConfig: (cwd) =>
    readLocalConfig(cwd, claudeConfigPaths(claudeCliCommand().env, os.homedir(), cwd)),
  send: (snapshot) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(UPDATE_CHANNEL, snapshot);
    }
  },
});
