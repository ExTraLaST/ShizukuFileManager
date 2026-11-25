/**
 * Shizuku 文件管理器 — Windows 电脑版主应用入口
 * 实现 Win11 风格多窗格 (1 / 2左右 / 2上下 / 4)、多标签页、系统剪贴板互通、
 * 内置互联服务端与客户端、传输进度浮条与深浅色主题切换。
 */
import React, { useEffect, useState } from 'react';
import {
  Minus,
  Square,
  X,
  Columns,
  Rows,
  LayoutGrid,
  Maximize2,
  ArrowLeftRight,
  Sun,
  Moon,
  Wifi,
  FolderOpen,
} from 'lucide-react';
import type {
  AppSettings,
  ClipboardState,
  DriveInfo,
  FileItem,
  LayoutMode,
  LinkDevice,
  PaneTab,
  TransferProgressEvent,
} from './types';
import { Sidebar } from './components/Sidebar';
import { FilePane } from './components/FilePane';
import {
  ArchiveViewerModal,
  ChatModal,
  CompressModal,
  LinkSettingsModal,
  PropertiesModal,
} from './components/Modals';
import { baseName, formatBytes } from './utils/format';

function createInitialTab(): PaneTab {
  return {
    id: `tab-${Math.random().toString(36).slice(2, 9)}`,
    title: '此电脑',
    kind: 'thispc',
    path: '',
    history: [{ kind: 'thispc', path: '' }],
    historyIndex: 0,
    viewMode: 'details',
    sortField: 'name',
    sortOrder: 'asc',
    filterText: '',
    searchQuery: '',
    searchMode: false,
  };
}

interface PaneModel {
  id: string;
  tabs: PaneTab[];
  activeTabId: string;
}

function createInitialPanes(): PaneModel[] {
  return ['pane-1', 'pane-2', 'pane-3', 'pane-4'].map((id) => {
    const t = createInitialTab();
    return { id, tabs: [t], activeTabId: t.id };
  });
}

export const App: React.FC = () => {
  const [settings, setSettings] = useState<AppSettings>({});
  const [dark, setDark] = useState(false);
  const [layoutMode, setLayoutMode] = useState<LayoutMode>('2h');
  const [panes, setPanes] = useState<PaneModel[]>(createInitialPanes);
  const [activePaneId, setActivePaneId] = useState('pane-1');
  const [drives, setDrives] = useState<DriveInfo[]>([]);
  const [specialPaths, setSpecialPaths] = useState<Record<string, string>>({});
  const [serverStatus, setServerStatus] = useState({ running: false, port: 0, error: '' });
  const [unreadCounts, setUnreadCounts] = useState<Record<string, number>>({});
  const [clipboardState, setClipboardState] = useState<ClipboardState | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);

  // 弹窗与浮条状态
  const [showLinkSettings, setShowLinkSettings] = useState(false);
  const [chatDevice, setChatDevice] = useState<LinkDevice | null>(null);
  const [archiveViewPath, setArchiveViewPath] = useState<string | null>(null);
  const [compressReq, setCompressReq] = useState<{ destDir: string; sources: string[] } | null>(
    null,
  );
  const [propsModal, setPropsModal] = useState<{ kind: 'local' | 'remote'; item: FileItem } | null>(
    null,
  );
  const [transfer, setTransfer] = useState<TransferProgressEvent | null>(null);
  const [toast, setToast] = useState('');

  const notify = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast((cur) => (cur === msg ? '' : cur)), 3200);
  };

  const refreshDrives = () => window.api.drives().then(setDrives).catch(() => {});
  const refreshUnread = () => window.api.msgUnread().then(setUnreadCounts).catch(() => {});
  const refreshServerStatus = () => window.api.linkServerStatus().then(setServerStatus).catch(() => {});

  useEffect(() => {
    window.api.settingsGet().then((s) => {
      setSettings(s);
      if (s.layoutMode) setLayoutMode(s.layoutMode);
    });
    window.api.themeGet().then((t) => setDark(t.dark));
    window.api.special().then(setSpecialPaths);
    refreshDrives();
    refreshUnread();
    refreshServerStatus();

    const offTheme = window.api.onThemeUpdated(setDark);
    const offTransfer = window.api.onTransferProgress(setTransfer);
    const offMessage = window.api.onMessage(() => refreshUnread());
    return () => {
      offTheme();
      offTransfer();
      offMessage();
    };
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  }, [dark]);

  const visibleCount = layoutMode === '1' ? 1 : layoutMode === '4' ? 4 : 2;
  const visiblePanes = panes.slice(0, visibleCount);
  const activePane = visiblePanes.find((p) => p.id === activePaneId) || visiblePanes[0];
  const activeTab =
    activePane.tabs.find((t) => t.id === activePane.activeTabId) || activePane.tabs[0];

  const saveSettings = async (patch: Partial<AppSettings>) => {
    const merged = await window.api.settingsSet(patch);
    setSettings(merged);
  };

  const updatePane = (paneId: string, updater: (p: PaneModel) => PaneModel) => {
    setPanes((prev) => prev.map((p) => (p.id === paneId ? updater(p) : p)));
  };

  const navigateInPane = (
    paneId: string,
    tabId: string,
    target: { kind: 'thispc' | 'local' | 'remote'; path: string; deviceId?: string; title?: string },
  ) => {
    updatePane(paneId, (pane) => ({
      ...pane,
      tabs: pane.tabs.map((t) => {
        if (t.id !== tabId) return t;
        const nextHistory = [
          ...t.history.slice(0, t.historyIndex + 1),
          { kind: target.kind, path: target.path, deviceId: target.deviceId },
        ];
        return {
          ...t,
          kind: target.kind,
          path: target.path,
          deviceId: target.deviceId,
          title:
            target.title ||
            (target.kind === 'thispc' ? '此电脑' : baseName(target.path) || '根目录'),
          history: nextHistory,
          historyIndex: nextHistory.length - 1,
          filterText: '',
          searchMode: false,
        };
      }),
    }));
  };

  const swapFirstTwoPanes = () => {
    setPanes((prev) => {
      if (prev.length < 2) return prev;
      const copy = [...prev];
      const tmp = copy[0];
      copy[0] = { ...copy[1], id: 'pane-1' };
      copy[1] = { ...tmp, id: 'pane-2' };
      return copy;
    });
  };

  const getDevice = (id?: string) => (settings.linkDevices || []).find((d) => d.id === id);

  // 剪贴板复制/剪切（本机文件同步写入 Windows 系统剪贴板 CF_HDROP）
  const handleCopyOrCut = async (
    mode: 'copy' | 'cut',
    srcKind: 'local' | 'remote',
    deviceId: string | undefined,
    items: FileItem[],
  ) => {
    setClipboardState({ mode, srcKind, deviceId, items });
    if (srcKind === 'local') {
      await window.api.clipWriteFiles(
        mode,
        items.map((i) => i.path),
      );
    }
    notify(`已${mode === 'cut' ? '剪切' : '复制'} ${items.length} 个项目`);
  };

  // 粘贴（优先内部剪贴板；若为空则自动读取 Windows 系统剪贴板以互通资源管理器）
  const handlePaste = async (
    dstKind: 'local' | 'remote',
    dstDeviceId: string | undefined,
    destDir: string,
  ) => {
    let clip = clipboardState;
    if (!clip) {
      const sys = await window.api.clipReadFiles();
      if (sys && sys.paths.length > 0) {
        clip = {
          mode: sys.mode,
          srcKind: 'local',
          items: sys.paths.map((p) => ({
            name: baseName(p),
            path: p,
            isDirectory: false,
            size: 0,
            mtime: 0,
            extension: '',
          })),
        };
      }
    }
    if (!clip || !clip.items.length) {
      notify('剪贴板为空');
      return;
    }

    try {
      if (clip.srcKind === 'local' && dstKind === 'local') {
        const paths = clip.items.map((i) => i.path);
        if (clip.mode === 'cut') {
          await window.api.move(paths, destDir);
          await window.api.clipClearIfMatch(paths);
          setClipboardState(null);
        } else {
          await window.api.copy(paths, destDir);
        }
        setRefreshToken((n) => n + 1);
        notify('粘贴完成');
        return;
      }

      const srcDev = getDevice(clip.deviceId);
      const dstDev = getDevice(dstDeviceId);
      const id = `tr-${Date.now()}`;
      const res = await window.api.linkTransfer({
        id,
        mode: clip.mode,
        srcKind: clip.srcKind,
        srcConn: srcDev
          ? { host: srcDev.host, port: srcDev.port, password: srcDev.password }
          : undefined,
        sources: clip.items.map((i) => ({
          path: i.path,
          name: i.name,
          isDirectory: i.isDirectory,
          size: i.size,
        })),
        dstKind,
        dstConn: dstDev
          ? { host: dstDev.host, port: dstDev.port, password: dstDev.password }
          : undefined,
        destDir,
      });
      setTransfer(null);
      if (res.ok) {
        if (clip.mode === 'cut') setClipboardState(null);
        setRefreshToken((n) => n + 1);
        notify('跨设备传输完成');
      } else {
        notify(res.error || '传输失败');
      }
    } catch (e) {
      setTransfer(null);
      notify((e as Error).message || '粘贴失败');
    }
  };

  // 拖放传输
  const handleDropTransfer = async (
    payload: { srcKind: 'local' | 'remote'; srcDeviceId?: string; items: FileItem[] },
    dstKind: 'local' | 'remote',
    dstDeviceId: string | undefined,
    destDir: string,
    copy: boolean,
  ) => {
    const mode: 'copy' | 'cut' =
      copy || payload.srcKind !== dstKind || payload.srcDeviceId !== dstDeviceId ? 'copy' : 'cut';
    if (payload.srcKind === 'local' && dstKind === 'local') {
      const paths = payload.items.map((i) => i.path);
      if (mode === 'cut') await window.api.move(paths, destDir);
      else await window.api.copy(paths, destDir);
      setRefreshToken((n) => n + 1);
      return;
    }
    const srcDev = getDevice(payload.srcDeviceId);
    const dstDev = getDevice(dstDeviceId);
    const res = await window.api.linkTransfer({
      id: `drop-${Date.now()}`,
      mode,
      srcKind: payload.srcKind,
      srcConn: srcDev
        ? { host: srcDev.host, port: srcDev.port, password: srcDev.password }
        : undefined,
      sources: payload.items.map((i) => ({
        path: i.path,
        name: i.name,
        isDirectory: i.isDirectory,
        size: i.size,
      })),
      dstKind,
      dstConn: dstDev
        ? { host: dstDev.host, port: dstDev.port, password: dstDev.password }
        : undefined,
      destDir,
    });
    setTransfer(null);
    if (res.ok) setRefreshToken((n) => n + 1);
    else notify(res.error || '拖放传输失败');
  };

  return (
    <div className="app-shell">
      {/* Win11 顶部标题栏 */}
      <header className="titlebar">
        <div className="titlebar-left">
          <div className="app-brand">
            <FolderOpen size={17} color="var(--accent)" />
            <span>Shizuku 文件管理器</span>
          </div>

          <button
            title="单窗格"
            style={{ background: layoutMode === '1' ? 'var(--bg-selected)' : undefined }}
            onClick={() => {
              setLayoutMode('1');
              saveSettings({ layoutMode: '1' });
            }}
          >
            <Maximize2 size={14} />
          </button>
          <button
            title="左右双窗格"
            style={{ background: layoutMode === '2h' ? 'var(--bg-selected)' : undefined }}
            onClick={() => {
              setLayoutMode('2h');
              saveSettings({ layoutMode: '2h' });
            }}
          >
            <Columns size={14} />
          </button>
          <button
            title="上下双窗格"
            style={{ background: layoutMode === '2v' ? 'var(--bg-selected)' : undefined }}
            onClick={() => {
              setLayoutMode('2v');
              saveSettings({ layoutMode: '2v' });
            }}
          >
            <Rows size={14} />
          </button>
          <button
            title="四窗格"
            style={{ background: layoutMode === '4' ? 'var(--bg-selected)' : undefined }}
            onClick={() => {
              setLayoutMode('4');
              saveSettings({ layoutMode: '4' });
            }}
          >
            <LayoutGrid size={14} />
          </button>
          {visibleCount >= 2 && (
            <button title="交换前两个窗格" onClick={swapFirstTwoPanes}>
              <ArrowLeftRight size={14} />
            </button>
          )}
        </div>

        <div className="titlebar-actions">
          <button onClick={() => setShowLinkSettings(true)} title="互联服务与设备设置">
            <Wifi size={14} color={serverStatus.running ? 'var(--success)' : undefined} />
            <span>互联</span>
          </button>
          <button
            title="切换深浅色主题"
            onClick={async () => {
              const res = await window.api.themeSet(dark ? 'light' : 'dark');
              setDark(res.dark);
            }}
          >
            {dark ? <Sun size={14} /> : <Moon size={14} />}
          </button>
          <div className="win-controls">
            <button className="win-btn" onClick={() => window.api.winMinimize()}>
              <Minus size={14} />
            </button>
            <button className="win-btn" onClick={() => window.api.winMaximize()}>
              <Square size={12} />
            </button>
            <button className="win-btn close" onClick={() => window.api.winClose()}>
              <X size={15} />
            </button>
          </div>
        </div>
      </header>

      {/* 主体：侧边栏 + 多窗格 */}
      <div className="workspace">
        <Sidebar
          specialPaths={specialPaths}
          qaNames={settings.qaNames || {}}
          quickAccess={settings.quickAccess || []}
          linkDevices={settings.linkDevices || []}
          unreadCounts={unreadCounts}
          serverStatus={serverStatus}
          activeKind={activeTab.kind}
          activePath={activeTab.path}
          activeDeviceId={activeTab.deviceId}
          onNavigateThisPc={() => {
            refreshDrives();
            navigateInPane(activePane.id, activeTab.id, { kind: 'thispc', path: '', title: '此电脑' });
          }}
          onNavigateLocal={(p) =>
            navigateInPane(activePane.id, activeTab.id, { kind: 'local', path: p, title: baseName(p) })
          }
          onNavigateDevice={(dev) =>
            navigateInPane(activePane.id, activeTab.id, {
              kind: 'remote',
              path: '',
              deviceId: dev.id,
              title: dev.name,
            })
          }
          onOpenChat={setChatDevice}
          onRemoveQuickAccess={(p) => {
            const next = (settings.quickAccess || []).filter((x) => x.path !== p);
            saveSettings({ quickAccess: next });
          }}
          onOpenLinkSettings={() => setShowLinkSettings(true)}
        />

        <main className={`panes-grid layout-${layoutMode}`}>
          {visiblePanes.map((pane) => (
            <FilePane
              key={pane.id}
              paneId={pane.id}
              isActive={pane.id === activePane.id}
              tabs={pane.tabs}
              activeTabId={pane.activeTabId}
              drives={drives}
              linkDevices={settings.linkDevices || []}
              refreshToken={refreshToken}
              onFocusPane={() => setActivePaneId(pane.id)}
              onSelectTab={(tabId) => updatePane(pane.id, (p) => ({ ...p, activeTabId: tabId }))}
              onNewTab={() =>
                updatePane(pane.id, (p) => {
                  const nt = createInitialTab();
                  return { ...p, tabs: [...p.tabs, nt], activeTabId: nt.id };
                })
              }
              onCloseTab={(tabId) =>
                updatePane(pane.id, (p) => {
                  if (p.tabs.length <= 1) return p;
                  const next = p.tabs.filter((t) => t.id !== tabId);
                  return {
                    ...p,
                    tabs: next,
                    activeTabId: p.activeTabId === tabId ? next[0].id : p.activeTabId,
                  };
                })
              }
              onUpdateTab={(tabId, updater) =>
                updatePane(pane.id, (p) => ({
                  ...p,
                  tabs: p.tabs.map((t) => (t.id === tabId ? updater(t) : t)),
                }))
              }
              onNavigate={(tabId, target) => navigateInPane(pane.id, tabId, target)}
              onCopyItems={(kind, devId, items) => handleCopyOrCut('copy', kind, devId, items)}
              onCutItems={(kind, devId, items) => handleCopyOrCut('cut', kind, devId, items)}
              onPasteHere={handlePaste}
              onDropTransfer={handleDropTransfer}
              onPinQuickAccess={(p, n) => {
                const cur = settings.quickAccess || [];
                if (cur.some((x) => x.path === p)) return;
                saveSettings({ quickAccess: [...cur, { path: p, name: n }] });
                notify(`已固定 ${n} 到快速访问`);
              }}
              onOpenArchiveViewer={setArchiveViewPath}
              onOpenCompressDialog={(destDir, sources) => setCompressReq({ destDir, sources })}
              onOpenProps={(kind, _dev, item) => setPropsModal({ kind, item })}
              onNotify={notify}
            />
          ))}
        </main>
      </div>

      {/* 弹窗集合 */}
      {archiveViewPath && (
        <ArchiveViewerModal
          archivePath={archiveViewPath}
          onClose={() => setArchiveViewPath(null)}
          onExtracted={() => setRefreshToken((n) => n + 1)}
          onNotify={notify}
        />
      )}
      {compressReq && (
        <CompressModal
          destDir={compressReq.destDir}
          sources={compressReq.sources}
          onClose={() => setCompressReq(null)}
          onDone={() => setRefreshToken((n) => n + 1)}
          onNotify={notify}
        />
      )}
      {chatDevice && (
        <ChatModal
          device={chatDevice}
          onClose={() => setChatDevice(null)}
          onRefreshUnread={refreshUnread}
          onNotify={notify}
        />
      )}
      {showLinkSettings && (
        <LinkSettingsModal
          settings={settings}
          serverStatus={serverStatus}
          onClose={() => setShowLinkSettings(false)}
          onSaveSettings={saveSettings}
          onApplyServer={async () => {
            const st = await window.api.linkApplyServer();
            setServerStatus(st);
          }}
          onNotify={notify}
        />
      )}
      {propsModal && (
        <PropertiesModal
          kind={propsModal.kind}
          item={propsModal.item}
          onClose={() => setPropsModal(null)}
        />
      )}

      {/* 实时传输进度与速率浮条 */}
      {transfer && (
        <div className="floating-bar">
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
            <strong style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              正在传输：{transfer.currentFile}
            </strong>
            <button onClick={() => window.api.linkCancelTransfer(transfer.id)}>取消</button>
          </div>
          <div className="capacity-bar" style={{ marginBottom: 6 }}>
            <div
              className="capacity-fill"
              style={{
                width: `${transfer.totalBytes > 0 ? Math.min(100, Math.round((transfer.doneBytes / transfer.totalBytes) * 100)) : 50}%`,
              }}
            />
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', display: 'flex', justifyContent: 'space-between' }}>
            <span>
              {formatBytes(transfer.doneBytes)} / {formatBytes(transfer.totalBytes)} ({transfer.doneCount}/
              {transfer.totalCount})
            </span>
            <span>{formatBytes(transfer.speedBytesPerSec)}/s</span>
          </div>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
};
