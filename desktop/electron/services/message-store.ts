/**
 * 互联聊天消息与附件本地存储（电脑版内置模块）
 * 记录落盘至 <userData>/messages.json，附件存储于 <userData>/messages/<deviceId>/<fileId>
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

export type MessageRetention = '7d' | '30d' | '90d' | 'forever';

export const RETENTION_MS: Record<MessageRetention, number> = {
  '7d': 7 * 24 * 3600 * 1000,
  '30d': 30 * 24 * 3600 * 1000,
  '90d': 90 * 24 * 3600 * 1000,
  forever: Infinity,
};

export const STAGING_GRACE_MS = 60 * 60 * 1000;
export const MAX_TEXT_LEN = 2000;

export interface MessageAttachment {
  fileId: string;
  name: string;
  size: number;
  mime: string;
}

export interface MessageRecord {
  id: string;
  deviceId: string;
  dir: 'in' | 'out';
  text: string;
  from: string;
  fromId: string;
  time: number;
  attachment: MessageAttachment | null;
  read: boolean;
}

export interface NewMessageInput {
  deviceId: string;
  dir: 'in' | 'out';
  text?: string;
  from?: string;
  fromId?: string;
  time?: number;
  attachment?: MessageAttachment | null;
  read?: boolean;
}

export function normalizeRetention(v: unknown): MessageRetention {
  if (v === '7d' || v === '30d' || v === '90d' || v === 'forever') return v;
  return '30d';
}

export interface MessageStore {
  recordsPath: string;
  storeDir: string;
  stagingDir: string;
  list(deviceId: string): MessageRecord[];
  add(record: NewMessageInput): MessageRecord;
  markRead(deviceId: string): boolean;
  unreadCounts(): Record<string, number>;
  newFileId(): string;
  createStagingWriteStream(fileId: string): fs.WriteStream;
  stagingExists(fileId: string): boolean;
  removeStaging(fileId: string): void;
  commitAttachment(fileId: string, deviceId: string): void;
  copyIntoStore(deviceId: string, fileId: string, localPath: string): void;
  attachmentPath(deviceId: string, fileId: string): string;
  attachmentExists(deviceId: string, fileId: string): boolean;
  prune(retention: unknown, now?: number): { removedMessages: number; removedFiles: number };
}

export function createMessageStore(userDataDir: string): MessageStore {
  const storeDir = path.join(userDataDir, 'messages');
  const stagingDir = path.join(storeDir, '_staging');
  const recordsPath = path.join(userDataDir, 'messages.json');
  let records: MessageRecord[] | null = null;

  function ensureDirs() {
    fs.mkdirSync(stagingDir, { recursive: true });
  }

  function load(): MessageRecord[] {
    if (records) return records;
    try {
      const raw = fs.readFileSync(recordsPath, 'utf8');
      const parsed = JSON.parse(raw);
      records = Array.isArray(parsed) ? parsed : [];
    } catch {
      records = [];
    }
    records = records.filter(
      (r) =>
        r &&
        typeof r === 'object' &&
        typeof r.id === 'string' &&
        typeof r.deviceId === 'string' &&
        (r.dir === 'in' || r.dir === 'out') &&
        typeof r.time === 'number',
    );
    return records;
  }

  function save() {
    try {
      fs.mkdirSync(userDataDir, { recursive: true });
      fs.writeFileSync(recordsPath, JSON.stringify(records), 'utf8');
    } catch {}
  }

  function deviceDir(deviceId: string) {
    const safe = String(deviceId || 'unknown').replace(/[^A-Za-z0-9._-]/g, '_');
    return path.join(storeDir, safe);
  }

  function getAttachmentPath(deviceId: string, fileId: string) {
    return path.join(deviceDir(deviceId), String(fileId));
  }

  function stagingPath(fileId: string) {
    return path.join(stagingDir, String(fileId));
  }

  function rmQuiet(p: string) {
    try {
      fs.unlinkSync(p);
    } catch {}
  }

  return {
    recordsPath,
    storeDir,
    stagingDir,

    list(deviceId: string) {
      return load()
        .filter((r) => r.deviceId === deviceId)
        .sort((a, b) => a.time - b.time)
        .map((r) => ({ ...r, attachment: r.attachment ? { ...r.attachment } : null }));
    },

    add(record: NewMessageInput) {
      const list = load();
      const rec: MessageRecord = {
        id: crypto.randomUUID(),
        deviceId: record.deviceId || 'unknown',
        dir: record.dir === 'out' ? 'out' : 'in',
        text: typeof record.text === 'string' ? record.text.slice(0, MAX_TEXT_LEN) : '',
        from: typeof record.from === 'string' ? record.from : '',
        fromId: typeof record.fromId === 'string' ? record.fromId : '',
        time: typeof record.time === 'number' ? record.time : Date.now(),
        attachment: record.attachment ? { ...record.attachment } : null,
        read: record.dir === 'out' ? true : !!record.read,
      };
      list.push(rec);
      save();
      return { ...rec, attachment: rec.attachment ? { ...rec.attachment } : null };
    },

    markRead(deviceId: string) {
      let changed = false;
      for (const r of load()) {
        if (r.deviceId === deviceId && r.dir === 'in' && !r.read) {
          r.read = true;
          changed = true;
        }
      }
      if (changed) save();
      return changed;
    },

    unreadCounts() {
      const out: Record<string, number> = {};
      for (const r of load()) {
        if (r.dir === 'in' && !r.read) out[r.deviceId] = (out[r.deviceId] || 0) + 1;
      }
      return out;
    },

    newFileId() {
      return crypto.randomUUID();
    },

    createStagingWriteStream(fileId: string) {
      ensureDirs();
      return fs.createWriteStream(stagingPath(fileId));
    },

    stagingExists(fileId: string) {
      try {
        return fs.existsSync(stagingPath(fileId));
      } catch {
        return false;
      }
    },

    removeStaging(fileId: string) {
      rmQuiet(stagingPath(fileId));
    },

    commitAttachment(fileId: string, deviceId: string) {
      const src = stagingPath(fileId);
      const dir = deviceDir(deviceId);
      fs.mkdirSync(dir, { recursive: true });
      fs.renameSync(src, path.join(dir, String(fileId)));
    },

    copyIntoStore(deviceId: string, fileId: string, localPath: string) {
      const dir = deviceDir(deviceId);
      fs.mkdirSync(dir, { recursive: true });
      fs.copyFileSync(localPath, path.join(dir, String(fileId)));
    },

    attachmentPath(deviceId: string, fileId: string) {
      return getAttachmentPath(deviceId, fileId);
    },

    attachmentExists(deviceId: string, fileId: string) {
      try {
        return fs.existsSync(getAttachmentPath(deviceId, fileId));
      } catch {
        return false;
      }
    },

    prune(retention: unknown, now = Date.now()) {
      const keepMs = RETENTION_MS[normalizeRetention(retention)];
      const list = load();
      let removedMessages = 0;
      let removedFiles = 0;
      const removeFile = (p: string) => {
        try {
          if (fs.existsSync(p)) {
            fs.unlinkSync(p);
            removedFiles++;
          }
        } catch {}
      };
      if (Number.isFinite(keepMs)) {
        const cutoff = now - keepMs;
        const kept: MessageRecord[] = [];
        for (const r of list) {
          if (r.time < cutoff) {
            removedMessages++;
            if (r.attachment && r.attachment.fileId) {
              removeFile(getAttachmentPath(r.deviceId, r.attachment.fileId));
            }
          } else {
            kept.push(r);
          }
        }
        records = kept;
        save();
      }
      const referenced = new Set<string>();
      for (const r of load()) {
        if (r.attachment && r.attachment.fileId) {
          referenced.add(`${r.deviceId}/${r.attachment.fileId}`);
        }
      }
      try {
        for (const name of fs.readdirSync(stagingDir)) {
          const p = path.join(stagingDir, name);
          try {
            const st = fs.statSync(p);
            if (st.isFile() && now - st.mtimeMs > STAGING_GRACE_MS) removeFile(p);
          } catch {}
        }
      } catch {}
      try {
        for (const dirName of fs.readdirSync(storeDir)) {
          if (dirName === '_staging') continue;
          const dir = path.join(storeDir, dirName);
          try {
            if (!fs.statSync(dir).isDirectory()) continue;
            for (const name of fs.readdirSync(dir)) {
              if (!referenced.has(`${dirName}/${name}`)) removeFile(path.join(dir, name));
            }
          } catch {}
        }
      } catch {}
      return { removedMessages, removedFiles };
    },
  };
}
