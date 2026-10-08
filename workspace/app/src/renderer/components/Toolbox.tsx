import { ToolboxSection } from "./ToolboxSection";
import { GitSection } from "./GitSection";
import { QuickActionsSection } from "./QuickActionsSection";
import { TerminalSection } from "./TerminalSection";
import { MarkdownSection } from "./MarkdownSection";
import { PhoneSection } from "./PhoneSection";
import { SecretarySection } from "./SecretarySection";
import { ManagerSection } from "./ManagerSection";
import type { DiffSide, Instance } from "../../shared/types";

interface ToolboxProps {
  instance: Instance;
  expandedSection: string;
  onExpandSection: (sectionId: string) => void;
  openPath: string;
  onOpenPath: (path: string) => void;
  onPreviewInView: (path: string) => void;
  onViewDiff: (relPath: string, side: DiffSide, oldPath?: string) => void;
  // null fills whatever room is left.
  width: number | null;
  // Folded away. Hidden rather than unmounted, so the shell keeps its session.
  hidden: boolean;
}

export function Toolbox({
  instance,
  expandedSection,
  onExpandSection,
  openPath,
  onOpenPath,
  onPreviewInView,
  onViewDiff,
  width,
  hidden,
}: ToolboxProps) {
  const isExpanded = (id: string) => expandedSection === id;

  return (
    <aside
      className="toolbox"
      hidden={hidden}
      style={width === null ? undefined : { width: `${width}px`, flex: "none" }}
    >
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
          onViewDiff={onViewDiff}
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

      <ToolboxSection
        id="secretary"
        title="Secretary"
        expanded={isExpanded("secretary")}
        onToggle={onExpandSection}
      >
        <SecretarySection active={isExpanded("secretary")} />
      </ToolboxSection>

      <ToolboxSection
        id="manager"
        title="Manager"
        expanded={isExpanded("manager")}
        onToggle={onExpandSection}
      >
        <ManagerSection active={isExpanded("manager")} />
      </ToolboxSection>
    </aside>
  );
}
