import { motion } from 'framer-motion';
import { useDroppable } from '@dnd-kit/core';
import { Plus, Folder as FolderIcon } from 'lucide-react';
import { LiquidTabs } from '../motion/LiquidTabs';
import type { Folder } from '../../store/deliverablesStore';

interface FolderTabsProps {
  folders: Folder[];
  activeId: string;
  onSelect: (id: string) => void;
  onCreate?: () => void;
}

/**
 * FolderTabs — フォルダ切り替えタブ。
 * 排他選択の見た目は LiquidTabs（タブの正本）へ委譲し、
 * DnD のドロップ先（folder-drop-<id>）はラベル側で維持する。
 */
export function FolderTabs({ folders, activeId, onSelect, onCreate }: FolderTabsProps) {
  return (
    <div className="flex items-center gap-2 overflow-x-auto scrollbar-hide py-2 px-1">
      <LiquidTabs
        id="deliverables-folders"
        label="成果物のフォルダを切り替え"
        size="sm"
        items={folders.map((folder) => ({
          value: folder.id,
          label: <DroppableFolderLabel folder={folder} />,
          badge:
            folder.itemIds.length > 0 ? (
              <span className="tabular">{folder.itemIds.length}</span>
            ) : undefined,
        }))}
        value={activeId}
        onChange={onSelect}
      />
      {onCreate && (
        <motion.button
          onClick={onCreate}
          className="flex items-center gap-1 bg-sunken border border-border rounded-full px-3 py-1.5 text-xs text-secondary hover:text-primary flex-shrink-0 transition-colors duration-fast"
          whileHover={{ scale: 1.05 }}
          whileTap={{ scale: 0.95 }}
        >
          <Plus size={12} /> 新規
        </motion.button>
      )}
    </div>
  );
}

/** ドラッグ中の成果物を受け取るドロップ先。isOver で受け入れ可能を示す。 */
function DroppableFolderLabel({ folder }: { folder: Folder }) {
  const { setNodeRef, isOver } = useDroppable({ id: `folder-drop-${folder.id}` });
  return (
    <span
      ref={setNodeRef}
      className={`inline-flex items-center gap-1.5 rounded-full transition-all duration-fast ${
        isOver ? 'outline outline-2 outline-offset-2 outline-accent' : ''
      }`}
    >
      <FolderIcon size={12} />
      {folder.name}
    </span>
  );
}
