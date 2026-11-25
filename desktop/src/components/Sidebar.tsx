/**
 * Windows 电脑版侧边栏组件
 * 包含：此电脑入口、快速访问（6个系统默认 + 用户自定义固定项）、互联设备列表（含聊天按钮与未读计数）
 */
import React from 'react';
import {
  Monitor,
  Folder,
  Download,
  FileText,
  Image,
  Music,
  Film,
  Smartphone,
  Laptop,
  MessageSquare,
  Plus,
  Wifi,
  Trash2,
} from 'lucide-react';
import type { LinkDevice, QuickAccessItem } from '../types';
import { baseName } from '../utils/format';

interface SidebarProps {
  specialPaths: Record<string, string>;
  qaNames: Record<string, string>;
  quickAccess: QuickAccessItem[];
  linkDevices: LinkDevice[];
  unreadCounts: Record<string, number>;
  serverStatus: { running: boolean; port: number; error: string };
  activeKind: 'thispc' | 'local' | 'remote';
  activePath: string;
  activeDeviceId?: string;
  onNavigateThisPc: () => void;
  onNavigateLocal: (path: string) => void;
  onNavigateDevice: (device: LinkDevice) => void;
  onOpenChat: (device: LinkDevice) => void;
  onRemoveQuickAccess: (path: string) => void;
  onOpenLinkSettings: () => void;
}

const DEFAULT_QA = [
  { key: 'desktop', label: '桌面', Icon: Monitor },
  { key: 'downloads', label: '下载', Icon: Download },
  { key: 'documents', label: '文档', Icon: FileText },
  { key: 'pictures', label: '图片', Icon: Image },
  { key: 'music', label: '音乐', Icon: Music },
  { key: 'videos', label: '视频', Icon: Film },
] as const;

export const Sidebar: React.FC<SidebarProps> = ({
  specialPaths,
  qaNames,
  quickAccess,
  linkDevices,
  unreadCounts,
  serverStatus,
  activeKind,
  activePath,
  activeDeviceId,
  onNavigateThisPc,
  onNavigateLocal,
  onNavigateDevice,
  onOpenChat,
  onRemoveQuickAccess,
  onOpenLinkSettings,
}) => {
  return (
    <aside className="sidebar">
      <div className="sidebar-section">
        <div
          className={`sidebar-item ${activeKind === 'thispc' ? 'active' : ''}`}
          onClick={onNavigateThisPc}
        >
          <Monitor size={16} />
          <span className="sidebar-item-label">此电脑</span>
        </div>
      </div>

      <div className="sidebar-section">
        <div className="sidebar-section-title">
          <span>快速访问</span>
        </div>
        {DEFAULT_QA.map(({ key, label, Icon }) => {
          const p = specialPaths[key];
          if (!p) return null;
          const display = qaNames[key]?.trim() || label;
          return (
            <div
              key={key}
              className={`sidebar-item ${activeKind === 'local' && activePath === p ? 'active' : ''}`}
              onClick={() => onNavigateLocal(p)}
              title={p}
            >
              <Icon size={15} />
              <span className="sidebar-item-label">{display}</span>
            </div>
          );
        })}
        {quickAccess.map((item) => (
          <div
            key={item.path}
            className={`sidebar-item ${activeKind === 'local' && activePath === item.path ? 'active' : ''}`}
            onClick={() => onNavigateLocal(item.path)}
            title={item.path}
          >
            <Folder size={15} />
            <span className="sidebar-item-label">{item.name || baseName(item.path)}</span>
            <button
              title="从快速访问移除"
              onClick={(e) => {
                e.stopPropagation();
                onRemoveQuickAccess(item.path);
              }}
              style={{ padding: 2 }}
            >
              <Trash2 size={12} />
            </button>
          </div>
        ))}
      </div>

      <div className="sidebar-section">
        <div className="sidebar-section-title">
          <span>互联设备</span>
          <button onClick={onOpenLinkSettings} title="管理与扫描互联设备" style={{ padding: 2 }}>
            <Plus size={14} />
          </button>
        </div>

        <div className="sidebar-item" onClick={onOpenLinkSettings} title="配置本机互联服务">
          <span className={`status-dot ${serverStatus.running ? 'online' : ''}`} />
          <Wifi size={14} />
          <span className="sidebar-item-label">
            {serverStatus.running ? `本机服务 :${serverStatus.port}` : '本机互联未开启'}
          </span>
        </div>

        {linkDevices.length === 0 && (
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', padding: '6px 8px' }}>
            暂无已添加设备，点右上角 + 扫描或添加
          </div>
        )}

        {linkDevices.map((dev) => {
          const unread = unreadCounts[dev.id] || 0;
          const DevIcon = dev.type === 'phone' ? Smartphone : Laptop;
          return (
            <div
              key={dev.id}
              className={`sidebar-item ${activeKind === 'remote' && activeDeviceId === dev.id ? 'active' : ''}`}
              onClick={() => onNavigateDevice(dev)}
              title={`${dev.host}:${dev.port}`}
            >
              <DevIcon size={15} />
              <span className="sidebar-item-label">{dev.name}</span>
              {unread > 0 && <span className="unread-badge">{unread}</span>}
              <button
                title={`与 ${dev.name} 聊天`}
                onClick={(e) => {
                  e.stopPropagation();
                  onOpenChat(dev);
                }}
                style={{ padding: 3 }}
              >
                <MessageSquare size={14} />
              </button>
            </div>
          );
        })}
      </div>
    </aside>
  );
};
