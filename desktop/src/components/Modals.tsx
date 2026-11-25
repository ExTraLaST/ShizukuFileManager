/**
 * 电脑版功能弹窗集合：
 * 1. 压缩包查看与解压弹窗
 * 2. 创建压缩包弹窗
 * 3. 互联聊天与附件面板
 * 4. 互联服务与设备发现管理弹窗
 * 5. 文件/文件夹属性与扩展属性弹窗
 */
import React, { useEffect, useState } from 'react';
import {
  X,
  Folder,
  File,
  Lock,
  Paperclip,
  Send,
  Radar,
  Trash2,
  Download,
} from 'lucide-react';
import type {
  AppSettings,
  ArchiveEntry,
  DiscoveredDevice,
  FileItem,
  LinkDevice,
  MessageRecord,
} from '../types';
import { baseName, formatBytes, formatDate } from '../utils/format';

// ---------------- 1. 压缩包查看与解压 ----------------

export const ArchiveViewerModal: React.FC<{
  archivePath: string;
  onClose: () => void;
  onExtracted: () => void;
  onNotify: (m: string) => void;
}> = ({ archivePath, onClose, onExtracted, onNotify }) => {
  const [entries, setEntries] = useState<ArchiveEntry[]>([]);
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const loadList = async (pwd = password) => {
    setLoading(true);
    setError('');
    const res = await window.api.archiveList({ archivePath, password: pwd || undefined });
    setLoading(false);
    if (res.ok && res.entries) setEntries(res.entries);
    else setError(res.error || '无法读取压缩包内容');
  };

  useEffect(() => {
    loadList('');
  }, [archivePath]);

  const extract = async (onlySelected: boolean) => {
    const parent = await window.api.parent(archivePath);
    const stem = baseName(archivePath).replace(/\.[^.]+$/, '');
    const outDir = `${parent}\\${stem}`;
    const res = await window.api.archiveExtract({
      id: `ext-${Date.now()}`,
      archivePath,
      outDir,
      password: password || undefined,
      entries: onlySelected && selected.size > 0 ? [...selected] : undefined,
    });
    if (res.ok) {
      onNotify(`已解压到 ${outDir}`);
      onExtracted();
      onClose();
    } else {
      onNotify(res.error || '解压失败');
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span>压缩包查看 — {baseName(archivePath)}</span>
          <button onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        <div className="modal-body">
          <div className="form-inline" style={{ marginBottom: 10 }}>
            <input
              type="password"
              placeholder="若压缩包已加密，请输入密码"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              style={{ flex: 1 }}
            />
            <button onClick={() => loadList(password)}>重新读取</button>
          </div>
          {loading && <div>正在读取压缩包条目...</div>}
          {error && <div style={{ color: 'var(--danger)', marginBottom: 8 }}>{error}</div>}
          {!loading && entries.length > 0 && (
            <table className="details-table">
              <thead>
                <tr>
                  <th style={{ width: '64%' }}>路径</th>
                  <th style={{ width: '18%', textAlign: 'right' }}>原始大小</th>
                  <th style={{ width: '18%', textAlign: 'right' }}>压缩后</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((ent) => (
                  <tr
                    key={ent.path}
                    className={`file-row ${selected.has(ent.path) ? 'selected' : ''}`}
                    onClick={() =>
                      setSelected((prev) => {
                        const n = new Set(prev);
                        if (n.has(ent.path)) n.delete(ent.path);
                        else n.add(ent.path);
                        return n;
                      })
                    }
                  >
                    <td>
                      <div className="name-cell">
                        {ent.isDirectory ? <Folder size={14} color="#f5b82e" /> : <File size={14} />}
                        <span>{ent.path}</span>
                        {ent.encrypted && <Lock size={12} color="var(--danger)" />}
                      </div>
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      {ent.isDirectory ? '' : formatBytes(ent.size)}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      {ent.isDirectory ? '' : formatBytes(ent.packedSize)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div className="modal-footer">
          {selected.size > 0 && (
            <button onClick={() => extract(true)}>
              <Download size={14} /> 解压选中 ({selected.size})
            </button>
          )}
          <button className="primary" onClick={() => extract(false)}>
            <Download size={14} /> 全部解压到同名文件夹
          </button>
        </div>
      </div>
    </div>
  );
};

// ---------------- 2. 创建压缩包 ----------------

export const CompressModal: React.FC<{
  destDir: string;
  sources: string[];
  onClose: () => void;
  onDone: () => void;
  onNotify: (m: string) => void;
}> = ({ destDir, sources, onClose, onDone, onNotify }) => {
  const defaultName = sources.length === 1 ? baseName(sources[0]).replace(/\.[^.]+$/, '') : '归档';
  const [name, setName] = useState(defaultName);
  const [format, setFormat] = useState<'zip' | '7z'>('zip');
  const [level, setLevel] = useState('normal');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setBusy(true);
    const res = await window.api.archiveCompress({
      id: `cmp-${Date.now()}`,
      format,
      level,
      password: password || undefined,
      destDir,
      archiveName: name.trim(),
      sources,
    });
    setBusy(false);
    if (res.ok) {
      onNotify(`已生成 ${name.trim()}.${format}`);
      onDone();
      onClose();
    } else {
      onNotify(res.error || '压缩失败');
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card" style={{ width: 420 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span>创建压缩包（共 {sources.length} 项）</span>
          <button onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        <div className="modal-body">
          <div className="form-row">
            <label>压缩包名称（不含后缀）</label>
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="form-row">
            <label>格式</label>
            <select value={format} onChange={(e) => setFormat(e.target.value as 'zip' | '7z')}>
              <option value="zip">ZIP（加密时自动采用 AES-256）</option>
              <option value="7z">7Z（高压缩率）</option>
            </select>
          </div>
          <div className="form-row">
            <label>压缩级别</label>
            <select value={level} onChange={(e) => setLevel(e.target.value)}>
              <option value="fastest">最快 (存储)</option>
              <option value="fast">快速</option>
              <option value="normal">标准</option>
              <option value="maximum">较高</option>
              <option value="ultra">极限</option>
            </select>
          </div>
          <div className="form-row">
            <label>密码（可选）</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="留空则不加密"
            />
          </div>
        </div>
        <div className="modal-footer">
          <button onClick={onClose}>取消</button>
          <button className="primary" disabled={busy || !name.trim()} onClick={run}>
            {busy ? '正在压缩...' : '开始压缩'}
          </button>
        </div>
      </div>
    </div>
  );
};

// ---------------- 3. 互联聊天与附件面板 ----------------

export const ChatModal: React.FC<{
  device: LinkDevice;
  onClose: () => void;
  onRefreshUnread: () => void;
  onNotify: (m: string) => void;
}> = ({ device, onClose, onRefreshUnread, onNotify }) => {
  const [messages, setMessages] = useState<MessageRecord[]>([]);
  const [text, setText] = useState('');
  const [att, setAtt] = useState<{ localPath: string; name: string; size: number; mime: string } | null>(
    null,
  );
  const [sending, setSending] = useState(false);

  const load = async () => {
    const list = await window.api.msgList(device.id);
    setMessages(list);
    await window.api.msgMarkRead(device.id);
    onRefreshUnread();
  };

  useEffect(() => {
    load();
    const off = window.api.onMessage((m) => {
      if (m.deviceId === device.id) load();
    });
    return off;
  }, [device.id]);

  const send = async () => {
    if (!text.trim() && !att) return;
    setSending(true);
    try {
      await window.api.msgSend(
        { host: device.host, port: device.port, password: device.password },
        device.id,
        text.trim(),
        att,
      );
      setText('');
      setAtt(null);
      await load();
    } catch (e) {
      onNotify((e as Error).message || '发送失败');
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span>
            与 {device.name} 聊天 ({device.host}:{device.port})
          </span>
          <button onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        <div className="modal-body">
          <div className="chat-messages">
            {messages.length === 0 && (
              <div style={{ textAlign: 'center', color: 'var(--text-secondary)', padding: 30 }}>
                暂无消息记录，可发送文字或任意文件附件
              </div>
            )}
            {messages.map((m) => (
              <div key={m.id} className={`chat-bubble ${m.dir === 'out' ? 'out' : ''}`}>
                {m.text && <div style={{ whiteSpace: 'pre-wrap' }}>{m.text}</div>}
                {m.attachment && (
                  <button
                    style={{
                      marginTop: m.text ? 6 : 0,
                      border: '1px solid var(--border-strong)',
                      background: 'var(--bg-surface)',
                    }}
                    onClick={async () => {
                      const r = await window.api.msgOpenAttachment(device.id, m.attachment!.fileId);
                      if (!r.ok) onNotify(r.error || '无法打开附件');
                    }}
                  >
                    <Paperclip size={13} /> {m.attachment.name} ({formatBytes(m.attachment.size)})
                  </button>
                )}
                <div className="chat-meta">{formatDate(m.time)}</div>
              </div>
            ))}
          </div>
        </div>
        <div className="modal-footer" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
          {att && (
            <div className="form-inline" style={{ fontSize: 12 }}>
              <Paperclip size={13} />
              <span style={{ flex: 1 }}>
                待发送附件：{att.name} ({formatBytes(att.size)})
              </span>
              <button onClick={() => setAtt(null)}>移除</button>
            </div>
          )}
          <div className="form-inline">
            <button
              onClick={async () => {
                const picked = await window.api.msgPickAttachment();
                if (picked) setAtt(picked);
              }}
              title="选择附件"
            >
              <Paperclip size={15} />
            </button>
            <input
              style={{ flex: 1 }}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              placeholder="输入消息，按 Enter 发送..."
            />
            <button className="primary" disabled={sending || (!text.trim() && !att)} onClick={send}>
              <Send size={14} /> 发送
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

// ---------------- 4. 互联设置与 UDP 扫描弹窗 ----------------

export const LinkSettingsModal: React.FC<{
  settings: AppSettings;
  serverStatus: { running: boolean; port: number; error: string };
  onClose: () => void;
  onSaveSettings: (patch: Partial<AppSettings>) => Promise<void>;
  onApplyServer: () => Promise<void>;
  onNotify: (m: string) => void;
}> = ({ settings, serverStatus, onClose, onSaveSettings, onApplyServer, onNotify }) => {
  const srv = settings.linkServer || { enabled: false, port: 8898, password: '', name: '' };
  const [enabled, setEnabled] = useState(srv.enabled);
  const [port, setPort] = useState(String(srv.port || 8898));
  const [password, setPassword] = useState(srv.password || '');
  const [name, setName] = useState(srv.name || '');
  const [retention, setRetention] = useState(settings.messageRetention || '30d');
  const [lanIps, setLanIps] = useState<string[]>([]);

  const [scanning, setScanning] = useState(false);
  const [discovered, setDiscovered] = useState<DiscoveredDevice[]>([]);
  const [newHost, setNewHost] = useState('');
  const [newPort, setNewPort] = useState('8898');
  const [newPwd, setNewPwd] = useState('');

  useEffect(() => {
    window.api.linkLocalAddrs().then(setLanIps);
  }, []);

  const saveServer = async () => {
    await onSaveSettings({
      linkServer: {
        enabled,
        port: Number(port) || 8898,
        password: password.trim(),
        name: name.trim(),
      },
      messageRetention: retention,
    });
    await onApplyServer();
    onNotify('互联服务端配置已保存');
  };

  const scan = async () => {
    setScanning(true);
    try {
      const list = await window.api.linkScan();
      setDiscovered(list);
      if (list.length === 0) onNotify('未扫描到局域网内其他互联设备');
    } finally {
      setScanning(false);
    }
  };

  const addDevice = async (host: string, p: number, pwd: string) => {
    try {
      const info = await window.api.linkTest({ host, port: p, password: pwd });
      const devId = info.id || `${host}:${p}`;
      const existing = settings.linkDevices || [];
      const next: LinkDevice[] = [
        ...existing.filter((d) => d.id !== devId),
        { id: devId, name: info.name, type: info.type, host, port: p, password: pwd },
      ];
      await onSaveSettings({ linkDevices: next });
      onNotify(`已连接并保存设备：${info.name}`);
      setNewHost('');
      setNewPwd('');
    } catch (e) {
      onNotify((e as Error).message || '连接失败');
    }
  };

  const removeDevice = async (id: string) => {
    const next = (settings.linkDevices || []).filter((d) => d.id !== id);
    await onSaveSettings({ linkDevices: next });
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span>Shizuku 互联设置与设备管理</span>
          <button onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        <div className="modal-body">
          <h4 style={{ margin: '0 0 8px' }}>本机互联服务（被手机/其他电脑访问）</h4>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 10 }}>
            本机 UUID：<code>{settings.deviceId}</code> · 局域网 IP：
            <code>{lanIps.join(', ') || '未检测到'}</code> · 状态：
            <strong style={{ color: serverStatus.running ? 'var(--success)' : 'var(--text-secondary)' }}>
              {serverStatus.running
                ? `运行中 (:${serverStatus.port})`
                : serverStatus.error || '未开启'}
            </strong>
          </div>
          <div className="form-inline" style={{ marginBottom: 10 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input
                type="checkbox"
                checked={enabled}
                onChange={(e) => setEnabled(e.target.checked)}
              />
              开启本机互联服务（自动监听 UDP 8897）
            </label>
          </div>
          <div className="form-inline" style={{ marginBottom: 10 }}>
            <input
              placeholder="设备名称"
              value={name}
              onChange={(e) => setName(e.target.value)}
              style={{ flex: 1 }}
            />
            <input
              placeholder="端口"
              value={port}
              onChange={(e) => setPort(e.target.value)}
              style={{ width: 84 }}
            />
            <input
              type="password"
              placeholder="访问密码（必填）"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              style={{ flex: 1 }}
            />
          </div>
          <div className="form-inline" style={{ marginBottom: 16 }}>
            <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>聊天消息保留期：</span>
            <select
              value={retention}
              onChange={(e) =>
                setRetention(e.target.value as '7d' | '30d' | '90d' | 'forever')
              }
            >
              <option value="7d">7 天</option>
              <option value="30d">30 天</option>
              <option value="90d">90 天</option>
              <option value="forever">永久保留</option>
            </select>
            <button className="primary" onClick={saveServer} style={{ marginLeft: 'auto' }}>
              保存并应用服务
            </button>
          </div>

          <hr style={{ border: 'none', borderTop: '1px solid var(--border-subtle)', margin: '14px 0' }} />

          <div className="form-inline" style={{ marginBottom: 8 }}>
            <h4 style={{ margin: 0, flex: 1 }}>发现与添加远程设备</h4>
            <button onClick={scan} disabled={scanning}>
              <Radar size={14} /> {scanning ? '扫描局域网中...' : 'UDP 自动发现'}
            </button>
          </div>

          {discovered.map((d) => (
            <div
              key={`${d.host}:${d.port}`}
              className="form-inline"
              style={{
                padding: '6px 8px',
                borderRadius: 6,
                background: 'var(--bg-toolbar)',
                marginBottom: 6,
              }}
            >
              <span style={{ flex: 1 }}>
                {d.name} ({d.type === 'phone' ? '手机' : '电脑'}) · {d.host}:{d.port}
              </span>
              <button
                onClick={() => {
                  setNewHost(d.host);
                  setNewPort(String(d.port));
                }}
              >
                填入
              </button>
            </div>
          ))}

          <div className="form-inline" style={{ marginTop: 8, marginBottom: 12 }}>
            <input
              placeholder="对方 IP 地址"
              value={newHost}
              onChange={(e) => setNewHost(e.target.value)}
              style={{ flex: 1 }}
            />
            <input
              placeholder="端口"
              value={newPort}
              onChange={(e) => setNewPort(e.target.value)}
              style={{ width: 76 }}
            />
            <input
              type="password"
              placeholder="对方密码"
              value={newPwd}
              onChange={(e) => setNewPwd(e.target.value)}
              style={{ flex: 1 }}
            />
            <button
              className="primary"
              disabled={!newHost.trim() || !newPwd}
              onClick={() => addDevice(newHost.trim(), Number(newPort) || 8898, newPwd)}
            >
              测试并添加
            </button>
          </div>

          {(settings.linkDevices || []).map((dev) => (
            <div
              key={dev.id}
              className="form-inline"
              style={{ padding: '5px 8px', borderBottom: '1px solid var(--border-subtle)' }}
            >
              <span style={{ flex: 1 }}>
                {dev.name} ({dev.host}:{dev.port})
              </span>
              <button className="danger" onClick={() => removeDevice(dev.id)}>
                <Trash2 size={13} /> 移除
              </button>
            </div>
          ))}
        </div>
        <div className="modal-footer">
          <button onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>
  );
};

// ---------------- 5. 属性详情弹窗 ----------------

export const PropertiesModal: React.FC<{
  kind: 'local' | 'remote';
  item: FileItem;
  onClose: () => void;
}> = ({ kind, item, onClose }) => {
  const [extProps, setExtProps] = useState<Record<string, string>>({});

  useEffect(() => {
    if (kind === 'local' && !item.isDirectory) {
      window.api.fileExtProps(item.path).then(setExtProps).catch(() => {});
    }
  }, [kind, item.path, item.isDirectory]);

  const labelMap: Record<string, string> = {
    author: '作者',
    title: '标题',
    subject: '主题',
    imgW: '图片宽度',
    imgH: '图片高度',
    vidW: '视频宽度',
    vidH: '视频高度',
    duration: '时长',
    artist: '艺术家',
    album: '专辑',
    keywords: '标签',
    comment: '备注',
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card" style={{ width: 440 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span>属性 — {item.name}</span>
          <button onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div>
            <strong>位置：</strong>
            <span style={{ wordBreak: 'break-all' }}>{item.path}</span>
          </div>
          <div>
            <strong>类型：</strong>
            {item.isDirectory ? '文件夹' : item.extension || '文件'}
          </div>
          {!item.isDirectory && (
            <div>
              <strong>大小：</strong>
              {formatBytes(item.size)} ({item.size.toLocaleString()} 字节)
            </div>
          )}
          <div>
            <strong>修改时间：</strong>
            {formatDate(item.mtime)}
          </div>
          {Object.keys(extProps).length > 0 && (
            <>
              <hr style={{ border: 'none', borderTop: '1px solid var(--border-subtle)' }} />
              <strong>Windows 扩展属性</strong>
              {Object.entries(extProps).map(([k, v]) => (
                <div key={k}>
                  <span style={{ color: 'var(--text-secondary)' }}>{labelMap[k] || k}：</span>
                  {v}
                </div>
              ))}
            </>
          )}
        </div>
        <div className="modal-footer">
          <button className="primary" onClick={onClose}>
            确定
          </button>
        </div>
      </div>
    </div>
  );
};
