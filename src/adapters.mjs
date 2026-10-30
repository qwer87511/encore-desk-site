import {validatePlanSource,makePlanSource,sourceChanges} from './plan-source.mjs';
export const platforms = Object.freeze({
  tixcraft: Object.freeze({ name: '拓元 tixCraft', short: '拓元', color: '#8a7bff', home: 'https://tixcraft.com/', terms: 'https://tixcraft.com/terms-of-use', guide: 'https://help.tixcraft.com/hc/zh-tw/articles/4404363906961', steps: ['登入與手機驗證', '確認活動與場次', '選擇區域與張數', '核對取票與付款', '確認官方訂單'] }),
  kktix: Object.freeze({ name: 'KKTIX', short: 'KKTIX', color: '#61d6ac', home: 'https://kktix.com/', terms: 'https://kktix.com/zh-tw/terms', guide: 'https://support.kktix.com/hc/zh-tw/articles/23055347123993-KKTIX-線上活動購票流程', steps: ['核對會員與資格要求', '確認活動與票種', '選擇張數、閱讀條款', '填寫資料與付款', '確認官方訂單'] })
});

// Public-document guidance, not DOM selectors or a claim about every event form.
export function fillingRoute(platform){
  if(!Object.hasOwn(platforms,platform))throw new Error('請選擇支援的平台');
  const kktix=platform==='kktix';
  return {
    platform,contactFirst:kktix,planOrder:kktix?['quantity','session','area']:['session','area','quantity'],referenceOrder:['title','maxPrice'],
    stages:kktix?['先設官方預填','依活動表單選票／填資料','付款核對']:['場次／區域','票種／張數','人工驗證','付款／取票'],
    note:kktix?'官方支援報名預填；活動必填／欄序待核。以下聯絡欄為本地整理。':'通用預填設定未核實；聯絡資料僅在活動要求時使用。',
    source:kktix?'https://support.kktix.com/hc/zh-tw/articles/22446261556505':'https://static.tixcraft.com/file/docs/PurchasingProcedure_C_Dibon.pdf',
    sourceLabel:kktix?'KKTIX 官方預填說明 ↗':'拓元官方流程圖解 ↗'
  };
}

// Builds a local draft only; source claims must supply a supported activity URL.
export function phasePreparation(event,phase,current,{reviewingSourceChange=false}={}){
  if(!event||!phase||typeof event.title!=='string'||typeof phase.label!=='string')throw Error('開賣階段資料不完整');
  const candidates=[phase.sourceUrl,...(phase.sourceClaims??[]).map(c=>c.sourceUrl)],matches=[];
  for(const value of candidates)for(const platform of ['tixcraft','kktix'])try{const url=normalizeEventUrl(value,platform);if(!matches.some(m=>m.url===url))matches.push({platform,url});}catch{}
  if(matches.length!==1)throw Error(matches.length?'來源有多個購票入口，請人工核對':'此來源沒有可核實的拓元／KKTIX活動入口，不能猜換網址');
  const sessions=[...new Set(phase.appliesToSessions??[])],session=sessions.length===1?localMinute(sessions[0]):'';
  const unreviewedChange=!reviewingSourceChange&&(phase.status==='changed'||phase.kind==='changed');
  const excluded=phase.kind==='registration'||['cancelled','needs_review'].includes(phase.status)||phase.kind==='cancelled'||unreviewedChange||phase.precision!=='minute'||event.status==='needs_review'||event.status==='cancelled';
  const saleAt=excluded?'':localMinute(phase.startsAt);
  const plan=validatePlan({platform:matches[0].platform,eventUrl:matches[0].url,title:event.title,session,area:'',saleAt,quantity:current.quantity,maxPrice:current.maxPrice},{live:true});
  plan.origin=makePlanSource(event,phase,plan);
  return {plan,reference:{eventId:event.id,phaseId:phase.id,label:phase.label,kind:phase.kind,eligibility:phase.eligibility||'未知',sourceUrl:phase.sourceUrl,startsAt:phase.startsAt??null,precision:phase.precision??'unknown',sessionNote:sessions.length===1?session||'場次時間待核':sessions.length?'多場次，請手動選擇':'適用場次待核',timeNote:saleAt?'台灣 UTC+8；僅公告時間，不代表資格或可買':phase.kind==='registration'?'登記／抽選不是購票開賣；不帶入提醒時間':'開賣時間／狀態待核；不帶入演出日期',fetchedAt:phase.fetchedAt??null}};
}
function localMinute(value){const at=typeof value==='string'?Date.parse(value):NaN;return Number.isFinite(at)?new Date(at+8*3600000).toISOString().slice(0,16):'';}

export function sourceUpdatePreparation(current,event,phase){
 const original=validatePlan(current,{live:true}),review=sourceChanges(original,[{...event,sale_phases:[phase]}]);
 if(review.blocked)throw Error(review.blocked);if(!review.changes.length)throw Error('來源內容沒有差異，不需要重新帶入');
 const next=phasePreparation(event,phase,original,{reviewingSourceChange:true}),merged={...original,origin:next.plan.origin};
 for(const key of ['platform','title','eventUrl','session','saleAt'])if(next.plan[key]!==original.origin.selection[key])merged[key]=next.plan[key];
 return {...next,plan:validatePlan(merged,{live:true}),changes:review.changes};
}

// Deliberately no fetch, browser connection, DOM selectors or order endpoints.
export function normalizeEventUrl(value, platform) {
  if (!Object.hasOwn(platforms, platform)) throw new Error('請選擇支援的平台');
  if (typeof value !== 'string' || /[^\x21-\x7e]|\\/u.test(value)) throw new Error('活動網址含空白、隱藏或非標準字元，請重新貼上官方 HTTPS 網址');
  let url;
  try { url = new URL(value); } catch { throw new Error('請輸入完整的 HTTPS 活動網址'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash) throw new Error('活動網址須為 HTTPS，且不可含帳密、連接埠、查詢參數或片段');
  const valid = platform === 'tixcraft'
    ? url.hostname === 'tixcraft.com' && /^\/activity\/detail\/[a-zA-Z0-9_-]+\/?$/.test(url.pathname)
    : (url.hostname === 'kktix.com' || /^[a-z0-9-]+\.kktix\.cc$/.test(url.hostname)) && /^\/events\/[a-zA-Z0-9_-]+\/?$/.test(url.pathname);
  if (!valid) throw new Error('網址與平台不符，請貼上官方活動介紹頁');
  return url.href;
}

function planError(message, field) { return Object.assign(new Error(message), { field }); }
export function validatePlan(input, { live = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('偏好資料格式不正確');
  if (typeof input.platform !== 'string' || !Object.hasOwn(platforms, input.platform)) throw planError('請選擇平台', 'platform');
  for (const name of ['quantity', 'maxPrice']) if (!['string', 'number'].includes(typeof input[name])) throw planError('張數與票價格式不正確', name);
  const quantity = Number(input.quantity), maxPrice = Number(input.maxPrice);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 4) throw planError('本機計畫張數須為 1–4 張；實際限購以活動公告為準', 'quantity');
  if (!Number.isInteger(maxPrice) || maxPrice < 1 || maxPrice > 100000) throw planError('請輸入有效的每張票價上限（1–100,000）', 'maxPrice');
  const text = (name, limit) => {
    const value = input[name] ?? '';
    if (typeof value !== 'string' || value.length > limit) throw planError('偏好文字格式或長度不正確', name);
    if (/[\u0000-\u001f\u007f-\u009f\u061c\u200b\u200e\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/u.test(value)) throw planError('偏好文字含隱藏或方向控制字元，請移除後再試', name);
    return value.trim();
  };
  const title = text('title', 100);
  if (!title) throw planError('請輸入活動名稱', 'title');
  const plan = { platform: input.platform, title, quantity, maxPrice, session: text('session', 80), area: text('area', 80), eventUrl: '', saleAt: text('saleAt', 16) };
  const eventUrl = text('eventUrl', 2048);
  if (eventUrl || live) { try { plan.eventUrl = normalizeEventUrl(eventUrl, plan.platform); } catch (error) { throw Object.assign(error, { field: 'eventUrl' }); } }
  if (plan.saleAt && !Number.isFinite(saleTimestamp(plan.saleAt))) throw planError('開賣時間格式不正確', 'saleAt');
  if (Object.hasOwn(input,'origin')) plan.origin=validatePlanSource(input.origin);
  return plan;
}

export function parsePreferences(text) {
  if (typeof text !== 'string' || text.length > 32768) throw new Error('已存偏好過大或格式不正確');
  const value = JSON.parse(text);
  if(value?.schemaVersion!==undefined&&value.schemaVersion!==2)throw new Error('不支援此偏好版本');
  if (!value || typeof value !== 'object' || Array.isArray(value) || !value.live || typeof value.live !== 'object' || Array.isArray(value.live)) throw new Error('已存偏好格式不正確');
  const mock = validatePlan(value.mock);
  const live = value.live.title === '' ? null : validatePlan(value.live, { live: true });
  return { mock, live };
}

export function saleTimestamp(value) {
  if (!value) return null;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value) || value.startsWith('0000-')) return NaN;
  const parsed = Date.parse(value + ':00+08:00');
  if (!Number.isFinite(parsed)) return NaN;
  // Date.parse normalizes dates such as February 31; reject them instead.
  return new Date(parsed + 8 * 3600000).toISOString().slice(0, 16) === value ? parsed : NaN;
}

export function samePreparation(left, right) {
  return Boolean(left && right && ['platform','title','quantity','maxPrice','session','area','eventUrl','saleAt'].every(key => left[key] === right[key]) && JSON.stringify(left.origin??null)===JSON.stringify(right.origin??null));
}
// A read-only view of the existing plan; no inventory, fee or account inference.
export function preparationOverview(input, { reminder = null, checks = [], source = 'draft', reminderIssue = false, preferencesIssue = false, now = Date.now() } = {}) {
  let value;
  try { value = validatePlan(input, { live: true }); }
  catch {
    return { hasPlan: false, title: '還沒有完整的購票準備計畫', source: '先從一場開始', status: preferencesIssue || reminderIssue ? '已存資料無法讀取，請重新建立計畫' : '填寫活動與官方網址，就能開始準備', time: '未知', cap: '未知', needs: '活動、開賣時間與預算待確認', budget: '未知', budgetNote: '實際票價與費用尚未核實' };
  }
  const linked = samePreparation(value, reminder?.plan) ? reminder : null;
  const sources = { saved: '已存購票偏好', reminder: '已存提醒計畫', confirmed: '僅此分頁 · 未儲存', draft: '尚未確認的草稿' };
  const statuses = { armed: '本機提醒已設定', fired: '本機提醒已完成', missed: '已錯過本機提醒', cancelled: '提醒已取消，確認後可重建' };
  const missing = ['帳戶驗證','活動規則','付款／取票'].filter((_, index) => checks[index] !== true);
  const money = number => new Intl.NumberFormat('zh-TW').format(number);
  return {
    hasPlan: true, title: value.title, source: sources[source] ?? sources.draft,
    status: reminderIssue ? '提醒記錄異常，請修復儲存後重建' : linked ? statuses[linked.status] ?? '提醒狀態未知' : value.saleAt && saleTimestamp(value.saleAt) <= now ? '你填寫的開賣時間已過；官方狀態仍須人工確認' : '尚未建立提醒；確認偏好後可建立',
    time: value.saleAt ? value.saleAt.replace('T',' ') : '未知 · 尚未填寫',
    timeNote: value.saleAt ? '自行填寫，官方開賣尚未核實' : '可先儲存偏好，稍後補上時間',
    cap: `NT$ ${money(value.quantity * value.maxPrice)}`,
    capNote: `${value.quantity} 張 × 每張上限 NT$ ${money(value.maxPrice)}`,
    needs: missing.length ? `待自查 ${missing.length} 項：${missing.join('、')}` : '自查清單已勾選，平台狀態仍未知',
    budget: '未知', budgetNote: '實際票價與費用尚未核實'
  };
}

export function selectTicket(tickets, plan) {
  return tickets.filter(t => t.available >= plan.quantity && t.price <= plan.maxPrice && (!plan.area || t.area.toLowerCase().includes(plan.area.toLowerCase())) && (!plan.session || t.session.toLowerCase().includes(plan.session.toLowerCase())))
    .sort((a, b) => a.price - b.price || a.id.localeCompare(b.id))[0] || null;
}

export function livePolicy(action) {
  if (!['prepare', 'remind', 'open-manually'].includes(action)) throw new Error('平台自動化尚未獲准；此版本僅支援本機準備與人工開頁');
  return true;
}

export const scenarios = Object.freeze({
  normal: '順利購票', queue: '排隊後入場', captcha: '人工驗證', expired: '登入過期', rateLimit: '限流後恢復', timeout: '逾時後恢復', soldOut: '票券售罄', persistent: '持續失敗', unknown: '未知頁面'
});

// Entirely invented inventory, not a snapshot or estimate of any real event.
export function fixture(platform, scenario) {
  if (!platforms[platform] || !scenarios[scenario]) throw new Error('未知的離線情境');
  const tickets = [
    { id: `${platform}-a`, area: '看台 A 區', session: '週六晚場', price: 3200, available: 4 },
    { id: `${platform}-b`, area: '搖滾 B 區', session: '週六晚場', price: 4800, available: 2 },
    { id: `${platform}-c`, area: '看台 C 區', session: '週日晚場', price: 2200, available: 1 }
  ];
  const frames = [{ type: 'reading', detail: `讀取 ${platforms[platform].short} 合成活動資料` }];
  if (scenario === 'queue') frames.push({ type: 'queue', detail: '模擬排隊中，維持原佇列' }, { type: 'queue', detail: '模擬隊列開放，依序進場' });
  if (scenario === 'rateLimit') frames.push({ type: 'rateLimit', retryAfter: 60 });
  if (scenario === 'timeout') frames.push({ type: 'timeout' });
  if (scenario === 'persistent') frames.push(...Array.from({ length: 4 }, () => ({ type: 'timeout' })));
  if (scenario === 'unknown') return [...frames, { type: 'unknown' }];
  if (scenario === 'soldOut') return [...frames, { type: 'available', tickets: tickets.map(t => ({ ...t, available: 0 })) }];
  frames.push({ type: 'available', tickets });
  if (scenario === 'captcha') frames.push({ type: 'captcha', detail: '模擬驗證畫面：請人工接手；不進行影像辨識' });
  if (scenario === 'expired') frames.push({ type: 'expired', detail: '模擬登入過期：請人工重新登入後繼續' });
  frames.push({ type: 'holding', detail: '僅在記憶體建立模擬保留，不涉及真實庫存' }, { type: 'review', detail: '請核對偏好，再人工確認模擬送單' }, { type: 'completed', detail: '離線演練完成。沒有真實票券、訂單或付款' });
  return frames;
}
