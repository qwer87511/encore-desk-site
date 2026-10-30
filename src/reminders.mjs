import { validatePlan, saleTimestamp, parsePreferences, samePreparation } from './adapters.mjs';
import {preferencesRecord} from './plan-source.mjs';

export const reminderKey = 'encore.reminder.v1';
const statuses = new Set(['armed', 'fired', 'missed', 'cancelled']);
export function newReminder(input, now, id) {
  if (!Number.isFinite(now) || typeof id !== 'string' || !id) throw new Error('提醒識別與時間不正確');
  const plan = validatePlan(input, { live: true }), at = saleTimestamp(plan.saleAt);
  if (!Number.isFinite(at)) throw new Error('請設定有效的開賣時間');
  return { schemaVersion: 1, id, plan, at, createdAt: now, status: at > now ? 'armed' : 'missed', reason: at > now ? '' : 'past', resolvedAt: at > now ? null : now };
}
export function parseReminder(text) {
  if (typeof text !== 'string' || text.length > 32768) throw new Error('提醒記錄過大或格式不正確');
  const value = JSON.parse(text);
  if (value?.schemaVersion !== 1 || typeof value.id !== 'string' || !value.id || value.id.length > 100 || !statuses.has(value.status) || !Number.isFinite(value.createdAt)) throw new Error('提醒記錄格式不正確');
  const plan = validatePlan(value.plan, { live: true }), at = saleTimestamp(plan.saleAt);
  if (!Number.isFinite(at) || value.at !== at || (value.status === 'armed' ? value.resolvedAt !== null : !Number.isFinite(value.resolvedAt))) throw new Error('提醒時間記錄不一致');
  const validTime = time => Number.isSafeInteger(time) && Math.abs(time) <= 8640000000000000;
  if (!validTime(value.createdAt) || (value.status === 'armed' ? value.createdAt >= at : !validTime(value.resolvedAt) || value.resolvedAt < value.createdAt) || (['fired', 'missed'].includes(value.status) && value.resolvedAt < at)) throw new Error('提醒狀態與時間不一致');
  return { schemaVersion: 1, id: value.id, plan, at, createdAt: value.createdAt, status: value.status, reason: String(value.reason || '').slice(0, 30), resolvedAt: value.resolvedAt };
}
export function advanceReminder(value, now, { restoring = false } = {}) {
  if (value.status !== 'armed' || now < value.at) return value;
  const missed = restoring || now - value.at >= 60000;
  return { ...value, status: missed ? 'missed' : 'fired', reason: restoring ? 'closed' : missed ? 'delayed' : 'due', resolvedAt: now };
}
export function cancelledReminder(value, now, reason = 'manual') {
  // A wall-clock correction must not make our own cancellation unreadable.
  return { ...value, status: 'cancelled', reason, resolvedAt: Math.max(value.createdAt, now) };
}
export function taipeiTime(timestamp) {
  return new Date(timestamp + 8 * 3600000).toISOString().slice(0, 16).replace('T', ' ') + '（台灣 UTC+8）';
}

export const backupLimit = 65536;
export const preferencesKey = 'encore.preferences.v1';
const snapshotKeys = [preferencesKey, reminderKey];
const exactKeys = (value, keys) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key)) || keys.some(key => !Object.hasOwn(value, key))) throw new Error('備份欄位不完整或含不支援的欄位');
};
function checkedBackupPlan(value, live = false) {
  exactKeys(value, ['platform','title','quantity','maxPrice','session','area','eventUrl','saleAt',...(Object.hasOwn(value??{},'origin')?['origin']:[])]);
  if (['platform','title','session','area','eventUrl','saleAt'].some(key => typeof value[key] !== 'string') || ['quantity','maxPrice'].some(key => typeof value[key] !== 'number')) throw new Error('備份計畫欄位型別不正確');
  return validatePlan(value, { live });
}
function checkedPreferences(value) {
  if (value === null) return null;
  exactKeys(value, ['mock','live']);
  return { mock: checkedBackupPlan(value.mock), live: value.live === null ? null : checkedBackupPlan(value.live, true) };
}
function checkedReminder(value, preferences) {
  if (value === null) return null;
  exactKeys(value, ['schemaVersion','id','plan','at','createdAt','status','reason','resolvedAt']);
  checkedBackupPlan(value.plan, true);
  if (typeof value.reason !== 'string' || value.reason.length > 30) throw new Error('提醒原因格式或長度不正確');
  const result = parseReminder(JSON.stringify(value));
  if (result.status === 'armed' && preferences?.live && !samePreparation(result.plan, preferences.live)) throw new Error('提醒與購票偏好不是同一場，請先重新確認計畫');
  return result;
}
function checkedExportTime(value) {
  if (typeof value !== 'string' || value.length > 30 || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw new Error('備份時間格式不正確');
  return value;
}
export function readBackupSnapshot(storage) {
  return Object.fromEntries(snapshotKeys.map(key => [key, storage.getItem(key)]));
}
export function createBackup(snapshot, now = Date.now()) {
  const preferences = snapshot[preferencesKey] ? parsePreferences(snapshot[preferencesKey]) : null;
  const reminder = snapshot[reminderKey] ? checkedReminder(JSON.parse(snapshot[reminderKey]), preferences) : null;
  if (!preferences && !reminder) throw new Error('沒有可備份的已存資料，請先儲存偏好或建立計畫');
  return { format: 'encore-backup', schemaVersion: preferences?.mock?.origin||preferences?.live?.origin||reminder?.plan.origin?2:1, exportedAt: new Date(now).toISOString(), timeZone: 'Asia/Taipei', utcOffset: '+08:00', preferences, reminder };
}
export function parseBackup(text) {
  if (typeof text !== 'string' || new TextEncoder().encode(text).length > backupLimit) throw new Error('備份檔太大，最多 64 KB');
  let value;
  try { value = JSON.parse(text.replace(/^\uFEFF/, '')); } catch { throw new Error('讀不懂這個檔案，請選 Encore 的 JSON 備份或計畫檔'); }
  if (![1,2].includes(value?.schemaVersion)) throw new Error('不支援這個備份版本，請保留原檔並使用相容版本');
  if(value.schemaVersion===1&&[value.plan,value.preferences?.mock,value.preferences?.live,value.reminder?.plan].some(plan=>plan&&Object.hasOwn(plan,'origin')))throw new Error('來源引用須使用第 2 版備份');
  if (value.format === 'encore-backup') {
    exactKeys(value, ['format','schemaVersion','exportedAt','timeZone','utcOffset','preferences','reminder']);
    if (value.timeZone !== 'Asia/Taipei' || value.utcOffset !== '+08:00') throw new Error('備份時區不符，本工具只接受台灣 UTC+8');
    const preferences = checkedPreferences(value.preferences), reminder = checkedReminder(value.reminder, preferences);
    if (!preferences && !reminder) throw new Error('備份裡沒有可還原的資料');
    return { kind: 'full', schemaVersion:value.schemaVersion, preferences, reminder, exportedAt: checkedExportTime(value.exportedAt) };
  }
  exactKeys(value, ['schemaVersion','mode','plan','automation','exportedAt']);
  if (!['mock','live'].includes(value.mode) || value.automation !== (value.mode === 'mock' ? 'synthetic-only' : 'disabled')) throw new Error('這不是支援的 Encore 計畫檔');
  return { kind: 'plan', schemaVersion:value.schemaVersion, mode: value.mode, plan: checkedBackupPlan(value.plan, value.mode === 'live'), exportedAt: checkedExportTime(value.exportedAt) };
}
export function prepareBackupRestore(backup, before, { now = Date.now(), id, fallbackMock } = {}) {
  let preferences, reminder, mode;
  if (backup.kind === 'full') {
    preferences = backup.preferences; reminder = backup.reminder;
    mode = preferences?.live || reminder ? 'live' : 'mock';
  } else if (backup.kind === 'plan') {
    const existing = before[preferencesKey] ? parsePreferences(before[preferencesKey]) : null;
    preferences = { mock: existing?.mock ?? validatePlan(fallbackMock ?? backup.plan), live: existing?.live ?? null, [backup.mode]: backup.plan };
    reminder = backup.mode === 'live' ? null : before[reminderKey] ? parseReminder(before[reminderKey]) : null;
    mode = backup.mode;
  } else throw new Error('不支援的備份類型');
  const preserveReminder = backup.kind === 'plan' && backup.mode === 'mock';
  if (reminder && !preserveReminder) {
    if (typeof id !== 'string' || !id || id.length > 100) throw new Error('無法建立本次還原識別');
    reminder = { ...advanceReminder(reminder, now, { restoring: true }), id };
    parseReminder(JSON.stringify(reminder));
  }
  return { mode, preferences, reminder, snapshot: {
    [preferencesKey]: preferences ? JSON.stringify(preferencesRecord({ mock: preferences.mock, live: preferences.live ?? { title: '' } })) : null,
    [reminderKey]: preserveReminder ? before[reminderKey] : reminder ? JSON.stringify(reminder) : null
  } };
}
export function commitBackupSnapshot(storage, expected, next) {
  const equal = (left, right) => snapshotKeys.every(key => left[key] === right[key]);
  let current;
  try { current = readBackupSnapshot(storage); } catch { throw Object.assign(new Error('無法讀取目前資料，沒有開始還原；請恢復儲存後重新選檔'), { code: 'BACKUP_READ' }); }
  if (!equal(current, expected)) throw Object.assign(new Error('資料在預覽後已變更，為避免覆蓋，請重新選檔預覽'), { code: 'BACKUP_STALE' });
  const attempted = [];
  try {
    for (const key of snapshotKeys) {
      attempted.push(key);
      if (next[key] === null) storage.removeItem(key); else storage.setItem(key, next[key]);
    }
    if (!equal(readBackupSnapshot(storage), next)) throw new Error('另一分頁正在變更資料');
  } catch {
    for (const key of attempted.reverse()) {
      try {
        const current = storage.getItem(key);
        if (current === next[key]) { if (expected[key] === null) storage.removeItem(key); else storage.setItem(key, expected[key]); }
      } catch { /* Never claim recovery until both values have been checked. */ }
    }
    let recovered = false;
    try { recovered = equal(readBackupSnapshot(storage), expected); } catch { /* Storage is still unreadable. */ }
    throw Object.assign(new Error(recovered ? '還原無法儲存，原資料已保留；請恢復瀏覽器儲存後重試' : '儲存失敗且無法確認完全復原。請保持此頁，先下載還原前資料，再恢復儲存並重新整理，從該備份還原'), { code: recovered ? 'BACKUP_ROLLED_BACK' : 'BACKUP_UNCERTAIN' });
  }
  return next;
}
export function prepareClearUndo(before, { now = Date.now(), id } = {}) {
  const snapshot = { ...before };
  if (snapshot[reminderKey]) {
    let record;
    try { record = parseReminder(snapshot[reminderKey]); } catch { return snapshot; /* Keep pre-existing malformed bytes for reversible removal. */ }
    if (record.status === 'armed') {
      if (typeof id !== 'string' || !id || id.length > 100) throw new Error('無法建立復原識別');
      snapshot[reminderKey] = JSON.stringify({ ...advanceReminder(record, now, { restoring: true }), id });
    }
  }
  return snapshot;
}
