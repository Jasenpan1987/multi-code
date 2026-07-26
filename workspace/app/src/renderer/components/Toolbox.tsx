import { ToolboxSection } from "./ToolboxSection";
import { GitSection } from "./GitSection";
import { QuickActionsSection } from "./QuickActionsSection";
import { TerminalSection } from "./TerminalSection";
import { MarkdownSection } from "./MarkdownSection";
import { PhoneSection } from "./PhoneSection";
import type { Instance } from "../../shared/types";

interface ToolboxProps {
  instance: Instance;
  expandedSection: string;
  onExpandSection: (sectionId: string) => void;
  openPath: string;
  onOpenPath: (path: string) => void;
  onPreviewInView: (path: string) => void;
  width: number;
}

export function Toolbox({
  instance,
  expandedSection,
  onExpandSection,
  openPath,
  onOpenPath,
  onPreviewInView,
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
          onPreviewInView={onPreviewInView}
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

      <ToolboxSection
        id="view"
        title="View"
        expanded={isExpanded("view")}
        onToggle={onExpandSection}
      >
        <MarkdownSection
          instance={instance}
          active={isExpanded("view")}
          openPath={openPath}
          onOpenPath={onOpenPath}
        />
      </ToolboxSection>

      <ToolboxSection
        id="phone"
        title="Phone"
        expanded={isExpanded("phone")}
        onToggle={onExpandSection}
      >
        <PhoneSection active={isExpanded("phone")} />
      </ToolboxSection>
    </aside>
  );
}
