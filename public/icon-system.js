import createElement from '/vendor/lucide/createElement.mjs';
import Activity from '/vendor/lucide/icons/activity.mjs';
import Archive from '/vendor/lucide/icons/archive.mjs';
import ArrowLeft from '/vendor/lucide/icons/arrow-left.mjs';
import ArrowRight from '/vendor/lucide/icons/arrow-right.mjs';
import Check from '/vendor/lucide/icons/check.mjs';
import ChevronDown from '/vendor/lucide/icons/chevron-down.mjs';
import Download from '/vendor/lucide/icons/download.mjs';
import Eye from '/vendor/lucide/icons/eye.mjs';
import EyeOff from '/vendor/lucide/icons/eye-off.mjs';
import FileDown from '/vendor/lucide/icons/file-down.mjs';
import FileText from '/vendor/lucide/icons/file-text.mjs';
import GitCompare from '/vendor/lucide/icons/git-compare.mjs';
import House from '/vendor/lucide/icons/house.mjs';
import LayoutGrid from '/vendor/lucide/icons/layout-grid.mjs';
import List from '/vendor/lucide/icons/list.mjs';
import Maximize from '/vendor/lucide/icons/maximize-2.mjs';
import Minimize from '/vendor/lucide/icons/minimize-2.mjs';
import Pause from '/vendor/lucide/icons/pause.mjs';
import Play from '/vendor/lucide/icons/play.mjs';
import Redo from '/vendor/lucide/icons/redo.mjs';
import Refresh from '/vendor/lucide/icons/refresh-cw.mjs';
import RotateCcw from '/vendor/lucide/icons/rotate-ccw.mjs';
import ScanSearch from '/vendor/lucide/icons/scan-search.mjs';
import Settings from '/vendor/lucide/icons/settings.mjs';
import Square from '/vendor/lucide/icons/square.mjs';
import Trash from '/vendor/lucide/icons/trash.mjs';
import TriangleAlert from '/vendor/lucide/icons/triangle-alert.mjs';
import Upload from '/vendor/lucide/icons/upload.mjs';
import X from '/vendor/lucide/icons/x.mjs';
import ZapOff from '/vendor/lucide/icons/zap-off.mjs';

const ICONS = Object.freeze({
  activity: Activity,
  archive: Archive,
  'arrow-left': ArrowLeft,
  'arrow-right': ArrowRight,
  check: Check,
  'chevron-down': ChevronDown,
  download: Download,
  eye: Eye,
  'eye-off': EyeOff,
  'file-down': FileDown,
  'file-text': FileText,
  'git-compare': GitCompare,
  house: House,
  'layout-grid': LayoutGrid,
  list: List,
  maximize: Maximize,
  minimize: Minimize,
  pause: Pause,
  play: Play,
  redo: Redo,
  refresh: Refresh,
  'rotate-ccw': RotateCcw,
  'scan-search': ScanSearch,
  settings: Settings,
  square: Square,
  trash: Trash,
  'triangle-alert': TriangleAlert,
  upload: Upload,
  x: X,
  'zap-off': ZapOff
});

export function setIcon(target, name) {
  const holder = target?.matches?.('[data-icon]') ? target : target?.querySelector?.('[data-icon]');
  const definition = ICONS[name];
  if (!holder || !definition) return false;
  holder.dataset.icon = name;
  holder.replaceChildren(createElement(definition, {
    width: 18,
    height: 18,
    class: 'lucide-icon',
    'aria-hidden': 'true',
    focusable: 'false'
  }));
  return true;
}

export function hydrateIcons(root = document) {
  for (const holder of root.querySelectorAll('[data-icon]')) setIcon(holder, holder.dataset.icon);
}
