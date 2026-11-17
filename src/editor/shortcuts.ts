import {
  ArrowUpRight,
  Circle,
  Crop,
  Droplets,
  Grid3x3,
  Highlighter,
  ListOrdered,
  Minus,
  MousePointer2,
  Pencil,
  Square,
  Type,
  type LucideIcon,
} from 'lucide-react';
import type { ToolId } from './model';

export interface ToolDef {
  id: ToolId;
  label: string;
  key: string;
  Icon: LucideIcon;
  group: number;
}

export const TOOLS: ToolDef[] = [
  { id: 'select', label: 'Select', key: 'V', Icon: MousePointer2, group: 0 },
  { id: 'rect', label: 'Rectangle', key: 'R', Icon: Square, group: 1 },
  { id: 'ellipse', label: 'Ellipse', key: 'O', Icon: Circle, group: 1 },
  { id: 'arrow', label: 'Arrow', key: 'A', Icon: ArrowUpRight, group: 1 },
  { id: 'line', label: 'Line', key: 'L', Icon: Minus, group: 1 },
  { id: 'text', label: 'Text', key: 'T', Icon: Type, group: 2 },
  { id: 'pen', label: 'Pen', key: 'P', Icon: Pencil, group: 2 },
  { id: 'highlighter', label: 'Highlighter', key: 'H', Icon: Highlighter, group: 2 },
  { id: 'marker', label: 'Numbered marker', key: 'N', Icon: ListOrdered, group: 2 },
  { id: 'blur', label: 'Blur', key: 'B', Icon: Droplets, group: 3 },
  { id: 'pixelate', label: 'Pixelate', key: 'X', Icon: Grid3x3, group: 3 },
  { id: 'crop', label: 'Crop', key: 'C', Icon: Crop, group: 3 },
];

export const TOOL_BY_KEY: Record<string, ToolId> = Object.fromEntries(TOOLS.map((t) => [t.key.toLowerCase(), t.id]));

export const TOOL_LABEL: Record<string, string> = Object.fromEntries(TOOLS.map((t) => [t.id, t.label]));

export const isMac = /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent);
export const MOD = isMac ? '⌘' : 'Ctrl';

export const SHORTCUT_HELP: Array<[string, string]> = [
  ['V R O A L T P H N B X C', 'Select · Rectangle · Ellipse · Arrow · Line · Text · Pen · Highlighter · Numbered marker · Blur · Pixelate · Crop'],
  [`${MOD}+Z / ${MOD}+Shift+Z`, 'Undo / Redo'],
  [`${MOD}+C`, 'Copy selected annotation (if you selected one), otherwise copy the image'],
  [`${MOD}+V`, 'Paste copied annotation'],
  [`${MOD}+Shift+C`, 'Copy the final image'],
  [`${MOD}+S`, 'Save'],
  ['Delete / Backspace', 'Delete selected annotation'],
  ['Esc', 'Cancel current operation / deselect'],
  ['Space + drag', 'Pan'],
  [`${MOD}+scroll`, 'Zoom'],
  ['Shift while drawing', 'Square / circle / 45° angle'],
  ['Enter', 'Apply crop'],
];
