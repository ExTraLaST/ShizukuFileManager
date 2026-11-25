/**
 * Windows 电脑版单窗格组件
 * 支持多标签页、此电脑总览、详情/列表/图标视图、表头/工具栏/右键排序、
 * 实时筛选、本机递归搜索、拖放、Shell/远程缩略图、新建办公/文本文档、
 * 原生右键菜单与打开方式、压缩包查看/解压/压缩、本机监听与远程轮询自动刷新。
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  RefreshCw,
  Plus,
  X,
  Folder,
  File,
  HardDrive,
  Network,
  Smartphone,
  Laptop,
  Search,
  Filter,
  LayoutList,
  Grid,
  AlignJustify,
  ArrowUpDown,
  FileArchive,
  Music,
  Film,
  Image as ImageIcon,
  FolderPlus,
  FilePlus,
  Copy,
  Scissors,
  ClipboardPaste,
  Trash2,
  Edit3,
  Info,
  ExternalLink,
  MoreHorizontal,
  Pin,
} from 'lucide-react';
import type {
  DriveInfo,
  FileItem,
  LinkDevice,
  PaneTab,
  SortField,
  ViewMode,
} from '../types';
import {
  AUDIO_EXTS,
  IMAGE_EXTS,
  VIDEO_EXTS,
  baseName,
  extOf,
  fileTypeLabel,
  formatBytes,
  formatDate,
  isArchive,
  isRemoteThumbable,
  isThumbable,
  sortFileItems,
} from '../utils/format';

interface FilePaneProps {
  paneId: string;
  isActive: boolean;
  tabs: PaneTab[];
  activeTabId: string;
  drives: DriveInfo[];
  linkDevices: LinkDevice[];
  refreshToken: number;
  onFocusPane: () => void;
  onSelectTab: (tabId: string) => void;
  onNewTab: () => void;
  onCloseTab: (tabId: string) => void;
  onUpdateTab: (tabId: string, updater: (t: PaneTab) => PaneTab) => void;
  onNavigate: (
    tabId: string,
    target: { kind: 'thispc' | 'local' | 'remote'; path: string; deviceId?: string; title?: string },
  ) => void;
  onCopyItems: (kind: 'local' | 'remote', deviceId: string | undefined, items: FileItem[]) => void;
  onCutItems: (kind: 'local' | 'remote', deviceId: string | undefined, items: FileItem[]) => void;
  onPasteHere: (kind: 'local' | 'remote', deviceId: string | undefined, destDir: string) => void;
  onDropTransfer: (
    payload: { srcKind: 'local' | 'remote'; srcDeviceId?: string; items: FileItem[] },
    dstKind: 'local' | 'remote',
    dstDeviceId: string | undefined,
    destDir: string,
    copy: boolean,
  ) => void;
  onPinQuickAccess: (path: string, name: string) => void;
  onOpenArchiveViewer: (archivePath: string) => void;
  onOpenCompressDialog: (destDir: string, sources: string[]) => void;
  onOpenProps: (kind: 'local' | 'remote', device: LinkDevice | undefined, item: FileItem) => void;
  onNotify: (msg: string) => void;
}

export const FilePane: React.FC<FilePaneProps> = ({
  paneId,
  isActive,
  tabs,
  activeTabId,
  drives,
  linkDevices,
  refreshToken,
  onFocusPane,
  onSelectTab,
  onNewTab,
  onCloseTab,
  onUpdateTab,
  onNavigate,
  onCopyItems,
  onCutItems,
  onPasteHere,
  onDropTransfer,
  onPinQuickAccess,
  onOpenArchiveViewer,
  onOpenCompressDialog,
  onOpenProps,
  onNotify,
}) => {
  const tab = tabs.find((t) => t.id === activeTabId) || tabs[0];
  const device = useMemo(
    () => (tab.deviceId ? linkDevices.find((d) => d.id === tab.deviceId) : undefined),
    [linkDevices, tab.deviceId],
  );

  const [items, setItems] = useState<FileItem[]>([]);
  const [remoteRoots, setRemoteRoots] = useState<
    Array<{ name: string; path: string; free: number; total: number }>
  >([]);
  const [remoteQuickAccess, setRemoteQuickAccess] = useState<Array<{ name: string; path: string }>>(
    [],
  );
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [addressDraft, setAddressDraft] = useState(tab.path);
  const [dragOver, setDragOver] = useState(false);
  const [pollMode, setPollMode] = useState(false);
  const [ctxMenu, setCtxMenu] = useState<{
    x: number;
    y: number;
    targetItem: FileItem | null;
  } | null>(null);

  const searchIdRef = useRef<string | null>(null);
  const loadSeqRef = useRef(0);

  useEffect(() => {
    setAddressDraft(tab.kind === 'thispc' ? '此电脑' : tab.path);
  }, [tab.kind, tab.path]);

  // 关闭右键菜单
  useEffect(() => {
    const close = () => setCtxMenu(null);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, []);

  // 加载目录数据
  const reload = async (silent = false) => {
    const seq = ++loadSeqRef.current;
    if (!silent) {
      setLoading(true);
      setError('');
    }
    try {
      if (tab.kind === 'thispc') {
        setItems([]);
        setThumbs({});
        return;
      }

      if (tab.kind === 'local') {
        if (tab.searchMode && tab.searchQuery.trim()) {
          if (searchIdRef.current) await window.api.searchCancel(searchIdRef.current);
          const sid = `${paneId}-${Date.now()}`;
          searchIdRef.current = sid;
          const res = await window.api.search({ id: sid, dir: tab.path, query: tab.searchQuery });
          if (seq !== loadSeqRef.current) return;
          setItems(res.items);
          return;
        }
        const list = await window.api.list(tab.path);
        if (seq !== loadSeqRef.current) return;
        setItems(list);
        const thumbCandidates = list
          .filter(isThumbable)
          .slice(0, 80)
          .map((i) => ({ path: i.path, mtime: i.mtime, size: i.size }));
        if (thumbCandidates.length > 0) {
          window.api.thumbs(thumbCandidates).then((map) => {
            if (seq === loadSeqRef.current) setThumbs(map);
          });
        } else {
          setThumbs({});
        }
        return;
      }

      if (tab.kind === 'remote') {
        if (!device) {
          setError('互联设备已移除');
          setItems([]);
          return;
        }
        const conn = { host: device.host, port: device.port, password: device.password };
        if (!tab.path) {
          const [rootsRes, qaRes] = await Promise.all([
            window.api.linkRoots(conn),
            window.api.linkQuickAccess(conn),
          ]);
          if (seq !== loadSeqRef.current) return;
          setRemoteRoots(rootsRes.roots || []);
          setRemoteQuickAccess(qaRes.items || []);
          setItems([]);
          setThumbs({});
          return;
        }
        const listRes = await window.api.linkList(conn, tab.path);
        if (seq !== loadSeqRef.current) return;
        const mapped: FileItem[] = (listRes.items || []).map((x) => ({
          name: x.name,
          path: x.path,
          isDirectory: x.isDirectory,
          size: x.size,
          mtime: x.modified,
          extension: x.isDirectory ? '' : extOf(x.name),
        }));
        setItems(mapped);
        const thumbCandidates = mapped
          .filter(isRemoteThumbable)
          .slice(0, 40)
          .map((i) => ({ path: i.path, mtime: i.mtime, size: i.size }));
        if (thumbCandidates.length > 0) {
          window.api.linkThumbs(conn, thumbCandidates).then((map) => {
            if (seq === loadSeqRef.current) setThumbs(map);
          });
        } else {
          setThumbs({});
        }
      }
    } catch (e) {
      if (seq === loadSeqRef.current) {
        setError((e as Error).message || '加载失败');
      }
    } finally {
      if (seq === loadSeqRef.current && !silent) setLoading(false);
    }
  };

  useEffect(() => {
    setSelected(new Set());
    reload();
  }, [tab.kind, tab.path, tab.deviceId, tab.searchMode, tab.searchQuery, refreshToken]);

  // 自动刷新：本机监听 / 映射网络盘与远程轮询
  useEffect(() => {
    let active = true;
    if (tab.kind === 'local' && tab.path && !tab.searchMode) {
      window.api.watchSet(paneId, tab.path).then((mode) => {
        if (active) setPollMode(mode === 'poll' || mode === 'error');
      });
    } else {
      window.api.watchClear(paneId);
      setPollMode(tab.kind === 'remote' && Boolean(tab.path));
    }
    return () => {
      active = false;
    };
  }, [paneId, tab.kind, tab.path, tab.searchMode]);

  useEffect(() => {
    const offChanged = window.api.onWatchChanged((p) => {
      if (p.paneId === paneId) reload(true);
    });
    const offFailed = window.api.onWatchFailed((p) => {
      if (p.paneId === paneId) setPollMode(true);
    });
    return () => {
      offChanged();
      offFailed();
    };
  }, [paneId, tab.kind, tab.path, tab.deviceId]);

  useEffect(() => {
    if (!pollMode) return;
    const timer = setInterval(() => reload(true), 10000);
    return () => clearInterval(timer);
  }, [pollMode, tab.kind, tab.path, tab.deviceId]);

  const displayedItems = useMemo(() => {
    const q = tab.filterText.trim().toLowerCase();
    const filtered = q ? items.filter((i) => i.name.toLowerCase().includes(q)) : items;
    return sortFileItems(filtered, tab.sortField, tab.sortOrder);
  }, [items, tab.filterText, tab.sortField, tab.sortOrder]);

  const selectedItems = useMemo(
    () => displayedItems.filter((i) => selected.has(i.path)),
    [displayedItems, selected],
  );

  // 排序切换
  const toggleSort = (field: SortField) => {
    onUpdateTab(tab.id, (t) => ({
      ...t,
      sortField: field,
      sortOrder: t.sortField === field && t.sortOrder === 'asc' ? 'desc' : 'asc',
    }));
  };

  // 后退、前进、上级
  const goBack = () => {
    if (tab.historyIndex <= 0) return;
    const nextIdx = tab.historyIndex - 1;
    const entry = tab.history[nextIdx];
    onUpdateTab(tab.id, (t) => ({
      ...t,
      kind: entry.kind,
      path: entry.path,
      deviceId: entry.deviceId,
      title: entry.kind === 'thispc' ? '此电脑' : baseName(entry.path) || '根目录',
      historyIndex: nextIdx,
      searchMode: false,
    }));
  };

  const goForward = () => {
    if (tab.historyIndex >= tab.history.length - 1) return;
    const nextIdx = tab.historyIndex + 1;
    const entry = tab.history[nextIdx];
    onUpdateTab(tab.id, (t) => ({
      ...t,
      kind: entry.kind,
      path: entry.path,
      deviceId: entry.deviceId,
      title: entry.kind === 'thispc' ? '此电脑' : baseName(entry.path) || '根目录',
      historyIndex: nextIdx,
      searchMode: false,
    }));
  };

  const goUp = async () => {
    if (tab.kind === 'local' && tab.path) {
      const parent = await window.api.parent(tab.path);
      if (!parent) {
        onNavigate(tab.id, { kind: 'thispc', path: '', title: '此电脑' });
      } else {
        onNavigate(tab.id, { kind: 'local', path: parent, title: baseName(parent) });
      }
    } else if (tab.kind === 'remote' && tab.path && device) {
      const clean = tab.path.replace(/\/+$/, '');
      if (/^[A-Za-z]:$/.test(clean) || clean === '' || clean === '/') {
        onNavigate(tab.id, { kind: 'remote', path: '', deviceId: device.id, title: device.name });
      } else {
        const idx = clean.lastIndexOf('/');
        const parent =
          idx <= 0
            ? clean.startsWith('/')
              ? '/'
              : ''
            : /^[A-Za-z]:$/.test(clean.slice(0, idx))
              ? `${clean.slice(0, idx)}/`
              : clean.slice(0, idx);
        onNavigate(tab.id, {
          kind: 'remote',
          path: parent,
          deviceId: device.id,
          title: baseName(parent) || device.name,
        });
      }
    }
  };

  const openItem = async (item: FileItem) => {
    if (item.isDirectory) {
      onNavigate(tab.id, {
        kind: tab.kind === 'remote' ? 'remote' : 'local',
        path: item.path,
        deviceId: tab.deviceId,
        title: item.name,
      });
      return;
    }
    if (tab.kind === 'local') {
      if (isArchive(item)) {
        onOpenArchiveViewer(item.path);
        return;
      }
      const err = await window.api.open(item.path);
      if (err) onNotify(`打开失败：${err}`);
    } else if (tab.kind === 'remote' && device) {
      onNotify(`正在打开远程文件：${item.name}`);
      const res = await window.api.linkOpen(
        { host: device.host, port: device.port, password: device.password },
        item.path,
      );
      if (!res.ok) onNotify(res.error || '打开失败');
    }
  };

  // 文件操作
  const createNewFolder = async () => {
    const name = window.prompt('请输入新文件夹名称：', '新建文件夹');
    if (!name || !name.trim()) return;
    try {
      if (tab.kind === 'local') {
        await window.api.mkdir(tab.path, name.trim());
      } else if (tab.kind === 'remote' && device) {
        await window.api.linkMkdir(
          { host: device.host, port: device.port, password: device.password },
          tab.path,
          name.trim(),
        );
      }
      reload(true);
    } catch (e) {
      onNotify((e as Error).message);
    }
  };

  const createNewFile = async (key: 'txt' | 'docx' | 'xlsx' | 'pptx') => {
    const defaults: Record<string, string> = {
      txt: '新建文本文档.txt',
      docx: '新建 Word 文档.docx',
      xlsx: '新建 Excel 工作表.xlsx',
      pptx: '新建 PowerPoint 演示文稿.pptx',
    };
    try {
      if (tab.kind === 'local') {
        if (key === 'txt') await window.api.newTextFile(tab.path);
        else await window.api.newFileFromTemplate(tab.path, defaults[key], key);
      } else if (tab.kind === 'remote' && device) {
        const conn = { host: device.host, port: device.port, password: device.password };
        if (key === 'txt') await window.api.linkUploadEmpty(conn, tab.path);
        else await window.api.linkUploadTemplate(conn, tab.path, defaults[key], key);
      }
      reload(true);
      onNotify(`已新建 ${defaults[key]}`);
    } catch (e) {
      onNotify((e as Error).message);
    }
  };

  const renameItem = async (item: FileItem) => {
    const next = window.prompt('重命名为：', item.name);
    if (!next || next === item.name) return;
    try {
      if (tab.kind === 'local') await window.api.rename(item.path, next);
      else if (tab.kind === 'remote' && device) {
        await window.api.linkRename(
          { host: device.host, port: device.port, password: device.password },
          item.path,
          next,
        );
      }
      reload(true);
    } catch (e) {
      onNotify((e as Error).message);
    }
  };

  const deleteSelected = async (targets: FileItem[], permanent = false) => {
    if (!targets.length) return;
    const ok = window.confirm(
      `确定${permanent || tab.kind === 'remote' ? '永久删除' : '移入回收站'}选中的 ${targets.length} 个项目吗？`,
    );
    if (!ok) return;
    try {
      const paths = targets.map((t) => t.path);
      if (tab.kind === 'local') {
        if (permanent) await window.api.deleteForever(paths);
        else await window.api.trash(paths);
      } else if (tab.kind === 'remote' && device) {
        await window.api.linkDelete(
          { host: device.host, port: device.port, password: device.password },
          paths,
        );
      }
      setSelected(new Set());
      reload(true);
    } catch (e) {
      onNotify((e as Error).message);
    }
  };

  // 点击选中逻辑（支持 Ctrl 多选 / Shift 连选）
  const handleSelectItem = (item: FileItem, e: React.MouseEvent) => {
    e.stopPropagation();
    onFocusPane();
    if (e.ctrlKey || e.metaKey) {
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(item.path)) next.delete(item.path);
        else next.add(item.path);
        return next;
      });
    } else if (e.shiftKey && selected.size > 0) {
      const last = [...selected][selected.size - 1];
      const idx1 = displayedItems.findIndex((i) => i.path === last);
      const idx2 = displayedItems.findIndex((i) => i.path === item.path);
      if (idx1 >= 0 && idx2 >= 0) {
        const [a, b] = idx1 < idx2 ? [idx1, idx2] : [idx2, idx1];
        setSelected(new Set(displayedItems.slice(a, b + 1).map((i) => i.path)));
      }
    } else {
      setSelected(new Set([item.path]));
    }
  };

  // 键盘快捷键（Ctrl+C/X/V、Delete、F2、F5）
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if ((e.target as HTMLElement).tagName === 'INPUT') return;
    if (e.ctrlKey && e.key.toLowerCase() === 'c' && selectedItems.length && tab.kind !== 'thispc') {
      e.preventDefault();
      onCopyItems(tab.kind, tab.deviceId, selectedItems);
    } else if (e.ctrlKey && e.key.toLowerCase() === 'x' && selectedItems.length && tab.kind !== 'thispc') {
      e.preventDefault();
      onCutItems(tab.kind, tab.deviceId, selectedItems);
    } else if (e.ctrlKey && e.key.toLowerCase() === 'v' && tab.kind !== 'thispc' && tab.path) {
      e.preventDefault();
      onPasteHere(tab.kind, tab.deviceId, tab.path);
    } else if (e.ctrlKey && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      setSelected(new Set(displayedItems.map((i) => i.path)));
    } else if (e.key === 'Delete' && selectedItems.length) {
      deleteSelected(selectedItems, e.shiftKey);
    } else if (e.key === 'F2' && selectedItems.length === 1) {
      renameItem(selectedItems[0]);
    } else if (e.key === 'F5') {
      e.preventDefault();
      reload();
    }
  };

  // 渲染文件图标或缩略图
  const renderIcon = (item: FileItem, large = false) => {
    const thumb = thumbs[item.path];
    if (thumb) {
      return (
        <img
          src={thumb}
          alt=""
          className={large ? '' : 'thumb-sm'}
          style={large ? { maxWidth: 64, maxHeight: 64, borderRadius: 6 } : undefined}
        />
      );
    }
    const sz = large ? 38 : 16;
    if (item.isDirectory) return <Folder size={sz} color="#f5b82e" fill="#f5b82e" />;
    if (item.icon && !large) {
      return <img src={item.icon} alt="" style={{ width: 16, height: 16, flexShrink: 0 }} />;
    }
    const ext = item.extension || extOf(item.name);
    if (IMAGE_EXTS.has(ext)) return <ImageIcon size={sz} color="#2b88d8" />;
    if (VIDEO_EXTS.has(ext)) return <Film size={sz} color="#8764b8" />;
    if (AUDIO_EXTS.has(ext)) return <Music size={sz} color="#e3008c" />;
    if (isArchive(item)) return <FileArchive size={sz} color="#ca5010" />;
    return <File size={sz} color="var(--text-secondary)" />;
  };

  const handleDragStart = (item: FileItem, e: React.DragEvent) => {
    if (tab.kind === 'thispc') return;
    const dragItems = selected.has(item.path) ? selectedItems : [item];
    e.dataTransfer.setData(
      'application/x-shizuku-files',
      JSON.stringify({ srcKind: tab.kind, srcDeviceId: tab.deviceId, items: dragItems }),
    );
    e.dataTransfer.effectAllowed = 'copyMove';
  };

  const handleDrop = (e: React.DragEvent, destOverride?: string) => {
    e.preventDefault();
    setDragOver(false);
    if (tab.kind === 'thispc') return;
    const dest = destOverride || tab.path;
    if (!dest) return;
    const raw = e.dataTransfer.getData('application/x-shizuku-files');
    if (raw) {
      const payload = JSON.parse(raw);
      onDropTransfer(payload, tab.kind, tab.deviceId, dest, e.ctrlKey);
    }
  };

  return (
    <section
      className={`pane ${isActive ? 'active' : ''}`}
      tabIndex={0}
      onFocus={onFocusPane}
      onMouseDown={onFocusPane}
      onKeyDown={handleKeyDown}
    >
      {/* 多标签栏 */}
      <div className="pane-tabs">
        {tabs.map((t) => (
          <div
            key={t.id}
            className={`pane-tab ${t.id === tab.id ? 'active' : ''}`}
            onClick={() => onSelectTab(t.id)}
          >
            <span className="pane-tab-title">{t.title}</span>
            {tabs.length > 1 && (
              <button
                style={{ padding: 1 }}
                onClick={(e) => {
                  e.stopPropagation();
                  onCloseTab(t.id);
                }}
              >
                <X size={12} />
              </button>
            )}
          </div>
        ))}
        <button onClick={onNewTab} title="新建标签页" style={{ padding: 4 }}>
          <Plus size={14} />
        </button>
      </div>

      {/* 导航与工具栏 */}
      <div className="pane-toolbar">
        <button onClick={goBack} disabled={tab.historyIndex <= 0} title="后退">
          <ArrowLeft size={14} />
        </button>
        <button onClick={goForward} disabled={tab.historyIndex >= tab.history.length - 1} title="前进">
          <ArrowRight size={14} />
        </button>
        <button onClick={goUp} disabled={tab.kind === 'thispc'} title="上一级">
          <ArrowUp size={14} />
        </button>
        <button onClick={() => reload()} title="刷新 (F5)">
          <RefreshCw size={14} />
        </button>

        {/* 地址栏 */}
        <form
          className="address-bar"
          onSubmit={async (e) => {
            e.preventDefault();
            const val = addressDraft.trim();
            if (!val || val === '此电脑') {
              onNavigate(tab.id, { kind: 'thispc', path: '', title: '此电脑' });
              return;
            }
            if (tab.kind === 'remote' && device) {
              onNavigate(tab.id, {
                kind: 'remote',
                path: val,
                deviceId: device.id,
                title: baseName(val) || device.name,
              });
            } else {
              const ok = await window.api.exists(val);
              if (ok) onNavigate(tab.id, { kind: 'local', path: val, title: baseName(val) });
              else onNotify('路径不存在');
            }
          }}
        >
          <input
            className="address-input"
            value={addressDraft}
            onChange={(e) => setAddressDraft(e.target.value)}
            placeholder="输入路径并回车..."
          />
        </form>

        {/* 实时筛选框 */}
        <div className="filter-box" title="在当前目录中实时筛选">
          <Filter size={13} color="var(--text-secondary)" />
          <input
            value={tab.filterText}
            onChange={(e) => onUpdateTab(tab.id, (t) => ({ ...t, filterText: e.target.value }))}
            placeholder="筛选当前..."
          />
        </div>

        {/* 本机递归搜索框 */}
        {tab.kind === 'local' && (
          <form
            className="filter-box"
            title="本机递归搜索（回车开始）"
            onSubmit={(e) => {
              e.preventDefault();
              onUpdateTab(tab.id, (t) => ({
                ...t,
                searchMode: Boolean(t.searchQuery.trim()),
              }));
            }}
          >
            <Search size={13} color="var(--text-secondary)" />
            <input
              value={tab.searchQuery}
              onChange={(e) =>
                onUpdateTab(tab.id, (t) => ({
                  ...t,
                  searchQuery: e.target.value,
                  searchMode: e.target.value.trim() ? t.searchMode : false,
                }))
              }
              placeholder="递归搜索..."
            />
            {tab.searchMode && (
              <button
                type="button"
                style={{ padding: 1 }}
                onClick={() =>
                  onUpdateTab(tab.id, (t) => ({ ...t, searchQuery: '', searchMode: false }))
                }
              >
                <X size={12} />
              </button>
            )}
          </form>
        )}

        {/* 工具栏排序 */}
        <button
          title="切换排序方式"
          onClick={() => {
            const fields: SortField[] = ['name', 'mtime', 'type', 'size'];
            const next = fields[(fields.indexOf(tab.sortField) + 1) % fields.length];
            toggleSort(next);
          }}
        >
          <ArrowUpDown size={14} />
        </button>

        {/* 视图切换：详情 / 列表 / 图标 */}
        <button
          title="详情视图"
          style={{ background: tab.viewMode === 'details' ? 'var(--bg-selected)' : undefined }}
          onClick={() => onUpdateTab(tab.id, (t) => ({ ...t, viewMode: 'details' as ViewMode }))}
        >
          <AlignJustify size={14} />
        </button>
        <button
          title="列表视图"
          style={{ background: tab.viewMode === 'list' ? 'var(--bg-selected)' : undefined }}
          onClick={() => onUpdateTab(tab.id, (t) => ({ ...t, viewMode: 'list' as ViewMode }))}
        >
          <LayoutList size={14} />
        </button>
        <button
          title="图标视图"
          style={{ background: tab.viewMode === 'icons' ? 'var(--bg-selected)' : undefined }}
          onClick={() => onUpdateTab(tab.id, (t) => ({ ...t, viewMode: 'icons' as ViewMode }))}
        >
          <Grid size={14} />
        </button>
      </div>

      {/* 主体内容区 */}
      <div
        className={`pane-content ${dragOver ? 'drag-over' : ''}`}
        onClick={() => setSelected(new Set())}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => handleDrop(e)}
        onContextMenu={(e) => {
          e.preventDefault();
          setCtxMenu({ x: e.clientX, y: e.clientY, targetItem: null });
        }}
      >
        {loading && (
          <div style={{ padding: 20, color: 'var(--text-secondary)' }}>正在加载...</div>
        )}
        {error && <div style={{ padding: 20, color: 'var(--danger)' }}>{error}</div>}

        {/* 此电脑总览 */}
        {!loading && tab.kind === 'thispc' && (
          <>
            <div className="thispc-section">
              <h4 className="thispc-title">设备和驱动器</h4>
              <div className="cards-grid">
                {drives.map((d) => {
                  const used = Math.max(0, d.total - d.free);
                  const pct = d.total > 0 ? Math.min(100, Math.round((used / d.total) * 100)) : 0;
                  const DriveIcon = d.type === 4 ? Network : HardDrive;
                  return (
                    <div
                      key={d.path}
                      className="drive-card"
                      onDoubleClick={() =>
                        onNavigate(tab.id, {
                          kind: 'local',
                          path: d.path,
                          title: `${d.displayName} (${d.letter})`,
                        })
                      }
                      onClick={() =>
                        onNavigate(tab.id, {
                          kind: 'local',
                          path: d.path,
                          title: `${d.displayName} (${d.letter})`,
                        })
                      }
                    >
                      <DriveIcon size={28} color="var(--accent)" />
                      <div className="drive-info">
                        <div className="drive-name">
                          {d.displayName} ({d.letter})
                        </div>
                        <div className="capacity-bar">
                          <div
                            className={`capacity-fill ${pct >= 90 ? 'warn' : ''}`}
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                        <div className="drive-sub">
                          可用 {formatBytes(d.free)}，共 {formatBytes(d.total)}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {linkDevices.length > 0 && (
              <div className="thispc-section">
                <h4 className="thispc-title">互联设备</h4>
                <div className="cards-grid">
                  {linkDevices.map((dev) => {
                    const DevIcon = dev.type === 'phone' ? Smartphone : Laptop;
                    return (
                      <div
                        key={dev.id}
                        className="drive-card"
                        onClick={() =>
                          onNavigate(tab.id, {
                            kind: 'remote',
                            path: '',
                            deviceId: dev.id,
                            title: dev.name,
                          })
                        }
                      >
                        <DevIcon size={28} color="var(--accent)" />
                        <div className="drive-info">
                          <div className="drive-name">{dev.name}</div>
                          <div className="drive-sub">
                            {dev.type === 'phone' ? '手机设备' : '电脑设备'} · {dev.host}:{dev.port}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </>
        )}

        {/* 远程设备根总览（快速访问 + 存储卷） */}
        {!loading && tab.kind === 'remote' && !tab.path && device && (
          <>
            {remoteQuickAccess.length > 0 && (
              <div className="thispc-section">
                <h4 className="thispc-title">远程快速访问</h4>
                <div className="cards-grid">
                  {remoteQuickAccess.map((qa) => (
                    <div
                      key={qa.path}
                      className="drive-card"
                      onClick={() =>
                        onNavigate(tab.id, {
                          kind: 'remote',
                          path: qa.path,
                          deviceId: device.id,
                          title: qa.name,
                        })
                      }
                    >
                      <Folder size={24} color="#f5b82e" fill="#f5b82e" />
                      <div className="drive-info">
                        <div className="drive-name">{qa.name}</div>
                        <div className="drive-sub">{qa.path}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="thispc-section">
              <h4 className="thispc-title">{device.name} 的存储根目录</h4>
              <div className="cards-grid">
                {remoteRoots.map((r) => {
                  const pct =
                    r.total > 0 ? Math.min(100, Math.round(((r.total - r.free) / r.total) * 100)) : 0;
                  return (
                    <div
                      key={r.path}
                      className="drive-card"
                      onClick={() =>
                        onNavigate(tab.id, {
                          kind: 'remote',
                          path: r.path,
                          deviceId: device.id,
                          title: r.name,
                        })
                      }
                    >
                      <HardDrive size={26} color="var(--accent)" />
                      <div className="drive-info">
                        <div className="drive-name">{r.name}</div>
                        {r.total > 0 && (
                          <>
                            <div className="capacity-bar">
                              <div className="capacity-fill" style={{ width: `${pct}%` }} />
                            </div>
                            <div className="drive-sub">
                              可用 {formatBytes(r.free)} / {formatBytes(r.total)}
                            </div>
                          </>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </>
        )}

        {/* 文件详情视图 */}
        {!loading &&
          !error &&
          (tab.kind === 'local' || (tab.kind === 'remote' && tab.path)) &&
          tab.viewMode === 'details' && (
            <table className="details-table">
              <thead>
                <tr>
                  <th style={{ width: '48%' }} onClick={() => toggleSort('name')}>
                    名称 {tab.sortField === 'name' ? (tab.sortOrder === 'asc' ? '▲' : '▼') : ''}
                  </th>
                  <th style={{ width: '22%' }} onClick={() => toggleSort('mtime')}>
                    修改日期 {tab.sortField === 'mtime' ? (tab.sortOrder === 'asc' ? '▲' : '▼') : ''}
                  </th>
                  <th style={{ width: '16%' }} onClick={() => toggleSort('type')}>
                    类型 {tab.sortField === 'type' ? (tab.sortOrder === 'asc' ? '▲' : '▼') : ''}
                  </th>
                  <th style={{ width: '14%', textAlign: 'right' }} onClick={() => toggleSort('size')}>
                    大小 {tab.sortField === 'size' ? (tab.sortOrder === 'asc' ? '▲' : '▼') : ''}
                  </th>
                </tr>
              </thead>
              <tbody>
                {displayedItems.map((item) => (
                  <tr
                    key={item.path}
                    draggable
                    onDragStart={(e) => handleDragStart(item, e)}
                    onDragOver={(e) => {
                      if (item.isDirectory) e.preventDefault();
                    }}
                    onDrop={(e) => {
                      if (item.isDirectory) {
                        e.stopPropagation();
                        handleDrop(e, item.path);
                      }
                    }}
                    className={`file-row ${selected.has(item.path) ? 'selected' : ''}`}
                    onClick={(e) => handleSelectItem(item, e)}
                    onDoubleClick={() => openItem(item)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      if (!selected.has(item.path)) setSelected(new Set([item.path]));
                      setCtxMenu({ x: e.clientX, y: e.clientY, targetItem: item });
                    }}
                  >
                    <td>
                      <div className="name-cell">
                        {renderIcon(item)}
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          {item.name}
                        </span>
                      </div>
                    </td>
                    <td style={{ color: 'var(--text-secondary)' }}>{formatDate(item.mtime)}</td>
                    <td style={{ color: 'var(--text-secondary)' }}>{fileTypeLabel(item)}</td>
                    <td style={{ textAlign: 'right', color: 'var(--text-secondary)' }}>
                      {item.isDirectory ? '' : formatBytes(item.size)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

        {/* 列表视图 */}
        {!loading &&
          !error &&
          (tab.kind === 'local' || (tab.kind === 'remote' && tab.path)) &&
          tab.viewMode === 'list' && (
            <div className="list-grid">
              {displayedItems.map((item) => (
                <div
                  key={item.path}
                  draggable
                  onDragStart={(e) => handleDragStart(item, e)}
                  className={`list-item ${selected.has(item.path) ? 'selected' : ''}`}
                  onClick={(e) => handleSelectItem(item, e)}
                  onDoubleClick={() => openItem(item)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (!selected.has(item.path)) setSelected(new Set([item.path]));
                    setCtxMenu({ x: e.clientX, y: e.clientY, targetItem: item });
                  }}
                >
                  {renderIcon(item)}
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {item.name}
                  </span>
                </div>
              ))}
            </div>
          )}

        {/* 图标视图 */}
        {!loading &&
          !error &&
          (tab.kind === 'local' || (tab.kind === 'remote' && tab.path)) &&
          tab.viewMode === 'icons' && (
            <div className="icons-grid">
              {displayedItems.map((item) => (
                <div
                  key={item.path}
                  draggable
                  onDragStart={(e) => handleDragStart(item, e)}
                  className={`icon-card ${selected.has(item.path) ? 'selected' : ''}`}
                  onClick={(e) => handleSelectItem(item, e)}
                  onDoubleClick={() => openItem(item)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (!selected.has(item.path)) setSelected(new Set([item.path]));
                    setCtxMenu({ x: e.clientX, y: e.clientY, targetItem: item });
                  }}
                >
                  <div className="icon-thumb-box">{renderIcon(item, true)}</div>
                  <div className="icon-card-name">{item.name}</div>
                </div>
              ))}
            </div>
          )}
      </div>

      {/* 底部状态栏 */}
      <div className="pane-statusbar">
        <span>
          {tab.kind === 'thispc'
            ? `${drives.length} 个驱动器`
            : `${displayedItems.length} 个项目${selected.size ? ` · 已选 ${selected.size} 项` : ''}`}
        </span>
        <span>
          {tab.kind === 'remote' ? '互联远程 · 自动轮询' : pollMode ? '网络盘 · 轮询刷新' : '本机实时监听'}
        </span>
      </div>

      {/* 右键菜单 */}
      {ctxMenu && (
        <div
          className="context-menu"
          style={{
            left: Math.min(ctxMenu.x, window.innerWidth - 230),
            top: Math.min(ctxMenu.y, window.innerHeight - 360),
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {ctxMenu.targetItem ? (
            <>
              <button
                className="context-menu-item"
                onClick={() => {
                  openItem(ctxMenu.targetItem!);
                  setCtxMenu(null);
                }}
              >
                <ExternalLink size={14} /> 打开
              </button>
              {!ctxMenu.targetItem.isDirectory && (
                <button
                  className="context-menu-item"
                  onClick={async () => {
                    const target = ctxMenu.targetItem!;
                    setCtxMenu(null);
                    if (tab.kind === 'local') await window.api.openAs(target.path);
                    else if (tab.kind === 'remote' && device) {
                      await window.api.linkOpenAs(
                        { host: device.host, port: device.port, password: device.password },
                        target.path,
                      );
                    }
                  }}
                >
                  <ExternalLink size={14} /> 打开方式…
                </button>
              )}
              {tab.kind === 'local' && isArchive(ctxMenu.targetItem) && (
                <button
                  className="context-menu-item"
                  onClick={() => {
                    onOpenArchiveViewer(ctxMenu.targetItem!.path);
                    setCtxMenu(null);
                  }}
                >
                  <FileArchive size={14} /> 查看 / 解压压缩包
                </button>
              )}
              {tab.kind === 'local' && (
                <button
                  className="context-menu-item"
                  onClick={() => {
                    const srcs = selectedItems.length ? selectedItems : [ctxMenu.targetItem!];
                    onOpenCompressDialog(
                      tab.path,
                      srcs.map((s) => s.path),
                    );
                    setCtxMenu(null);
                  }}
                >
                  <FileArchive size={14} /> 压缩为 zip / 7z…
                </button>
              )}
              <div className="context-menu-sep" />
              <button
                className="context-menu-item"
                onClick={() => {
                  const targets = selectedItems.length ? selectedItems : [ctxMenu.targetItem!];
                  if (tab.kind !== 'thispc') onCopyItems(tab.kind, tab.deviceId, targets);
                  setCtxMenu(null);
                }}
              >
                <Copy size={14} /> 复制 (Ctrl+C)
              </button>
              <button
                className="context-menu-item"
                onClick={() => {
                  const targets = selectedItems.length ? selectedItems : [ctxMenu.targetItem!];
                  if (tab.kind !== 'thispc') onCutItems(tab.kind, tab.deviceId, targets);
                  setCtxMenu(null);
                }}
              >
                <Scissors size={14} /> 剪切 (Ctrl+X)
              </button>
              <button
                className="context-menu-item"
                onClick={() => {
                  renameItem(ctxMenu.targetItem!);
                  setCtxMenu(null);
                }}
              >
                <Edit3 size={14} /> 重命名 (F2)
              </button>
              <button
                className="context-menu-item danger"
                onClick={() => {
                  const targets = selectedItems.length ? selectedItems : [ctxMenu.targetItem!];
                  deleteSelected(targets);
                  setCtxMenu(null);
                }}
              >
                <Trash2 size={14} /> 删除
              </button>
              {tab.kind === 'local' && ctxMenu.targetItem.isDirectory && (
                <button
                  className="context-menu-item"
                  onClick={() => {
                    onPinQuickAccess(ctxMenu.targetItem!.path, ctxMenu.targetItem!.name);
                    setCtxMenu(null);
                  }}
                >
                  <Pin size={14} /> 固定到快速访问
                </button>
              )}
              <div className="context-menu-sep" />
              {tab.kind === 'local' && (
                <button
                  className="context-menu-item"
                  onClick={async () => {
                    const targets = selectedItems.length ? selectedItems : [ctxMenu.targetItem!];
                    const { x, y } = ctxMenu;
                    setCtxMenu(null);
                    const res = await window.api.shellMenu(
                      targets.map((t) => t.path),
                      x + window.screenX,
                      y + window.screenY,
                    );
                    if (res.executed) reload(true);
                    else if (!res.ok && res.error) onNotify(res.error);
                  }}
                >
                  <MoreHorizontal size={14} /> Windows 原生右键菜单
                </button>
              )}
              <button
                className="context-menu-item"
                onClick={() => {
                  onOpenProps(
                    tab.kind === 'remote' ? 'remote' : 'local',
                    device,
                    ctxMenu.targetItem!,
                  );
                  setCtxMenu(null);
                }}
              >
                <Info size={14} /> 属性
              </button>
            </>
          ) : (
            tab.kind !== 'thispc' &&
            tab.path && (
              <>
                <button
                  className="context-menu-item"
                  onClick={() => {
                    onPasteHere(tab.kind as 'local' | 'remote', tab.deviceId, tab.path);
                    setCtxMenu(null);
                  }}
                >
                  <ClipboardPaste size={14} /> 粘贴 (Ctrl+V)
                </button>
                <div className="context-menu-sep" />
                <button
                  className="context-menu-item"
                  onClick={() => {
                    createNewFolder();
                    setCtxMenu(null);
                  }}
                >
                  <FolderPlus size={14} /> 新建文件夹
                </button>
                <button
                  className="context-menu-item"
                  onClick={() => {
                    createNewFile('docx');
                    setCtxMenu(null);
                  }}
                >
                  <FilePlus size={14} /> 新建 Word 文档 (.docx)
                </button>
                <button
                  className="context-menu-item"
                  onClick={() => {
                    createNewFile('xlsx');
                    setCtxMenu(null);
                  }}
                >
                  <FilePlus size={14} /> 新建 Excel 工作表 (.xlsx)
                </button>
                <button
                  className="context-menu-item"
                  onClick={() => {
                    createNewFile('pptx');
                    setCtxMenu(null);
                  }}
                >
                  <FilePlus size={14} /> 新建 PowerPoint (.pptx)
                </button>
                <button
                  className="context-menu-item"
                  onClick={() => {
                    createNewFile('txt');
                    setCtxMenu(null);
                  }}
                >
                  <FilePlus size={14} /> 新建文本文档 (.txt)
                </button>
                <div className="context-menu-sep" />
                <button
                  className="context-menu-item"
                  onClick={() => {
                    toggleSort('name');
                    setCtxMenu(null);
                  }}
                >
                  <ArrowUpDown size={14} /> 按名称排序
                </button>
                <button
                  className="context-menu-item"
                  onClick={() => {
                    toggleSort('mtime');
                    setCtxMenu(null);
                  }}
                >
                  <ArrowUpDown size={14} /> 按修改日期排序
                </button>
                <button
                  className="context-menu-item"
                  onClick={() => {
                    toggleSort('size');
                    setCtxMenu(null);
                  }}
                >
                  <ArrowUpDown size={14} /> 按大小排序
                </button>
              </>
            )
          )}
        </div>
      )}
    </section>
  );
};
