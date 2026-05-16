import { ToolboxSection } from "./ToolboxSection";
import { GitSection } from "./GitSection";
import { QuickActionsSection } from "./QuickActionsSection";
import { TerminalSection } from "./TerminalSection";
import type { Instance } from "../../shared/types";

interface ToolboxProps {
  instance: Instance;
  expandedSection: string;
  onExpandSection: (sectionId: string) => void;
  width: number;
}

export function Toolbox({
  instance,
  expandedSection,
  onExpandSection,
  width,
}: ToolboxProps) {
  const isExpanded = (id: string) => expandedSection === id;

  return (
    <aside className="toolbox" style={{ width: `${width}px`, flex: "none" }}>
      <ToolboxSection
        id="git"
        title="Git"
        expanded={isExpanded("git")}
        onToggle={onExpandSection}
      >
        <GitSection
          instanceId={instance.id}
          cwd={instance.cwd}
          active={isExpanded("git")}
        />
      </ToolboxSection>

      <ToolboxSection
        id="quick-actions"
        title="Quick Actions"
        expanded={isExpanded("quick-actions")}
        onToggle={onExpandSection}
      >
        <QuickActionsSection
          instance={instance}
          active={isExpanded("quick-actions")}
        />
      </ToolboxSection>

      <ToolboxSection
        id="terminal"
        title="Terminal"
        expanded={isExpanded("terminal")}
        onToggle={onExpandSection}
      >
        <TerminalSection
          instanceId={instance.id}
          active={isExpanded("terminal")}
        />
      </ToolboxSection>
    </aside>
  );
}
