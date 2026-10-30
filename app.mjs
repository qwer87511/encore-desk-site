import { platforms, validatePlan, parsePreferences, saleTimestamp, livePolicy, samePreparation, preparationOverview, normalizeEventUrl, fillingRoute, phasePreparation, sourceUpdatePreparation } from './src/adapters.mjs';
import { Rehearsal, paymentHandoffDemo, ManualRelay } from './src/engine.mjs';
import { reminderKey, newReminder, parseReminder, advanceReminder, cancelledReminder, taipeiTime, backupLimit, readBackupSnapshot, createBackup, parseBackup, prepareBackupRestore, commitBackupSnapshot, prepareClearUndo } from './src/reminders.mjs';
import {sourceReferenceState,preferencesRecord,sourceChanges} from './src/plan-source.mjs';

const $ = id => document.getElementById(id);
const readingLayout = new URL(location.href).searchParams.get('layout') !== 'classic';
const posterLayout = readingLayout && new URL(location.href).searchParams.get('layout') !== 'reading';
document.documentElement.dataset.layout = readingLayout ? 'reading' : 'classic';
document.documentElement.dataset.art = posterLayout ? 'poster' : 'none';
function setPalette(value, persist = true) {
  const palette = value === 'charcoal' ? 'charcoal' : 'graphite';
  document.documentElement.dataset.palette = palette;
  $('palette-name').textContent = palette === 'graphite' ? '中性石墨' : '微暖炭灰';
  for (const name of ['graphite','charcoal']) $('palette-' + name).setAttribute('aria-pressed', String(name === palette));
  document.querySelector('meta[name="theme-color"]').content = getComputedStyle(document.documentElement).getPropertyValue('--background').trim();
  if (persist) { try { sessionStorage.setItem('encore.palette.v1', palette); } catch { $('palette-note').textContent = '只換介面色調，不改偏好與提醒；目前無法記住選擇，重新整理會回到中性石墨。'; } }
}
let initialPalette = 'graphite';
try { initialPalette = sessionStorage.getItem('encore.palette.v1'); } catch { /* Default stays usable with storage disabled. */ }
setPalette(initialPalette, false);
for (const name of ['graphite','charcoal']) $('palette-' + name).addEventListener('click', () => setPalette(name));
document.querySelectorAll('a[href="#backup"]').forEach(link => link.addEventListener('click', event => { event.preventDefault(); $('backup').open = true; focusControl('backup-toggle'); }));
if (location.hash === '#backup') $('backup').open = true;
const money = value => new Intl.NumberFormat('zh-TW').format(value);
const storageKey = 'encore.preferences.v1';
const empty = () => ({ platform: 'tixcraft', title: '', session: '', area: '', quantity: 2, maxPrice: 2500, eventUrl: '', saleAt: '' });
const demo = () => ({ ...empty(), maxPrice: 4800, title: 'Encore 測試演出' });
let mode = 'mock', platform = 'tixcraft', activePlan = null, reminder = null, localLogs = [];
let drafts = { mock: demo(), live: empty() };
let draftOrigin=null;
let sourceSaveGuard=null;
let sourceNavigation=null;
let currentMockPlan = demo();
let handoffDemoRun = null, handoffDemoAnchor = null;
let reminderPersistent = true, tickingReminder = false, reminderIssue = '', connectionOffline = false;
let savedLivePlan = null, preferencesIssue = false, presentation = 'focus';
let lastOverviewSignature = '';
let lastPlanChangesSignature = '';
let planIssue = null;
let lastPrimaryAction = '';
let pendingRestore = null, undoRestore = null, restoreRecovery = null, restoreReadSerial = 0, userRevision = 0, restoring = false, readingRestore = false;
let pendingClear = null, undoClear = null, clearRecovery = null, clearing = false, clearReturnFocus = 'clear-button';
let clearStorageRevision = 0;
const clearUndoLimit = 10 * 60 * 1000;
try { if (sessionStorage.getItem('encore.presentation.v1') === 'workspace') presentation = 'workspace'; } catch { /* Presentation remains usable when storage is blocked. */ }
const statusNames = { idle: '等你準備好', reading: '讀取合成活動', queue: '模擬排隊中', matched: '找到符合偏好的票種', backoff: '退避等待中', handoff: '需要你接手', holding: '模擬票券保留', resuming: '繼續離線演練', completed: '演練完成，準備上場', stopped: '演練已停止', failed: '演練已停止，請檢查' };
const engine = new Rehearsal({ onChange: state => { if (mode === 'mock') renderRun(state); } });

function message(text, error = false) { clearPlanIssue(); $('form-message').textContent = text; $('form-message').classList.toggle('error', error); }
const planFields={platform:['售票平台',()=>document.querySelector('[data-platform][aria-pressed=true]')??document.querySelector('[data-platform]')],title:['活動名稱',()=>$('event-title')],session:['場次偏好',()=>$('session')],area:['票區關鍵字',()=>$('area')],quantity:['希望張數',()=>$('quantity')],maxPrice:['每張票價上限',()=>$('max-price')],eventUrl:['官方活動網址',()=>$('event-url')],saleAt:['開賣時間',()=>$('sale-at')]};
function releasePlanIssueField(issue){
  if(!issue)return;const control=issue.control;control.removeAttribute('data-plan-invalid');
  if(control.id!=='event-url'||$('event-url-warning').hidden)control.removeAttribute('aria-invalid');
  const description=(control.getAttribute('aria-describedby')??'').split(/\s+/).filter(id=>id&&id!=='form-message').join(' ');if(description)control.setAttribute('aria-describedby',description);else control.removeAttribute('aria-describedby');
}
function clearPlanIssue(){releasePlanIssueField(planIssue);planIssue=null;}
function paintPlanIssue(){
  const issue=planIssue;if(!issue)return;const box=$('form-message'),action=document.createElement('button'),label=$(issue.source).textContent.trim();
  const text=issue.changed?'內容已修改；尚未重新檢查或完成原操作。':`${issue.label}：${issue.error.message}`;
  action.id='plan-error-action';action.type='button';action.className='text-button';action.textContent=issue.phase==='field'?`前往「${issue.label}」`:`返回「${label}」`;action.setAttribute('aria-label',`${text}。${action.textContent}`);
  action.addEventListener('click',()=>{if(issue.phase==='field'){issue.phase='return';paintPlanIssue();focusControl(issue.control);}else focusControl(issue.source);});
  box.replaceChildren(document.createTextNode(text+' '),action);box.classList.toggle('error',!issue.changed);
  if(issue.phase==='return'&&['text','url','number'].includes(issue.control.type)){const hint=document.createElement('span');hint.className='plan-error-hint';hint.textContent='Enter／Esc 返回原操作，不會直接執行。';box.append(hint);}
}
function reportPlanError(error,source){
  if(!planFields[error.field]){message(error.message,true);return;}
  message('',true);const[label,getControl]=planFields[error.field],control=getControl();planIssue={error,source,control,label,changed:false,phase:'field'};
  control.setAttribute('data-plan-invalid','true');control.setAttribute('aria-invalid','true');control.setAttribute('aria-describedby',[...new Set((control.getAttribute('aria-describedby')??'').split(/\s+/).filter(Boolean).concat('form-message'))].join(' '));
  paintPlanIssue();focusControl('plan-error-action');
}
function editedPlanIssue(){if(planIssue){releasePlanIssueField(planIssue);planIssue.changed=true;planIssue.phase='return';paintPlanIssue();}}
function checkedPlan(){
  const invalid=[...$('plan-fields').querySelectorAll('input,select')].find(control=>control.willValidate&&!control.validity.valid);
  if(invalid){const messages={title:'請輸入活動名稱',maxPrice:'請輸入有效的整數每張票價上限（1–100,000）',eventUrl:'請輸入完整的 HTTPS 活動網址',saleAt:'請輸入完整的開賣時間，或清空此欄'};throw Object.assign(new Error(messages[invalid.name]??'請核對此欄的格式或範圍'),{field:invalid.name});}
  return plan();
}
function backupMessage(text, error = false) { $('backup-message').textContent = text; $('backup-message').classList.toggle('error', error); }
function backupProblem(error) {
  if (['SecurityError','QuotaExceededError'].includes(error.name)) return '瀏覽器目前不允許讀取或儲存資料。請恢復網站儲存後再試。';
  if (error.name === 'SyntaxError') return '目前已存資料格式異常，請保留頁面並確認原本的備份檔。';
  return error.message;
}
function renderRestoreFacts(backup, target) {
  const entries = backup.kind === 'plan' ? [[backup.mode === 'live' ? '購票偏好' : '演練偏好', backup.plan]] : [['購票偏好', target.preferences?.live], ['演練偏好', target.preferences?.mock]];
  if (backup.kind === 'full' && target.reminder && !samePreparation(target.preferences?.live, target.reminder.plan)) entries.push(['提醒所用計畫（與購票偏好分開）', target.reminder.plan]);
  const [label, primary] = entries.find(([, value]) => value) ?? [];
  $('restore-confirm-summary').textContent = primary ? `確認將套用${label}：${primary.quantity} 張，每張上限 NT$ ${money(primary.maxPrice)}，票面總上限 NT$ ${money(primary.quantity * primary.maxPrice)}（不含費用）。目的網域：${primary.eventUrl ? new URL(primary.eventUrl).hostname : '未填寫'}。` : '';
  $('restore-plan-facts').replaceChildren();
  for (const [label, value] of entries) {
    if (!value) continue;
    const card = document.createElement('section'), heading = document.createElement('h4'), list = document.createElement('dl');
    heading.textContent = `${label} · ${value.title}`;
    for (const [name, text] of [
      ['平台', platforms[value.platform].name],
      ['張數／每張上限', `${value.quantity} 張／NT$ ${money(value.maxPrice)}`],
      ['票面總上限', `NT$ ${money(value.quantity * value.maxPrice)}\n不含費用；實際票價與是否超預算尚未核實`],
      ['場次／票區', `${value.session || '未指定場次'}／${value.area || '未指定票區'}`],
      ['開賣時間（自行填寫）', value.saleAt ? value.saleAt.replace('T', ' ') + '（台灣 UTC+8，官方未核實）' : '未填寫，不代表官方未開賣'],
      ['目的網址（只供核對）', value.eventUrl || '未填寫'],
      ...(value.origin?[['選定來源（原引用）',`${value.origin.label} · ${value.origin.eligibility}\n${value.origin.sourceUrl}\n原觀測：${value.origin.observedAt??'未知'}；非目前可買狀態`]]:[])
    ]) { const term = document.createElement('dt'), description = document.createElement('dd'); term.textContent = name; description.textContent = text; list.append(term, description); }
    card.append(heading, list); $('restore-plan-facts').append(card);
  }
}
function markUserChange() {
  userRevision++; restoreReadSerial++;
  if (undoClear) { undoClear = null; $('undo-clear').hidden = true; clearMessage('內容已修改，已停止提供舊清除復原，避免蓋掉新資料。'); }
  if (undoRestore) { undoRestore = null; $('undo-restore').hidden = true; }
  if (pendingRestore || readingRestore) { pendingRestore = null; readingRestore = false; $('restore-preview').hidden = true; $('restore-file').value = ''; backupMessage('內容已變更，請重新選檔預覽，避免蓋掉新資料。'); }
}
function clearMessage(text, error = false) { $('clear-message').textContent = text; $('clear-message').classList.toggle('error', error); }
function clearDialogMessage(text, error = false) { $('clear-dialog-message').textContent = text; $('clear-dialog-message').classList.toggle('error', error); }
function uncertainStorage() { return Boolean(restoreRecovery?.uncertain || clearRecovery); }
function refreshDataTools() {
  const blocked = uncertainStorage();
  for(const id of ['restore-confirm','undo-restore'])$(id).setAttribute('aria-busy',String(restoring));
  for(const id of ['clear-confirm','undo-clear'])$(id).setAttribute('aria-busy',String(clearing));
  const reason=blocked?'儲存狀態待確認，請先保留操作前副本':restoring?'正在還原，請稍候':clearing?'正在處理清除，請稍候':engine.active?'請先停止演練再管理資料':'';
  for(const id of ['restore-choose','clear-button','undo-clear']){if(reason)$(id).title=reason;else $(id).removeAttribute('title');}
  $('restore-confirm').disabled = restoring || clearing || blocked;
  $('restore-blocked-help').hidden = !blocked;
  if (blocked) $('restore-blocked-help').textContent = clearRecovery
    ? '清除結果尚未確認，已停用確認還原。請先按「下載清除前副本」保留資料，再恢復儲存並重新整理。'
    : '儲存結果尚未確認，已停用確認還原。請先按「下載操作前副本」保留資料，再恢復儲存並重新整理。';
  $('restore-choose').disabled = engine.active || restoring || clearing || uncertainStorage();
  $('clear-button').disabled = restoring || clearing || uncertainStorage();
  $('undo-clear').disabled = restoring || clearing || uncertainStorage();
}
function focusControl(id) {
  const control = typeof id === 'string' ? $(id) : id;
  for (let parent = control.parentElement; parent; parent = parent.parentElement) {
    if (parent.tagName === 'DETAILS' && control.tagName !== 'SUMMARY') parent.open = true;
  }
  control.focus({ preventScroll: true });
  control.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
}
function rawPlan() { return { platform, ...Object.fromEntries(['title', 'session', 'area', 'quantity', 'maxPrice', 'eventUrl', 'saleAt'].map(name => [name, document.querySelector(`[name="${name}"]`).value])),...(draftOrigin?{origin:structuredClone(draftOrigin)}:{}) }; }
function plan() { return validatePlan(rawPlan(), { live: mode === 'live' }); }
function writePlan(value) {
  sourceSaveGuard=null;
  if (planIssue) message('');
  platform = value.platform;
  draftOrigin=value.origin?structuredClone(value.origin):null;
  for (const name of ['title', 'session', 'area', 'quantity', 'maxPrice', 'eventUrl', 'saleAt']) document.querySelector(`[name="${name}"]`).value = value[name] ?? '';
  renderPlatform();
  renderBudget();
  document.dispatchEvent(new Event('encore-plan-replaced'));
}
function renderBudget() {
  const quantity = Number($('quantity').value), price = Number($('max-price').value);
  const valid = Number.isInteger(quantity) && quantity >= 1 && quantity <= 4 && Number.isInteger(price) && price >= 1 && price <= 100000;
  $('budget-amount').textContent = valid
    ? `${quantity} 張 × 每張 NT$ ${money(price)} = NT$ ${money(quantity * price)}`
    : '請填寫有效張數與每張票價上限';
  renderFocus();
  refreshDataTools();
}
function renderPlanChanges() {
  const box=$('plan-changes'),current=rawPlan(),baseline=savedLivePlan??(reminderPersistent&&reminder?.status!=='cancelled'?reminder?.plan:null);
  const signature=JSON.stringify([mode,current,baseline,reminder,reminderPersistent,reminderIssue,preferencesIssue]);
  if(signature===lastPlanChangesSignature)return;lastPlanChangesSignature=signature;
  const labels={quantity:'張數',saleAt:'開賣時間',maxPrice:'每張上限',title:'活動名稱',platform:'平台',session:'場次',area:'票區',eventUrl:'網址',origin:'來源引用'};
  const normalized=(value,key)=>key==='origin'?JSON.stringify(value??null):['quantity','maxPrice'].includes(key)?String(Number(value)):String(value??'').trim();
  const changed=Object.keys(labels).filter(key=>normalized(current[key],key)!==normalized(baseline?.[key],key));
  const meaningful=Boolean(current.title.trim()||current.eventUrl.trim()),cancelled=reminder?.status==='cancelled';
  const sameReminder=Boolean(reminder&&Object.keys(labels).every(key=>normalized(current[key],key)===normalized(reminder.plan[key],key)));
  const linked=reminder?.status==='armed'&&sameReminder,resolved=['fired','missed'].includes(reminder?.status)&&sameReminder;
  box.hidden=mode!=='live'||(!baseline&&!meaningful&&!cancelled)||(!changed.length&&!cancelled&&(!current.saleAt||linked||resolved));
  if(box.hidden)return;
  let title=preferencesIssue?'無法核對已存內容':changed.length?'本頁草稿 · 尚未儲存':reminderIssue?'提醒記錄需核對':cancelled?'內容與上次已存相同 · 提醒已取消':'偏好已儲存 · 尚未建立提醒';
  if(!changed.length&&cancelled&&baseline&&!samePreparation(baseline,reminder.plan))title='偏好已儲存 · 提醒未重建';
  if($('plan-change-title').textContent!==title)$('plan-change-title').textContent=title;
  const format=(value,key)=>{if(value===undefined||value===null)return'尚無已存值';if(value==='')return'未填寫';if(key==='quantity')return `${value} 張`;if(key==='saleAt')return String(value).replace('T',' ');return Number.isFinite(Number(value))?`NT$ ${money(Number(value))}`:'格式待確認';};
  $('plan-change-fields').replaceChildren();
  for(const key of preferencesIssue?[]:changed.filter(key=>['quantity','saleAt','maxPrice'].includes(key))){const row=document.createElement('div'),term=document.createElement('dt'),description=document.createElement('dd'),old=document.createElement('span'),draft=document.createElement('strong');term.textContent=labels[key];old.textContent=`上次已存：${format(baseline?.[key],key)}`;draft.textContent=`本頁草稿：${format(current[key],key)}`;description.append(old,draft);row.append(term,description);$('plan-change-fields').append(row);}
  const other=changed.filter(key=>!['quantity','saleAt','maxPrice'].includes(key));$('plan-change-other').hidden=!other.length;$('plan-change-other').textContent=other.length?'另有變更：'+other.map(key=>labels[key]).join('、'):'';
  let reminderText='尚未建立此設定的提醒；儲存偏好不會自動建立提醒。';
  if(reminderIssue)reminderText='本頁未執行提醒；已存提醒狀態無法確認，請先修復儲存。';
  else if(cancelled){const original=`${reminder.plan.quantity} 張 · ${reminder.plan.saleAt.replace('T',' ')}`;reminderText=reminder.reason==='replaced'?'此頁舊提醒已停止；其他分頁的提醒請重新核對。':`${reminderPersistent?'本頁原提醒已取消':'此頁提醒已停止，取消狀態未確認保存'}：${original}。儲存偏好不會重建；其他分頁請另核對。`;}
  else if(reminder?.status==='armed')reminderText=`此頁提醒${linked?'使用目前設定':'仍用原設定'}：${reminder.plan.quantity} 張 · ${reminder.plan.saleAt.replace('T',' ')}。${linked?'其他尚未儲存內容請先核對。':'本頁設定尚未建立新提醒。'}`;
  else if(['fired','missed'].includes(reminder?.status))reminderText=`原提醒${reminder.status==='fired'?'已完成':'已錯過'}：${reminder.plan.quantity} 張 · ${reminder.plan.saleAt.replace('T',' ')}。本頁草稿尚未建立新提醒。`;
  $('plan-change-reminder').textContent=reminderText;
  $('plan-change-help').textContent=preferencesIssue?'無法讀取已存值；本頁內容保留，不代表已保存。':changed.length?'草稿只在本頁；重新整理會載入已存內容。時間均為台灣 UTC+8。':'時間均為台灣 UTC+8；需要新提醒時請重新確認計畫。';
}
function clearPositiveFormMessage(){if(!planIssue&&!$('form-message').classList.contains('error'))message('');}
function renderExportScope(){
  $('export-scope').textContent=(engine.active&&mode==='mock'?'使用執行中的演練設定':'含目前表單與未儲存修改')+'；不含提醒、另一模式偏好或勾選。匯出不會儲存偏好。';
}
function renderPrimaryAction(){
  const control=$('sale-at'),at=saleTimestamp(control.value),state=mode==='mock'?'mock':control.validity.badInput||control.value&&!Number.isFinite(at)?'invalid':!control.value?'none':at>Date.now()?'future':'past';
  if(state===lastPrimaryAction)return;lastPrimaryAction=state;
  const button=$('start-button'),note=$('primary-action-note');note.hidden=state==='mock';
  if(state==='mock'){button.removeAttribute('aria-describedby');return;}
  const options={
    none:['儲存計畫','存兩模式有效偏好；不設新提醒，移除此瀏覽器既有提醒（如有）。'],
    future:['儲存並設提醒','存兩模式有效偏好；新提醒取代此瀏覽器舊提醒（如有）。關頁不通知。'],
    past:['儲存計畫','時間已過：存兩模式有效偏好與已錯過記錄，不發提醒；取代此瀏覽器舊提醒（如有）。'],
    invalid:['核對後儲存','時間格式待修正；修正前不儲存偏好或建立提醒。']
  };
  const[label,description]=options[state];button.textContent=label;note.textContent=description;button.setAttribute('aria-describedby','primary-action-note');
  const returning=$('plan-error-action');if(planIssue?.source==='start-button'&&planIssue.phase==='return'&&returning){returning.textContent=`返回「${label}」`;returning.setAttribute('aria-label',`返回「${label}」；${planIssue.changed?'尚未重新檢查或完成原操作':planIssue.error.message}`);}
}
function renderPlatformUrlReview(){
  let other=null,matched=false;const url=$('event-url').value.trim();
  if(mode==='live'&&url){
    try{normalizeEventUrl(url,platform);matched=true;}
    catch{const candidate=platform==='tixcraft'?'kktix':'tixcraft';try{normalizeEventUrl(url,candidate);other=candidate;}catch{/* Existing submit validation handles incomplete or untrusted URLs. */}}
  }
  $('event-url-warning').hidden=!other;
  if(other){$('event-url').setAttribute('aria-invalid','true');$('event-url-warning').textContent=`目前選擇 ${platforms[platform].short}，網址屬於${platforms[other].short}。請貼上 ${platforms[platform].short} 活動網址，或切回${platforms[other].short}；原網址與自訂值已保留。`;}
  else{if(!(planIssue?.control===$('event-url')&&!planIssue.changed))$('event-url').removeAttribute('aria-invalid');$('event-url-warning').textContent='';}
  if(matched&&$('form-message').textContent==='網址與平台不符，請貼上官方活動介紹頁')message('');
  return other?{selected:platform,original:other}:null;
}
function renderFocus() {
  document.dispatchEvent(new Event('encore-plan-view'));
  $('fill-return').hidden=mode!=='live';
  renderPrimaryAction();
  renderExportScope();
  const urlReview=renderPlatformUrlReview();
  renderPlanChanges();
  const input = mode === 'live' ? rawPlan() : savedLivePlan;
  let value = null;
  try { value = validatePlan(input, { live: true }); } catch { /* Show an actionable empty state, never the mock demonstration. */ }
  const source = samePreparation(value, savedLivePlan) ? 'saved' : reminderPersistent && reminder?.status!=='cancelled' && (!savedLivePlan||samePreparation(savedLivePlan,reminder?.plan)) && samePreparation(value, reminder?.plan) ? 'reminder' : samePreparation(value, activePlan) ? 'confirmed' : 'draft';
  const overview = preparationOverview(value, { source, reminder, reminderIssue: Boolean(reminderIssue), preferencesIssue, checks: [...document.querySelectorAll('#live-checklist input')].map(input => input.checked) });
  const signature = JSON.stringify([overview, mode, engine.active, Boolean(reminderIssue), preferencesIssue,urlReview,urlReview?input.title:null,sourceNavigation]);
  if (signature === lastOverviewSignature) return;
  lastOverviewSignature = signature;
  for (const name of ['title','source','time','needs','cap','budget']) $(`focus-${name}`).textContent = overview[name];
  $('focus-state').textContent = overview.status;
  $('focus-state').classList.toggle('warning', Boolean(reminderIssue) || preferencesIssue);
  for (const name of ['time','cap','budget']) $(`focus-${name}-note`).textContent = overview[`${name}Note`] ?? '';
  $('focus-title').title = overview.title;
  $('focus-card').dataset.plan = overview.hasPlan ? 'ready' : 'empty';
  if (posterLayout && !overview.hasPlan) {
    $('focus-title').textContent = '還沒有計畫？';
    if (!preferencesIssue && !reminderIssue) $('focus-state').textContent = '未設提醒';
  }
  $('focus-facts').hidden = !overview.hasPlan;
  $('focus-edit').textContent = engine.active ? '演練中，請先停止再編輯' : overview.hasPlan ? '編輯這場偏好 ↗' : '開始購票準備 ↗';
  if(mode==='mock'){
    $('focus-source').textContent=overview.hasPlan?'準備預覽 · 已存偏好':'準備預覽';
    $('focus-edit').textContent=engine.active?'先停止演練再切換':overview.hasPlan?'回到購票準備 ↗':'切換購票準備 ↗';
  }
  if(urlReview){
    $('focus-card').dataset.plan='review';$('focus-title').textContent=input.title.trim()||'請核對活動網址';$('focus-title').title=$('focus-title').textContent;$('focus-source').textContent='本頁草稿';
    $('focus-state').textContent=preferencesIssue||reminderIssue?'平台與網址不符；已存資料亦需核對。':`已選 ${platforms[urlReview.selected].short}；網址屬於${platforms[urlReview.original].short}。請核對。`;
    $('focus-state').classList.add('warning');$('focus-edit').textContent='核對平台與網址';
  }
  if(sourceNavigation&&overview.hasPlan&&!urlReview&&!engine.active)$('focus-edit').textContent=sourceNavigation.label;
  $('focus-edit').disabled = engine.active;
}
function setPresentation(next, persist = true) {
  presentation = next === 'workspace' ? 'workspace' : 'focus';
  document.body.dataset.view = presentation;
  $('focus-card').hidden = presentation !== 'focus';
  $('focus-view').setAttribute('aria-pressed', String(presentation === 'focus'));
  $('workspace-view').setAttribute('aria-pressed', String(presentation === 'workspace'));
  if (persist) { try { sessionStorage.setItem('encore.presentation.v1', presentation); } catch { /* No plan data is affected. */ } }
  renderFocus();
}
function storePreferences({replaceReminder=false}={}) {
  if(sourceSaveGuard!==null&&localStorage.getItem(storageKey)!==sourceSaveGuard.text)throw Object.assign(Error('其他分頁的已存計畫已變更；本頁草稿保留，未覆蓋。請先重新開啟計畫核對，再採用來源。'),{code:'SOURCE_SAVE_STALE'});
  if(sourceSaveGuard!==null&&mode==='live'&&!replaceReminder){const text=localStorage.getItem(reminderKey),old=text?parseReminder(text):null;if(old?.status==='armed'&&!samePreparation(old.plan,validatePlan(drafts.live,{live:true})))throw Object.assign(Error('原提醒仍用舊計畫，尚未儲存。請先「取消提醒」再儲存偏好，或明確按「儲存並設提醒」重新確認。'),{code:'SOURCE_REMINDER_REVIEW'});}
  let previous = { mock: demo(), live: empty() };
  try {
    const text = localStorage.getItem(storageKey);
    if (text) { const parsed = parsePreferences(text); previous = { mock: parsed.mock, live: parsed.live ?? empty() }; }
  } catch { /* Invalid or unavailable prior data is not copied into the new plan. */ }
  const safe = { ...previous };
  // Save only the mode the user confirmed. Another tab may own newer other-mode data.
  safe[mode] = validatePlan(drafts[mode], { live: mode === 'live' });
  const encoded=JSON.stringify(preferencesRecord(safe));localStorage.setItem(storageKey, encoded);if(sourceSaveGuard!==null)sourceSaveGuard={text:encoded};
  savedLivePlan = safe.live.title ? safe.live : null; preferencesIssue = false;
}
function renderPlatform() {
  document.querySelectorAll('[data-platform]').forEach(button => {
    const chosen = button.dataset.platform === platform;
    button.classList.toggle('chosen', chosen); button.setAttribute('aria-pressed', String(chosen));
  });
  const info = platforms[platform];
  $('platform-steps').textContent = info.steps.join(' → ') + '。實際步驟與規則依活動為準。';
  $('guide-link').href = info.guide;
  $('event-url').placeholder = platform === 'tixcraft' ? 'https://tixcraft.com/activity/detail/…' : 'https://主辦單位.kktix.cc/events/…';
}
function renderLogs(logs) {
  $('log-count').textContent = String(logs.length).padStart(2, '0');
  if (!logs.length) {
    $('logs').replaceChildren();
    const emptyRow = document.createElement('div'); emptyRow.className = 'empty-log';
    emptyRow.textContent = mode === 'mock' ? '⌁ 開始後，演練紀錄會出現在這裡。' : '⌁ 準備計畫後，本機提醒紀錄會出現在這裡。';
    $('logs').append(emptyRow); return;
  }
  $('logs').replaceChildren(...logs.map(log => {
    const line = document.createElement('div'); line.className = 'log-line';
    const time = document.createElement('time'); time.dateTime = log.at;
    time.textContent = new Date(log.at).toLocaleTimeString('zh-TW', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const text = document.createElement('span'); text.textContent = log.detail;
    line.append(time, text); return line;
  }));
  $('logs').scrollTop = $('logs').scrollHeight;
}
function logLocal(detail) {
  localLogs.push({ at: new Date().toISOString(), detail }); localLogs = localLogs.slice(-100); renderLogs(localLogs);
}
function setStep(index) {
  document.querySelectorAll('[data-step]').forEach(item => {
    const step = Number(item.dataset.step); item.classList.toggle('current', step === index); item.classList.toggle('done', step < index);
    item.querySelector('span').textContent = step < index ? '✓' : String(step + 1);
    item.setAttribute('aria-label', `${['讀取','匹配','接手','完成'][step]}，${step < index ? '已完成' : step === index ? '目前步驟' : '尚未進行'}`);
    if (step === index) item.setAttribute('aria-current', 'step'); else item.removeAttribute('aria-current');
  });
}
function renderRun(state) {
  const focusBefore = document.activeElement;
  $('status-title').textContent = statusNames[state.status] || state.status;
  $('status-detail').textContent = state.detail;
  $('status-icon').textContent = state.status === 'completed' ? '✓' : state.status === 'handoff' ? '↗' : ['failed', 'stopped'].includes(state.status) ? '■' : '◎';
  $('stop-button').disabled = !engine.active; $('start-button').disabled = engine.active; $('save-button').disabled = engine.active; $('plan-fields').disabled = engine.active;
  $('start-button').setAttribute('aria-busy',String(['reading','queue','backoff','holding','resuming'].includes(state.status)));
  for(const id of ['start-button','save-button']){if(engine.active)$(id).title='演練進行中，請先停止演練';else $(id).removeAttribute('title');}
  $('match-card').hidden = !state.selected;
  if (state.selected) {
    $('match-title').textContent = state.selected.area; $('match-session').textContent = `${state.selected.session} · ${currentMockPlan.quantity} 張`;
    $('match-price').textContent = `NT$ ${money(state.selected.price)}`;
    $('match-total').textContent = `合計 ${money(state.selected.price * currentMockPlan.quantity)}（模擬・未含費用）`;
  }
  $('handoff-card').hidden = state.status !== 'handoff';
  renderPaymentHandoff(state);
  if (state.status === 'handoff') {
    const review = state.pending === 'review';
    $('handoff-title').textContent = review ? '核對後，確認模擬送單' : state.pending === 'captcha' ? '驗證碼由你處理' : '登入由你處理';
    $('handoff-description').textContent = review ? '此動作只完成離線測試訂單，沒有付款或真實預訂。' : '這是合成情境，無需輸入密碼或驗證碼。點擊下方按鈕代表你已人工處理。';
    $('confirm-button').textContent = review ? '確認模擬送單' : '已人工處理，繼續模擬';
  }
  const step = state.status === 'completed' ? 3 : state.status === 'handoff' || state.status === 'holding' || state.status === 'resuming' ? 2 : state.selected ? 1 : 0;
  setStep(state.status === 'idle' ? -1 : step);
  $('runtime-summary').textContent = state.status === 'idle' ? '尚無執行中的演練' : `演練 #${state.runId} · 重試 ${state.retries}/3 · 模擬訂單 ${state.mockOrders}`;
  renderLogs(state.logs);
  if (engine.active && (focusBefore === $('start-button') || $('plan-fields').contains(focusBefore))) focusControl('stop-button');
  else if (state.status === 'handoff' && focusBefore === $('stop-button')) focusControl('confirm-button');
  else if (!engine.active && focusBefore === $('stop-button')) focusControl('start-button');
  renderFocus();
  refreshDataTools();
}
function renderPaymentHandoff(state = engine.snapshot()) {
  const visible = mode === 'mock' && state.status === 'handoff' && state.pending === 'review' && state.selected;
  $('payment-demo').hidden = !visible;
  if (!visible) return;
  if (handoffDemoRun !== state.runId) {
    handoffDemoRun = state.runId; handoffDemoAnchor = Date.now(); $('payment-demo-variant').value = 'unknown';
  }
  const value = paymentHandoffDemo(state.selected, currentMockPlan, { variant: $('payment-demo-variant').value, anchor: handoffDemoAnchor });
  const titles = { unknown: '暫留未確認', held: '暫留中（合成示範）', expired: '已逾期（合成示範）', paid: '已付款（合成示範）' };
  if ($('payment-demo-state').textContent !== titles[value.phase]) $('payment-demo-state').textContent = titles[value.phase];
  $('payment-demo-reservation').textContent = value.reservation === 'held' ? '示範暫留；沒有真票' : value.reservation === 'expired' ? '示範保留已到期，不能當成仍有票' : '未知；看到付款頁也不能推論已鎖票';
  $('payment-demo-payment').textContent = value.payment === 'paid' ? '已付款（合成，沒有扣款）' : value.payment === 'pending' ? '尚未付款（合成）' : '未知，未取得官方付款結果';
  $('payment-demo-quantity').textContent = `${value.quantity} 張（合成配對；不代表真票數）`;
  $('payment-demo-unit').textContent = `NT$ ${money(value.unitPrice)}（合成票價）`;
  $('payment-demo-subtotal').textContent = `NT$ ${money(value.subtotal)}`;
  $('payment-demo-fees').textContent = value.fees === null ? '未知，不能按 0 元計算' : `NT$ ${money(value.fees)}（虛構費用）`;
  $('payment-demo-total').textContent = value.total === null ? '未知，費用未確認' : `NT$ ${money(value.total)}（含虛構費用）`;
  $('payment-demo-budget').textContent = `每張上限 NT$ ${money(value.unitCap)} · ${value.quantity} 張票面上限 NT$ ${money(value.faceValueCap)}（未含費用）。\n含費總預算尚未設定，不能宣稱總額符合預算。`;
  $('payment-demo-deadline').textContent = value.deadline === null ? '未知，不啟動倒數' : `${taipeiTime(value.deadline)}（虛構截止時間）`;
  $('payment-demo-countdown').textContent = value.phase === 'paid' ? '示範已付款，不再倒數；以官方結果為準' : value.phase === 'expired' ? '示範已逾期，不顯示仍可付款' : value.remainingSeconds === null ? '沒有已核實的保留期限' : `示範倒數 ${String(Math.floor(value.remainingSeconds / 60)).padStart(2,'0')}:${String(value.remainingSeconds % 60).padStart(2,'0')} · 沒有真票保留`;
}
$('payment-demo-variant').addEventListener('change', () => renderPaymentHandoff());
function stopReplacedReminder() {
  const focusBefore = document.activeElement;
  const restoreFocus = [$('open-event'), $('cancel-reminder'), $('offline-cancel-reminder')].includes(focusBefore);
  reminder = cancelledReminder(reminder, Date.now(), 'replaced');
  if (mode === 'live') {
    activePlan = null; $('open-event').hidden = true; $('open-event').removeAttribute('href');
    document.querySelectorAll('#live-checklist input[type="checkbox"]').forEach(input => { input.checked = false; });
    $('status-title').textContent = '已存提醒已變更或清除';
    $('status-detail').textContent = '此頁舊提醒已停止；重新整理可載入目前儲存的計畫，或確認表單後重新建立。';
    $('runtime-summary').textContent = '舊提醒已停止 · 請重新確認計畫';
    message('已存提醒已變更或清除；此頁舊計畫已停止，請重新整理或重新建立計畫。', true);
    if (restoreFocus) focusControl(focusBefore === $('offline-cancel-reminder') && !$('reconnect-button').disabled ? 'reconnect-button' : 'start-button');
  }
}
function persistReminder(expectedId = null) {
  reminderIssue = '';
  try {
    // A stale tab may stop its own timer, but must not overwrite a newer plan.
    if (expectedId) {
      const text = localStorage.getItem(reminderKey), latest = text ? parseReminder(text) : null;
      if (!latest || latest.id !== expectedId || latest.status !== 'armed') {
        if (latest?.id === expectedId) reminder = latest;
        else stopReplacedReminder();
        return;
      }
    }
    localStorage.setItem(reminderKey, JSON.stringify(reminder)); reminderPersistent = true;
  }
  catch {
    reminderPersistent = false;
    // Only remove a record we own; another tab may have created a new reminder.
    try {
      const text = localStorage.getItem(reminderKey);
      if (text && parseReminder(text).id === reminder.id) localStorage.removeItem(reminderKey);
    } catch { /* The UI explicitly warns about unavailable storage. */ }
  }
}
function renderReminder() {
  const focusBefore = document.activeElement;
  $('reminder-card').hidden = (!reminder && !reminderIssue) || mode !== 'live';
  $('reminder-card').classList.toggle('storage-warning', !reminderPersistent || Boolean(reminderIssue));
  $('cancel-reminder').hidden = !reminder || reminder.status !== 'armed' || mode !== 'live';
  renderConnectionHelp();
  renderFocus();
  // Timers and cross-tab updates can remove the focused action without a click.
  // Keep keyboard users on a visible recovery control; leave other focus alone.
  if ([$('cancel-reminder'), $('offline-cancel-reminder')].includes(focusBefore) && focusBefore.hidden) {
    focusControl(focusBefore === $('offline-cancel-reminder') && !$('reconnect-button').disabled ? 'reconnect-button' : 'start-button');
  }
  if (reminderIssue) {
    $('reminder-title').textContent = reminderIssue === 'remove-failed' ? '舊提醒尚未清除' : reminder ? '提醒記錄異常，已停止' : '已存提醒無法讀取';
    $('reminder-detail').textContent = '目前沒有執行中的頁面提醒。';
    $('reminder-storage').textContent = reminderIssue === 'remove-failed' ? '無法清除舊提醒記錄；重開可能載入舊提醒。請先恢復瀏覽器儲存或清除舊資料。' : '沒有恢復或啟動提醒。請恢復瀏覽器儲存後重新建立計畫，或按「清除已存偏好」移除舊記錄。';
    return;
  }
  if (!reminder) return;
  const names = { armed: '開賣提醒已設定', fired: '這次提醒已完成', missed: '設定的提醒時間已過', cancelled: '這次提醒已取消' };
  $('reminder-title').textContent = names[reminder.status];
  $('reminder-detail').textContent = `${reminder.plan.title} · ${taipeiTime(reminder.at)}`;
  const detail = reminder.status === 'armed' ? '重新整理或重開同一網址會恢復倒數；頁面關閉時不會背景通知。' : reminder.status === 'fired' ? '已在開啟的頁面提醒一次；重新整理不會再次觸發。' : reminder.status === 'missed' ? (reminder.reason === 'past' ? '你輸入的時間已過，沒有發出開賣提醒。' : '頁面關閉或暫停期間未發出提醒；請人工查看官方活動。') : reminder.reason === 'edited' ? '修改偏好已取消舊提醒；確認新設定後請重新建立計畫。' : reminder.reason === 'replaced' ? '已存提醒已被變更或清除，此頁舊提醒已停止；重新整理可載入目前儲存的計畫。' : '不會繼續倒數或在重開後自動恢復。';
  $('reminder-storage').textContent = reminderPersistent ? detail : '無法儲存提醒狀態，僅此分頁有效；重開前請恢復瀏覽器儲存或清除舊資料，避免載入舊記錄。';
}
function reminderReadFailure(onLoad = false) {
  if (reminder?.status === 'armed') reminder = cancelledReminder(reminder, Date.now(), 'corrupt');
  reminderPersistent = false; reminderIssue = 'unreadable';
  if (onLoad) switchMode('live');
  renderReminder();
  if (mode === 'live') {
    $('status-title').textContent = '提醒記錄無法讀取';
    $('status-detail').textContent = '目前提醒已停止，請重新建立計畫。';
    $('runtime-summary').textContent = '提醒已停止 · 請修復儲存後重建';
  }
  message('已存提醒無法讀取，沒有恢復或啟動提醒；請恢復瀏覽器儲存後重新建立計畫。', true);
}
function cancelReminder(silent = false, reason = 'manual') {
  if (!reminder || reminder.status !== 'armed') return;
  reminder = cancelledReminder(reminder, Date.now(), reason); persistReminder(reminder.id); renderReminder();
  $('runtime-summary').textContent = reminder.status === 'cancelled' ? '本機提醒已取消' : '提醒已由另一分頁處理';
  if (!silent) logLocal(reminder.status === 'cancelled' ? '已取消本機提醒' : '提醒狀態已由另一分頁更新');
}
function invalidateLive() {
  if (mode !== 'live') return;
  document.querySelectorAll('#live-checklist input[type="checkbox"]').forEach(input => { input.checked = false; });
  if (!activePlan) return;
  cancelReminder(true, 'edited'); activePlan = null;
  $('open-event').hidden = true; $('open-event').removeAttribute('href');
  $('status-title').textContent = '偏好已變更'; $('status-detail').textContent = '請重新建立購票計畫，核對後再開啟活動頁。';
  $('runtime-summary').textContent = '等待重新確認計畫';
}
function switchMode(next) {
  if (mode === next) return;
  drafts[mode] = rawPlan();
  engine.stop(); cancelReminder(true); activePlan = null; mode = next;
  const mock = mode === 'mock';
  $('mock-mode').classList.toggle('selected', mock); $('live-mode').classList.toggle('selected', !mock);
  $('mock-mode').setAttribute('aria-selected', String(mock)); $('live-mode').setAttribute('aria-selected', String(!mock));
  $('mock-mode').tabIndex = mock ? 0 : -1; $('live-mode').tabIndex = mock ? -1 : 0;
  $('mode-caption').textContent = mock ? '合成資料・不連接售票網站' : '本機提醒・真實購票由你接手';
  $('hero-badge').textContent = mock ? '● REHEARSAL STUDIO' : '● READY FOR YOUR NEXT SHOW';
  if (mock) $('hero-title').replaceChildren('先練習一次。', document.createElement('br'), '上場，多一分從容。');
  else $('hero-title').textContent = '把期待，排進日程。';
  $('hero-description').textContent = mock ? '在安全的離線環境，熟悉排隊、選票與人工接手。所有票券與訂單皆為模擬，不會佔用真實庫存。' : '留下你的場次偏好與開賣時間。準備好後，由你在官方網站完成每一步。';
  $('hero-footnote').textContent = mock ? '01 — 選偏好　02 — 開始演練　03 — 準備上場' : '本機提醒依裝置時鐘運作；請保持此頁開啟。';
  $('plan-tag').textContent = mock ? '示範偏好' : '我的偏好'; $('run-tag').textContent = mock ? 'MOCK' : 'MANUAL';
  $('run-title').textContent = mock ? '演練控制室' : '開賣準備室';
  $('mock-options').hidden = !mock; $('live-options').hidden = mock; $('live-checklist').hidden = mock;
  document.querySelector('.stepper').hidden = !mock;
  document.querySelectorAll('#live-checklist input[type="checkbox"]').forEach(input => { input.checked = false; });
  $('event-url').required = !mock;
  $('stop-button').hidden = !mock; $('cancel-reminder').hidden = true; $('open-event').hidden = true;
  $('open-event').removeAttribute('href'); $('start-button').textContent = mock ? '開始離線演練 ↗' : '建立並儲存 ↗';
  $('plan-fields').disabled = false; $('start-button').disabled = false; $('save-button').disabled = false;
  $('match-card').hidden = true; $('handoff-card').hidden = true;
  writePlan(drafts[mode]); message('');
  if (mock) renderRun(engine.snapshot());
  else {
    $('status-title').textContent = '先確認，再出發'; $('status-detail').textContent = '填寫官方活動網址，建立你的本機購票準備計畫。';
    $('status-icon').textContent = '↗'; $('runtime-summary').textContent = '不連接帳戶、不查詢餘票'; setStep(-1); renderLogs(localLogs);
  }
  renderReminder();
}

$('mock-mode').addEventListener('click', () => { if (mode !== 'mock') { markUserChange(); switchMode('mock'); } });
$('focus-view').addEventListener('click', () => setPresentation('focus'));
$('workspace-view').addEventListener('click', () => setPresentation('workspace'));
$('focus-edit').addEventListener('click', () => { if (engine.active) return; const requestedSource=Boolean(sourceNavigation);if (mode !== 'live') { markUserChange(); switchMode('live'); } if(requestedSource&&sourceNavigation){setPresentation('workspace',false);if(sourceNavigation.target==='source-update'&&!$('source-update').hidden&&!$('source-update').disabled)$('source-update').click();else focusControl('phase-reference');return;}focusControl($('event-url').getAttribute('aria-invalid')==='true'?'event-url':'event-title'); });
$('find-sales').addEventListener('click',event=>{event.preventDefault();focusControl('sale-search');});
$('fill-return').addEventListener('click',()=>{if(mode==='live')focusControl('relay-main');});
$('live-checklist').addEventListener('change', () => { markUserChange(); renderFocus(); });
$('live-mode').addEventListener('click', () => { if (mode !== 'live') { markUserChange(); switchMode('live'); } });
document.querySelector('.mode-switch').addEventListener('keydown', event => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const nextMode = event.key === 'Home' ? 'mock' : event.key === 'End' ? 'live' : mode === 'mock' ? 'live' : 'mock';
  if (nextMode !== mode) { markUserChange(); switchMode(nextMode); }
  $(mode === 'mock' ? 'mock-mode' : 'live-mode').focus();
});
document.querySelectorAll('[data-platform]').forEach(button => button.addEventListener('click', () => { if (platform === button.dataset.platform) return; if(mode==='live')clearPositiveFormMessage(); markUserChange(); invalidateLive(); platform = button.dataset.platform; renderPlatform(); renderFocus(); editedPlanIssue(); }));
const preferencesChanged = () => { if(mode==='live')clearPositiveFormMessage(); markUserChange(); invalidateLive(); renderBudget(); editedPlanIssue(); };
$('plan-fields').addEventListener('input', preferencesChanged); $('plan-fields').addEventListener('change', preferencesChanged);
$('plan-fields').addEventListener('keydown',event=>{if(['Escape','Enter'].includes(event.key)&&!event.isComposing&&planIssue?.phase==='return'&&event.target===planIssue.control&&['text','url','number'].includes(event.target.type)){event.preventDefault();focusControl(planIssue.source);}});
$('plan-form').noValidate=true;
$('plan-form').addEventListener('submit', async event => {
  event.preventDefault(); message('');
  if (clearRecovery || clearing || restoring) { message('資料處理尚未完成，請先下載清除前副本並確認儲存狀態，再建立計畫。', true); return; }
  markUserChange();
  try {
    const value = checkedPlan(); drafts[mode] = value;
    if (mode === 'mock') { currentMockPlan = value; await engine.start(value, $('scenario').value); }
    else {
      livePolicy('prepare'); cancelReminder(true); activePlan = value;
      let planPersistent = true;
      try { storePreferences({replaceReminder:true}); } catch { planPersistent = false; }
      $('open-event').href = value.eventUrl; $('open-event').hidden = false;
      $('status-title').textContent = '計畫準備好了'; $('status-detail').textContent = `${platforms[platform].short} · ${value.title} · ${value.quantity} 張 · 每張上限 NT$ ${money(value.maxPrice)}`;
      logLocal('購票計畫已核對；尚未查詢網站、選票或送單');
      if (value.saleAt && !planPersistent) {
        // A new persisted reminder must agree with the saved preferences on reload.
        // Keep the draft available for a deliberate retry instead of storing half a pair.
        renderReminder();
        $('status-title').textContent = '偏好未儲存，未建立新提醒';
        $('status-detail').textContent = '目前表單仍保留；確認瀏覽器可儲存後，再重新確認計畫。';
        $('runtime-summary').textContent = '未建立新提醒 · 等待重新確認';
        message('無法儲存偏好，未建立新提醒。表單僅在此分頁保留；請確認瀏覽器可儲存後再試。', true);
        return;
      }
      if (value.saleAt) {
        livePolicy('remind'); reminder = newReminder(value, Date.now(), crypto.randomUUID()); persistReminder(); renderReminder();
        if (reminder.status === 'armed') { logLocal('已設定本機開賣提醒（台灣 UTC+8）；請保持頁面開啟'); tick(); }
        else { $('status-title').textContent = '設定的開賣時間已過'; $('runtime-summary').textContent = '沒有發出提醒 · 請人工核對'; }
      } else {
        reminder = null; reminderIssue = '';
        try { localStorage.removeItem(reminderKey); reminderPersistent = true; }
        catch { reminderIssue = 'remove-failed'; reminderPersistent = false; }
        renderReminder(); $('runtime-summary').textContent = '尚未設定開賣時間';
      }
      message(value.saleAt ? (reminderPersistent ? '計畫與提醒狀態已存於這個瀏覽器；關閉頁面不會背景通知。' : '偏好已儲存；提醒僅此分頁有效，重新整理可能遺失提醒。請確認瀏覽器可儲存後再試。') : reminderIssue ? '本分頁沒有提醒，但無法清除舊提醒記錄；重開前請恢復儲存或清除舊資料。' : planPersistent ? '計畫已建立並儲存在這個瀏覽器；尚未查詢網站、選票或送單。' : '計畫已建立，僅此分頁有效：無法儲存偏好，重新整理可能遺失。', !reminderPersistent || (!value.saleAt && !planPersistent));
    }
  } catch (error) { reportPlanError(error, 'start-button'); }
});
$('stop-button').addEventListener('click', () => engine.stop());
$('confirm-button').addEventListener('click', async () => {
  const restoreFocus = document.activeElement === $('confirm-button');
  $('confirm-button').disabled = true;
  try { await engine.confirm(); }
  finally {
    $('confirm-button').disabled = false;
    if (restoreFocus && mode === 'mock' && [document.body, $('confirm-button')].includes(document.activeElement)) {
      focusControl(engine.snapshot().status === 'handoff' ? 'confirm-button' : engine.active ? 'stop-button' : 'start-button');
    }
  }
});
$('cancel-reminder').addEventListener('click', () => {
  markUserChange();
  const restoreFocus = document.activeElement === $('cancel-reminder'); cancelReminder();
  if (restoreFocus) focusControl('start-button');
});
$('open-event').addEventListener('click', event => {
  try { if (!activePlan) throw new Error('請先建立計畫'); livePolicy('open-manually'); validatePlan(activePlan, { live: true }); logLocal('你已點選開啟活動頁；後續流程請在官方網站人工完成'); }
  catch (error) { event.preventDefault(); message(error.message, true); }
});
$('save-button').addEventListener('click', () => {
  if (clearRecovery || clearing || restoring) { message('資料處理尚未完成，請先保留清除前副本，再儲存新偏好。', true); return; }
  markUserChange();
  try {
    drafts[mode] = checkedPlan();
  } catch (error) { reportPlanError(error, 'save-button'); return; }
  try {
    storePreferences(); renderFocus(); message('偏好已儲存在這個瀏覽器。');
  } catch (error) {
    message(['SOURCE_SAVE_STALE','SOURCE_REMINDER_REVIEW'].includes(error.code)?error.message:'這次偏好未確認儲存；本頁內容仍保留。請保留本頁，確認瀏覽器可儲存後，再按「儲存偏好」。' + (mode === 'live' ? '儲存偏好不會建立或恢復提醒。' : ''), true);
  }
});
$('export-button').addEventListener('click', () => {
  $('export-message').textContent = '';
  let value;
  try { value = engine.active && mode === 'mock' ? currentMockPlan : checkedPlan(); }
  catch (error) { reportPlanError(error, 'export-button'); return; }
  try {
    const content = { schemaVersion: value.origin?2:1, mode, plan: value, automation: mode === 'mock' ? 'synthetic-only' : 'disabled', exportedAt: new Date().toISOString() };
    downloadJson(content, `encore-${mode}-plan.json`);
    exportMessage('計畫檔已交給瀏覽器下載；不含提醒，偏好未更新。');
  } catch { exportMessage('無法準備計畫下載；本頁內容保留，請稍後再試。偏好與提醒未更新。', true); }
});
function exportMessage(text,error=false){
  const box=$('export-message');box.textContent=text;box.classList.toggle('error',error);
  box.scrollIntoView({block:'nearest',behavior:'instant'});
}
function downloadJson(content, filename) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(content, null, 2)], { type: 'application/json' }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename; document.body.append(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const recoveryButton = document.createElement('button');
recoveryButton.id = 'backup-recovery'; recoveryButton.type = 'button'; recoveryButton.className = 'button secondary'; recoveryButton.textContent = '下載操作前副本'; recoveryButton.hidden = true;
recoveryButton.setAttribute('aria-describedby', 'restore-recovery-help');
$('restore-recovery').append(recoveryButton);
function holdRestoreRecovery(before) {
  restoreRecovery = { before, uncertain: true };
  $('restore-recovery').hidden = false; recoveryButton.hidden = false;
  refreshDataTools(); focusControl('backup-recovery');
}
const withReminderLock = async (action, options = {}) => {
  try { return navigator.locks ? await navigator.locks.request('encore-reminder-fire-v1', { signal: options.signal ?? AbortSignal.timeout(5000) }, action) : await action(); }
  catch (error) {
    if (['AbortError','TimeoutError'].includes(error.name)) throw new Error('另一分頁仍在處理提醒，沒有開始寫入；請稍後重試');
    throw error;
  }
};
function hydrateBackup(snapshot, preferredMode) {
  let preferences = null, restored = null;
  preferencesIssue = false; reminderIssue = '';
  try { if (snapshot[storageKey]) preferences = parsePreferences(snapshot[storageKey]); } catch { preferencesIssue = true; }
  try { if (snapshot[reminderKey]) restored = parseReminder(snapshot[reminderKey]); } catch { reminderIssue = 'unreadable'; }
  const nextDrafts = { mock: preferences?.mock ?? demo(), live: preferences?.live ?? (restored && restored.status !== 'cancelled' ? restored.plan : empty()) };
  reminder = null; activePlan = null;
  switchMode(preferredMode);
  drafts = nextDrafts; savedLivePlan = preferences?.live ?? null; writePlan(drafts[mode]);
  reminder = restored; reminderPersistent = !reminderIssue;
  document.querySelectorAll('#live-checklist input').forEach(input => { input.checked = false; });
  $('open-event').hidden = true; $('open-event').removeAttribute('href');
  if (mode === 'live') {
    if (reminder && reminder.status !== 'cancelled' && samePreparation(drafts.live, reminder.plan)) {
      activePlan = reminder.plan; $('open-event').href = activePlan.eventUrl; $('open-event').hidden = false;
    }
    $('status-title').textContent = '已還原本機資料'; $('status-detail').textContent = '偏好已載入；官方狀態未核實，請重新自查。';
    $('runtime-summary').textContent = reminder?.status === 'armed' ? '本機提醒已恢復' : reminder ? '已保留提醒狀態，不補發舊提醒' : '確認偏好後可重新建立提醒';
  } else renderRun(engine.snapshot());
  renderReminder();
}
function captureBackupUI() {
  return { mode, drafts: structuredClone(drafts), raw: rawPlan(), activePlan: structuredClone(activePlan), reminder: structuredClone(reminder), reminderPersistent, reminderIssue, preferencesIssue, checks: [...document.querySelectorAll('#live-checklist input')].map(input => input.checked) };
}
function clearProblem(error, undoing = false) {
  if (error.code === 'BACKUP_STALE') return '資料已在另一分頁或預覽後變更，沒有套用這次操作；請返回後重新確認。';
  if (error.code === 'BACKUP_ROLLED_BACK') return undoing ? '復原未完成，已確認保留清除狀態；可在期限內恢復儲存後重試。' : '清除未完成，已確認原資料完整保留；請恢復儲存後再試。';
  if (error.code === 'BACKUP_UNCERTAIN') return '儲存失敗且無法確認資料完整。本頁提醒已停止，其他分頁或重開仍可能有原提醒。請保留此頁，下載清除前副本，暫停其他 Encore 分頁，再恢復網站儲存。';
  return error.message;
}
function holdClearRecovery(before) {
  clearRecovery = { before }; undoClear = null; $('undo-clear').hidden = true; $('clear-recovery-backup').hidden = false;
  reminder = null; reminderIssue = 'unreadable'; reminderPersistent = false; renderReminder(); refreshDataTools();
  if (mode === 'live') { $('status-title').textContent = '清除結果待確認'; $('status-detail').textContent = '本頁提醒已停止；請下載清除前副本並恢復儲存。'; $('runtime-summary').textContent = '本頁提醒已停止 · 儲存結果待確認'; }
}
function downloadClearBefore() {
  const before = pendingClear?.before ?? clearRecovery?.before ?? undoClear?.before;
  if (!before) return;
  let content, filename = 'encore-before-clear.json', raw = false;
  try { content = createBackup(before); }
  catch { raw = true; filename = 'encore-before-clear-raw.json'; content = { format: 'encore-recovery-raw', schemaVersion: 1, exportedAt: new Date().toISOString(), rawSnapshot: before }; }
  downloadJson(content, filename);
  const text = raw ? '已下載原始資料副本；舊資料格式異常，這份檔案需要修復，不能直接匯入。請先保留。' : '已下載清除前副本；請保留檔案。';
  if ($('clear-dialog').open) clearDialogMessage(text + (clearRecovery ? ' 儲存狀態仍不確定，請先恢復儲存。' : ''), Boolean(clearRecovery));
  clearMessage(text + (clearRecovery ? ' 儲存狀態仍不確定，請保留此頁並先恢復儲存。' : ''), Boolean(clearRecovery));
}
function closeClearDialog() {
  const failedAttempt = pendingClear?.attempted && !clearing;
  pendingClear?.abort?.abort(); pendingClear = null; clearReturnFocus = clearRecovery ? 'clear-recovery-backup' : 'clear-button';
  $('clear-dialog').close();
  if (!clearRecovery && !failedAttempt) clearMessage('已返回，沒有執行清除。');
}
$('clear-button').addEventListener('click', () => {
  if (clearing || restoring || uncertainStorage() || $('clear-dialog').open) return;
  try {
    const before = readBackupSnapshot(localStorage), names = [];
    try { const value = before[storageKey] ? parsePreferences(before[storageKey]) : null; names.push(`購票偏好：${value?.live?.title ?? '沒有'}`, `演練偏好：${value?.mock?.title ?? '沒有'}`); }
    catch { names.push('已存偏好：格式異常，清除會移除這份舊資料'); }
    try { const value = before[reminderKey] ? parseReminder(before[reminderKey]) : null; const labels = { armed:'等待提醒', fired:'已完成', missed:'已錯過', cancelled:'已取消' }; names.push(value ? `提醒：${value.plan.title} · ${labels[value.status]} · ${taipeiTime(value.at)}` : '提醒：沒有'); }
    catch { names.push('提醒：格式異常，清除會移除這份舊記錄'); }
    pendingClear = { before, revision: userRevision, storageRevision: clearStorageRevision, abort: null }; clearReturnFocus = 'clear-button';
    $('clear-summary').textContent = names.join('\n'); clearDialogMessage('');
    $('clear-confirm').disabled = Object.values(before).every(value => value === null); $('clear-download').disabled = $('clear-confirm').disabled;
    if ($('clear-confirm').disabled) clearDialogMessage('目前沒有已存資料；表單草稿不會被清除。');
    $('clear-dialog').showModal(); focusControl('clear-cancel');
  } catch { clearMessage('無法讀取目前資料，尚未開始清除。請先恢復瀏覽器儲存，再重新確認。', true); }
});
$('clear-cancel').addEventListener('click', closeClearDialog);
$('clear-dialog').addEventListener('cancel', event => { event.preventDefault(); closeClearDialog(); });
$('clear-dialog').addEventListener('close', () => {
  pendingClear?.abort?.abort(); pendingClear = null;
  const target = $(clearReturnFocus); focusControl(target.hidden || target.disabled ? 'backup-toggle' : clearReturnFocus);
});
$('clear-download').addEventListener('click', downloadClearBefore);
$('clear-recovery-backup').addEventListener('click', downloadClearBefore);
$('clear-confirm').addEventListener('click', async () => {
  if (!pendingClear || clearing || restoring || uncertainStorage() || $('clear-confirm').disabled) return;
  const pending = pendingClear, ui = captureBackupUI(), after = { [storageKey]: null, [reminderKey]: null };
  pending.abort = new AbortController(); pending.attempted = true; clearing = true; refreshDataTools(); $('clear-confirm').disabled = true;
  clearDialogMessage('正在等待資料鎖並清除；開始寫入前可按返回取消。');
  try {
    await withReminderLock(() => {
      if (pendingClear !== pending) throw new Error('清除已取消');
      if (pending.revision !== userRevision || pending.storageRevision !== clearStorageRevision) throw Object.assign(new Error('內容已變更'), { code:'BACKUP_STALE' });
      commitBackupSnapshot(localStorage, pending.before, after);
    }, { signal: AbortSignal.any([pending.abort.signal, AbortSignal.timeout(5000)]) });
    markUserChange(); savedLivePlan = null; preferencesIssue = false; reminder = null; reminderIssue = ''; reminderPersistent = true;
    renderReminder(); undoClear = { before: pending.before, after, ui, revision: userRevision, storageRevision: clearStorageRevision, deadline: performance.now() + clearUndoLimit };
    if (mode === 'live') { $('status-title').textContent = '已清除已存資料'; $('status-detail').textContent = '目前表單保留；如需提醒，請重新建立計畫或復原這次清除。'; $('runtime-summary').textContent = '目前沒有執行中的提醒'; }
    $('undo-clear').hidden = false; pendingClear = null; clearReturnFocus = 'undo-clear'; $('clear-dialog').close();
    clearMessage('已清除已存偏好與提醒；表單及演練保留。10 分鐘內、未關閉／重整或新增修改前，可復原這次清除。');
  } catch (error) {
    if (pendingClear !== pending) return;
    if (error.code === 'BACKUP_UNCERTAIN') holdClearRecovery(pending.before);
    let stopped = false;
    if (error.code !== 'BACKUP_UNCERTAIN' && reminder?.status === 'armed') { reminder = cancelledReminder(reminder, Date.now(), 'manual'); reminderPersistent = false; reminderIssue = 'remove-failed'; renderReminder(); stopped = true; }
    if (stopped && mode === 'live') { $('status-title').textContent = '清除未完成'; $('status-detail').textContent = '本頁提醒已停止，但已存記錄仍保留；其他分頁或重開可能恢復。'; $('runtime-summary').textContent = '本頁提醒已停止 · 已存記錄未清除'; }
    const detail = clearProblem(error) + (stopped ? ' 本分頁已停止提醒；其他分頁或重新開啟仍可能恢復原提醒。' : '');
    clearDialogMessage(detail, true); clearMessage(detail, true);
    $('clear-confirm').disabled = ['BACKUP_UNCERTAIN','BACKUP_STALE'].includes(error.code);
    focusControl('clear-cancel');
  } finally { clearing = false; refreshDataTools(); }
});
function expireClearUndo() {
  if (!undoClear || performance.now() < undoClear.deadline) return;
  const focused = document.activeElement === $('undo-clear'); undoClear = null; $('undo-clear').hidden = true;
  clearMessage('清除復原已超過 10 分鐘；如要找回資料，請從先前下載的備份還原。');
  if (focused) focusControl('clear-button');
}
$('undo-clear').addEventListener('click', async () => {
  expireClearUndo(); if (!undoClear || clearing || restoring || uncertainStorage()) return;
  const undo = undoClear; let returnFocus = ''; clearing = true; refreshDataTools(); clearMessage('正在復原清除前資料，請稍候。');
  try {
    const restored = await withReminderLock(() => {
      if (undoClear !== undo || undo.revision !== userRevision || undo.storageRevision !== clearStorageRevision || performance.now() >= undo.deadline) throw new Error('復原期限已過或內容已修改，沒有套用舊資料。');
      const target = prepareClearUndo(undo.before, { id: crypto.randomUUID() });
      commitBackupSnapshot(localStorage, undo.after, target); return target;
    });
    preferencesIssue = false; reminderIssue = '';
    try { savedLivePlan = restored[storageKey] ? parsePreferences(restored[storageKey]).live : null; } catch { savedLivePlan = null; preferencesIssue = true; }
    try { reminder = restored[reminderKey] ? parseReminder(restored[reminderKey]) : null; reminderPersistent = true; } catch { reminder = null; reminderPersistent = false; reminderIssue = 'unreadable'; }
    drafts = undo.ui.drafts; activePlan = undo.ui.activePlan; writePlan(undo.ui.raw);
    document.querySelectorAll('#live-checklist input').forEach((input,index) => { input.checked = undo.ui.checks[index]; });
    renderReminder(); undoClear = null; $('undo-clear').hidden = true;
    if (mode === 'live') { $('status-title').textContent = '已復原清除前資料'; $('status-detail').textContent = '偏好與原提醒狀態已回復；已過期提醒不補發。'; $('runtime-summary').textContent = reminder?.status === 'armed' ? '已復原頁面提醒' : reminder?.status === 'missed' ? '提醒已錯過，不補發' : '目前沒有執行中的提醒'; }
    clearMessage(preferencesIssue || reminderIssue ? '已復原清除前的原始資料，其中格式異常仍需處理。' : '已復原清除前偏好與提醒；過期提醒標記錯過，不補發。', Boolean(preferencesIssue || reminderIssue));
    returnFocus = 'clear-button';
  } catch (error) {
    if (error.code === 'BACKUP_UNCERTAIN') holdClearRecovery(undo.before);
    clearMessage(clearProblem(error, true), true);
    if (error.code === 'BACKUP_STALE') { undoClear = null; $('undo-clear').hidden = true; }
    if (clearRecovery || error.code === 'BACKUP_STALE') returnFocus = clearRecovery ? 'clear-recovery-backup' : 'clear-button';
    if (!$('backup').open && !clearRecovery) returnFocus = 'clear-message';
  } finally { clearing = false; refreshDataTools(); if (returnFocus) focusControl(returnFocus); else if (document.activeElement === document.body && $('undo-clear').hidden) focusControl('clear-button'); }
});
setInterval(expireClearUndo, 1000);
function backupBefore() {
  const before = restoreRecovery?.before ?? pendingRestore?.before ?? undoRestore?.before;
  if (!before) return;
  let content, filename = 'encore-before-restore.json', raw = false;
  try { content = createBackup(before); }
  catch { raw = true; filename = 'encore-before-restore-raw.json'; content = { format: 'encore-recovery-raw', schemaVersion: 1, exportedAt: new Date().toISOString(), rawSnapshot: before }; }
  try {
    downloadJson(content, filename);
    if (raw && restoreRecovery?.uncertain) $('restore-recovery-help').textContent = '已保留本次作業開始前的原始資料副本。因原資料格式異常，檔案需要修復，不能直接匯入。請先保留檔案，再恢復儲存並重新整理。確認還原仍維持停用。';
    backupMessage(raw ? '已下載原始資料副本；原資料格式異常，這份檔案需要修復，不能直接匯入。請保留檔案，恢復儲存後再重新整理。'
      : restoreRecovery?.uncertain ? '已下載操作前副本，但儲存狀態仍不確定。請恢復儲存並重新整理，再從副本還原。' : '已下載操作前副本；請保留檔案。', raw || Boolean(restoreRecovery?.uncertain));
  } catch { backupMessage('無法建立下載；操作前資料仍保留在此頁，請先不要關閉，稍後再試。', true); }
}
$('backup-before').addEventListener('click', backupBefore); recoveryButton.addEventListener('click', backupBefore);
$('backup-button').addEventListener('click', () => {
  if (clearRecovery) { backupMessage('清除結果尚未確定，請改按「下載清除前副本」，保留原資料後再恢復儲存。', true); return; }
  if (restoreRecovery?.uncertain) { backupMessage('目前儲存狀態不確定，請改按「下載操作前副本」，保留資料後再恢復儲存並重新整理。', true); return; }
  try { downloadJson(createBackup(readBackupSnapshot(localStorage)), 'encore-backup.json'); backupMessage('已下載已存偏好與提醒的備份；未儲存草稿不在檔案內。'); }
  catch (error) { backupMessage(`無法備份：${backupProblem(error)}`, true); }
});
$('restore-choose').addEventListener('click', () => { if (engine.active || restoring || clearing || uncertainStorage()) return; $('restore-file').click(); });
$('restore-file').addEventListener('change', async () => {
  if (restoring || clearing || engine.active || uncertainStorage()) return;
  const serial = ++restoreReadSerial, file = $('restore-file').files?.[0];
  pendingRestore = null; $('restore-preview').hidden = true;
  if (!file) return;
  readingRestore = true;
  backupMessage('正在讀取檔案；還原操作還沒修改資料。');
  try {
    if (file.size > backupLimit) throw new Error('備份檔太大，最多 64 KB');
    let text;
    try { text = await file.text(); } catch { throw new Error('無法讀取這個檔案，請重新選擇'); }
    if (serial !== restoreReadSerial) return;
    readingRestore = false;
    const backup = parseBackup(text), before = readBackupSnapshot(localStorage);
    const target = prepareBackupRestore(backup, before, { id: crypto.randomUUID(), fallbackMock: demo() });
    pendingRestore = { backup, before, revision: userRevision };
    $('restore-file-name').textContent = file.name.slice(0, 120).replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200b\u200e\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/gu, '�');
    const names = { armed: '確認後恢復倒數', fired: '已完成，不會再次提醒', missed: '時間已過，不補發', cancelled: '已取消，不會重啟' };
    const reminderDescription = backup.kind === 'plan' ? backup.mode === 'mock' ? '原有提醒保留；這個舊檔不含提醒' : '舊提醒將移除，需重新建立' : target.reminder ? target.reminder.plan.title + ' · ' + names[target.reminder.status] : '不含提醒，需另外建立';
    const exportedTime = new Date(backup.exportedAt).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false });
    $('restore-details').textContent = `${backup.kind === 'full' ? '完整備份' : '單一計畫檔'}（版本 ${backup.schemaVersion}） · 台灣 UTC+8\n匯出時間：${exportedTime}（台灣）\n購票偏好：${target.preferences?.live?.title ?? '沒有'}\n演練偏好：${target.preferences?.mock?.title ?? '沒有'}\n提醒：${reminderDescription}`;
    renderRestoreFacts(backup, target);
    let currentTitle = '沒有已存偏好';
    try { if (before[storageKey]) { const current = parsePreferences(before[storageKey]); currentTitle = (backup.kind === 'plan' && backup.mode === 'mock' ? current.mock : current.live)?.title ?? '沒有已存購票偏好'; } }
    catch { currentTitle = '目前資料格式異常'; }
    $('restore-overwrite').textContent = backup.kind === 'full'
      ? (before[storageKey] || before[reminderKey] ? `目前：${currentTitle}。將取代這個瀏覽器已存的偏好與提醒，也會更新目前表單。可先下載目前資料。` : '這個瀏覽器沒有已存資料，確認後將新增偏好與提醒。')
      : `目前：${currentTitle}。` + (backup.mode === 'live' ? '只取代購票偏好並移除舊提醒；演練偏好保留（尚未儲存時使用預設值）。此計畫檔不含提醒，需重新建立。' : '只取代演練偏好；購票偏好與現有提醒保留。');
    $('backup-before').hidden = !before[storageKey] && !before[reminderKey];
    $('restore-preview').hidden = false; backupMessage('檔案已讀取，請先看預覽；尚未變更任何資料。'); focusControl('restore-confirm');
  } catch (error) { if (serial === restoreReadSerial) { readingRestore = false; $('restore-file').value = ''; backupMessage(`無法還原：${backupProblem(error)}`, true); if (!$('backup').open) focusControl('backup-message'); } }
});
$('restore-cancel').addEventListener('click', () => {
  restoreReadSerial++; pendingRestore = null; $('restore-file').value = ''; $('restore-preview').hidden = true;
  backupMessage(restoreRecovery?.uncertain ? '已關閉預覽。先前儲存狀態仍不確定，請下載還原前資料並恢復瀏覽器儲存。' : '已取消，沒有套用檔案內容。', Boolean(restoreRecovery?.uncertain)); focusControl(restoreRecovery?.uncertain ? 'backup-recovery' : 'restore-choose');
});
$('restore-confirm').addEventListener('click', async () => {
  if (!pendingRestore || restoring || clearing || uncertainStorage() || engine.active) return;
  const pending = pendingRestore, ui = captureBackupUI(); restoring = true; refreshDataTools();
  backupMessage('正在還原，請稍候；不會開啟售票網站。');
  $('restore-confirm').disabled = true; $('restore-cancel').disabled = true; $('restore-choose').disabled = true;
  try {
    const target = await withReminderLock(() => {
      if (pending.revision !== userRevision) throw new Error('內容已變更，請重新選檔預覽');
      const target = prepareBackupRestore(pending.backup, pending.before, { id: crypto.randomUUID(), fallbackMock: demo() });
      commitBackupSnapshot(localStorage, pending.before, target.snapshot); return target;
    });
    if (pending.backup.kind === 'plan' && pending.backup.mode === 'mock') {
      drafts.mock = target.preferences.mock; savedLivePlan = target.preferences.live;
      if (mode === 'mock') writePlan(drafts.mock); renderFocus();
    } else hydrateBackup(target.snapshot, target.mode);
    undoRestore = { before: pending.before, after: target.snapshot, ui, revision: userRevision };
    if (undoClear) { undoClear = null; $('undo-clear').hidden = true; clearMessage('已還原其他資料，不再提供先前清除的復原。'); }
    restoreRecovery = null; pendingRestore = null; $('restore-preview').hidden = true; $('restore-file').value = '';
    $('undo-restore').hidden = false; recoveryButton.hidden = true; $('restore-recovery').hidden = true;
    backupMessage('已還原。偏好已載入；舊提醒不補發。若不對，可在此頁復原到還原前。'); focusControl('undo-restore');
  } catch (error) {
    if (error.code === 'BACKUP_UNCERTAIN') holdRestoreRecovery(pending.before);
    backupMessage(backupProblem(error), true);
    if (error.code === 'BACKUP_STALE') { pendingRestore = null; $('restore-preview').hidden = true; }
    if (!$('backup').open) focusControl('backup-message');
  } finally { restoring = false; $('restore-cancel').disabled = false; refreshDataTools(); }
});
$('undo-restore').addEventListener('click', async () => {
  if (!undoRestore || restoring || clearing || uncertainStorage() || engine.active) return;
  const undo = undoRestore; let returnFocus = ''; restoring = true; refreshDataTools(); $('undo-restore').disabled = true;
  backupMessage('正在復原，請稍候。');
  try {
    if (undo.revision !== userRevision) throw new Error('還原後內容已變更，為避免覆蓋，請先備份目前資料');
    await withReminderLock(() => {
      if (undo.revision !== userRevision) throw new Error('還原後內容已變更，為避免覆蓋，請先備份目前資料');
      commitBackupSnapshot(localStorage, undo.after, undo.before);
    });
    hydrateBackup(undo.before, undo.ui.mode);
    drafts = undo.ui.drafts; writePlan(undo.ui.raw); activePlan = undo.ui.activePlan;
    reminder = undo.ui.reminder ? advanceReminder(undo.ui.reminder, Date.now(), { restoring: true }) : null;
    reminderIssue = undo.ui.reminderIssue; reminderPersistent = undo.ui.reminderPersistent; preferencesIssue = undo.ui.preferencesIssue;
    if (reminder && reminderPersistent && undo.before[reminderKey]) {
      try { if (reminder.status !== parseReminder(undo.before[reminderKey]).status) persistReminder(reminder.id); }
      catch { reminder = null; reminderIssue = 'unreadable'; reminderPersistent = false; }
    }
    document.querySelectorAll('#live-checklist input').forEach((input, index) => { input.checked = undo.ui.checks[index]; });
    $('open-event').hidden = !activePlan; if (activePlan) $('open-event').href = activePlan.eventUrl; else $('open-event').removeAttribute('href');
    renderReminder(); undoRestore = null; $('undo-restore').hidden = true;
    backupMessage('已復原到還原前。已過時間的提醒不會補發。'); returnFocus = 'restore-choose';
  } catch (error) {
    if (error.code === 'BACKUP_UNCERTAIN') {
      holdRestoreRecovery(undo.after);
      undoRestore = null; $('undo-restore').hidden = true; $('restore-choose').disabled = true; focusControl('backup-recovery');
    }
    backupMessage(backupProblem(error), true);
    if (!$('backup').open) focusControl('backup-message');
  }
  finally { restoring = false; $('undo-restore').disabled = false; refreshDataTools(); if (returnFocus) focusControl(returnFocus); }
});
async function tick() {
  renderPaymentHandoff();
  renderFocus();
  if (clearing || !reminder || reminder.status !== 'armed' || mode !== 'live' || tickingReminder) return;
  const seconds = Math.max(0, Math.ceil((reminder.at - Date.now()) / 1000));
  if (!seconds) {
    tickingReminder = true;
    const expectedId = reminder.id;
    const resolve = () => {
      if (clearing) return;
      if (!reminder || reminder.id !== expectedId || reminder.status !== 'armed' || mode !== 'live' || Date.now() < reminder.at) return;
      let latest = null;
      try { const text = localStorage.getItem(reminderKey); if (text) latest = parseReminder(text); }
      catch { reminderReadFailure(); return; }
      if ((!latest && reminderPersistent) || (latest && latest.id !== reminder.id)) { stopReplacedReminder(); renderReminder(); return; }
      if (latest && latest.status !== 'armed') { reminder = latest; renderReminder(); $('runtime-summary').textContent = '提醒已由另一分頁處理'; return; }
      reminder = advanceReminder(reminder, Date.now()); persistReminder(); renderReminder();
      $('status-title').textContent = reminder.status === 'fired' ? '你設定的開賣時間到了' : '提醒時間已錯過';
      $('status-detail').textContent = '請人工查看官方活動頁。這是本機時間狀態，不代表仍有票或已開賣。';
      if (reminder.status === 'fired') logLocal('本機開賣提醒已觸發，沒有自動開頁或送出任何請求');
      else logLocal('提醒時間已錯過；頁面或裝置暫停期間未發出通知');
      $('runtime-summary').textContent = reminder.status === 'fired' ? '提醒完成 · 請人工接手' : '錯過提醒 · 請人工核對';
    };
    try { if (navigator.locks) await navigator.locks.request('encore-reminder-fire-v1', resolve); else resolve(); }
    finally { tickingReminder = false; }
  } else {
    const days = Math.floor(seconds / 86400), h = Math.floor(seconds % 86400 / 3600), m = Math.floor(seconds % 3600 / 60), s = seconds % 60;
    $('runtime-summary').textContent = `開賣倒數 ${days ? days + ' 天 ' : ''}${[h, m, s].map(x => String(x).padStart(2, '0')).join(':')} · 本機時鐘`;
  }
}
setInterval(tick, 1000);
let checkingConnection = false;
function renderConnectionHelp() {
  const armed = reminder?.status === 'armed';
  $('offline-cancel-reminder').hidden = !connectionOffline || !armed;
  $('connection-help').textContent = armed ? '本機服務已離線，但這個分頁的開賣提醒仍在倒數。若要停止提醒，請按「停止此頁提醒」或關閉 Encore 分頁；需要服務時再雙擊桌面啟動器。' : '目前沒有執行中的頁面提醒。需要服務時，請重新雙擊桌面的 Encore - SHOW，再按重新連線。已載入的表單仍保留。';
}
async function checkConnection() {
  if (document.documentElement.dataset.edition === 'web') {
    connectionOffline = false;
    $('connection-status').textContent = '● 網頁版 · 偏好只存此瀏覽器';
    $('connection-status').classList.remove('offline'); $('connection-notice').hidden = true;
    return;
  }
  if (checkingConnection) return;
  checkingConnection = true; $('reconnect-button').disabled = true;
  $('reconnect-button').setAttribute('aria-busy','true');
  try {
    const response = await fetch('/health', { cache: 'no-store', signal: AbortSignal.timeout(2500) });
    const health = await response.json();
    if (!response.ok || health.app !== 'encore-local' || health.mode !== 'local-only') throw new Error('mismatch');
    connectionOffline = false;
    $('connection-status').textContent = '● 本機服務已就緒'; $('connection-status').classList.remove('offline'); $('connection-notice').hidden = true;
  } catch (error) {
    connectionOffline = true;
    $('connection-status').textContent = '● 本機服務已離線'; $('connection-status').classList.add('offline'); $('connection-notice').hidden = false;
    $('connection-title').textContent = error.message === 'mismatch' ? '此網址未回應正確的 Encore 服務' : '本機服務暫時無法連線';
  } finally { checkingConnection = false; $('reconnect-button').disabled = false; $('reconnect-button').setAttribute('aria-busy','false'); renderConnectionHelp(); }
}
$('reconnect-button').addEventListener('click', checkConnection);
$('offline-cancel-reminder').addEventListener('click', () => {
  markUserChange();
  const restoreFocus = document.activeElement === $('offline-cancel-reminder'); cancelReminder();
  if (restoreFocus) focusControl($('reconnect-button').disabled ? 'start-button' : 'reconnect-button');
});
if (document.documentElement.dataset.edition !== 'web') setInterval(checkConnection, 15000);
checkConnection();
try {
  const saved = localStorage.getItem(storageKey);
  if (saved) { const parsed = parsePreferences(saved); drafts = { mock: parsed.mock, live: parsed.live ?? empty() }; savedLivePlan = parsed.live; message('已載入這個瀏覽器內的偏好。'); }
} catch { preferencesIssue = true; message('已存偏好無法讀取，已改用安全的示範值；可點清除已存偏好。', true); }
$('live-mode').tabIndex = -1;
writePlan(drafts.mock); renderRun(engine.snapshot());
try {
  const text = localStorage.getItem(reminderKey);
  if (text) {
    const saved = parseReminder(text);
    if (saved.status === 'armed' && savedLivePlan && !samePreparation(saved.plan, savedLivePlan)) throw new Error('提醒與偏好不一致');
    switchMode('live');
    reminder = advanceReminder(saved, Date.now(), { restoring: true });
    if (reminder.status !== 'cancelled' && (!savedLivePlan || samePreparation(savedLivePlan, reminder.plan))) { drafts.live = reminder.plan; writePlan(reminder.plan); activePlan = reminder.plan; $('open-event').href = reminder.plan.eventUrl; $('open-event').hidden = false; }
    if (reminder !== saved) persistReminder();
    renderReminder();
    $('status-title').textContent = reminder.status === 'armed' ? '已恢復你的開賣提醒' : reminder.status === 'missed' ? (reminder.reason === 'past' ? '設定的開賣時間已過' : '離線期間提醒時間已過') : reminder.status === 'fired' ? '上次提醒已完成' : '上次提醒已取消';
    $('status-detail').textContent = reminder.status === 'cancelled' ? '舊提醒不會重啟；請確認表單後重新建立計畫。' : `${reminder.plan.title} · ${taipeiTime(reminder.at)}`;
    $('runtime-summary').textContent = reminder.status === 'missed' ? '沒有在關閉期間發送通知' : reminder.status === 'fired' ? '不會重複觸發已完成提醒' : reminder.status === 'cancelled' ? '不會恢復已取消提醒' : '本機提醒已恢復';
    tick();
  }
} catch { reminderReadFailure(true); }
window.addEventListener('storage', event => {
  try { if (event.storageArea === localStorage && [storageKey, reminderKey, null].includes(event.key)) {
    clearStorageRevision++;
    if (pendingClear && !clearRecovery) { $('clear-confirm').disabled = true; clearDialogMessage('另一分頁已修改資料，請返回後重新確認清除範圍。', true); }
    if (undoClear) { const focused = document.activeElement === $('undo-clear'); undoClear = null; $('undo-clear').hidden = true; clearMessage('另一分頁已修改資料，不再用舊清除副本覆蓋；可從下載備份另外還原。'); if (focused) focusControl('clear-button'); }
  } } catch { /* Snapshot checks still refuse writes if storage is inaccessible. */ }
  try {
    if (event.storageArea === localStorage && (event.key === storageKey || event.key === null)) {
      const text = localStorage.getItem(storageKey); savedLivePlan = text ? parsePreferences(text).live : null; preferencesIssue = false;if(mode==='live')clearPositiveFormMessage(); renderFocus();
    }
  } catch { savedLivePlan = null; preferencesIssue = true; renderFocus(); }
  if ((event.key !== reminderKey && event.key !== null) || !reminder) return;
  try {
    if (event.storageArea !== localStorage) return;
    // Event payloads may be delayed; reconcile against current storage instead.
    const text = localStorage.getItem(reminderKey), updated = text ? parseReminder(text) : null;
    if (updated?.id === reminder.id) {
      if (reminder.status === 'armed' || updated.status !== 'armed') reminder = updated;
    } else if (reminder.status === 'armed') stopReplacedReminder();
    renderReminder();
    if (reminder.status !== 'armed' && mode === 'live') $('runtime-summary').textContent = '提醒狀態已由另一分頁更新';
  } catch { reminderReadFailure(); }
});
setPresentation(presentation, false);
if (readingLayout) installReadingLayout();
if (posterLayout) installPosterLayout();

function installReadingLayout() {
  const paths = {
    grid:'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',
    ticket:'M3 5h18v5a2 2 0 0 0 0 4v5H3v-5a2 2 0 0 0 0-4z M15 5v3m0 3v2m0 3v3',
    clock:'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18 M12 7v5l3 2',
    save:'M4 3h13l3 3v15H4z M8 3v6h8V3 M8 21v-8h8v8',
    download:'M12 3v12m-4-4 4 4 4-4 M4 16v5h16v-5',
    upload:'M12 16V4m-4 4 4-4 4 4 M4 16v5h16v-5',
    play:'m8 4 12 8-12 8z', stop:'M5 5h14v14H5z',
    edit:'m4 16-1 5 5-1L20 8l-4-4z M14 6l4 4',
    shield:'m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6z M8 12l3 3 5-6',
    arrow:'M5 12h14m-6-6 6 6-6 6', info:'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18 M12 11v6 M12 7v1'
  };
  function icon(name) {
    const svg=document.createElementNS('http://www.w3.org/2000/svg','svg'),path=document.createElementNS(svg.namespaceURI,'path');
    svg.classList.add('ui-icon'); svg.setAttribute('viewBox','0 0 24 24'); svg.setAttribute('aria-hidden','true'); svg.setAttribute('focusable','false');
    path.setAttribute('d',paths[name]??paths.info); svg.append(path); return svg;
  }
  const labels = new Map([['開始離線演練 ↗','開始演練'],['建立並儲存 ↗','儲存並提醒'],['編輯這場偏好 ↗','編輯偏好'],['開始購票準備 ↗','開始準備']]);
  for (const [id,name] of [['start-button','play'],['save-button','save'],['export-button','download'],['focus-edit','edit'],['stop-button','stop'],['backup-button','download'],['restore-choose','upload'],['backup-recovery','download'],['clear-recovery-backup','download'],['open-event','arrow'],['cancel-reminder','stop'],['focus-view','ticket'],['workspace-view','grid'],['mock-mode','play'],['live-mode','ticket']]) {
    const node=$(id); if(!node)continue;
    function paint() {
      const raw=node.textContent.trim(),label=labels.get(raw)??raw.replace(/^[◉↗■]\s*/u,'').replace(/\s*↗$/u,'');
      if(!node.querySelector(':scope > .ui-icon')||raw!==label)node.replaceChildren(icon(id==='start-button'&&mode==='live'?(label==='儲存並設提醒'?'clock':'save'):name),document.createTextNode(label));
      node.classList.add('icon-label');
    }
    paint(); new MutationObserver(paint).observe(node,{childList:true});
  }
  document.querySelectorAll('.nav-item').forEach((node,index)=>{node.firstElementChild?.replaceChildren(icon(['grid','ticket','download','shield'][index]));});
  document.querySelectorAll('.focus-facts dt').forEach((node,index)=>{node.prepend(icon(['clock','shield','ticket','info'][index]));node.classList.add('icon-label');});
  document.querySelectorAll('.info-icon').forEach((node,index)=>node.replaceChildren(icon(['shield','ticket','save'][index])));
  const statusIcon=$('status-icon');
  function paintStatus(){if(!statusIcon.querySelector('.ui-icon')){statusIcon.replaceChildren(icon(engine.snapshot().status==='completed'?'shield':'info'));statusIcon.setAttribute('aria-hidden','true');}}
  paintStatus();new MutationObserver(paintStatus).observe(statusIcon,{childList:true});
  const brief=['真實購票由你操作；不啟用未授權自動化。','前往官方頁，核對當場流程與規則。','偏好只存此瀏覽器；不連接帳戶。'];
  document.querySelectorAll('.info-card').forEach((card,index)=>{
    const original=card.querySelector('p');if(!original)return;
    const details=document.createElement('details'),summary=document.createElement('summary'),short=document.createElement('p');
    details.className='reading-details';summary.textContent='詳細說明';short.textContent=brief[index];
    original.before(short,details);details.append(summary,original);
  });
  $('preferences-title').textContent='購票偏好';$('rules-title').textContent='購票須知';
}

function installPosterLayout() {
  const card=$('focus-card'),copy=document.createElement('div'),date=document.createElement('section'),dateList=document.createElement('dl'),type=document.createElement('div'),day=document.createElement('span'),month=document.createElement('span');
  copy.className='poster-copy';date.className='poster-date';date.setAttribute('aria-labelledby','poster-date-label');dateList.className='poster-date-details';type.className='poster-date-type';type.setAttribute('aria-hidden','true');day.id='poster-day';month.id='poster-month';type.append(day,month);
  const group=$('focus-time').parentElement;group.querySelector('dt').id='poster-date-label';dateList.append(group);date.append(type,dateList);
  copy.append(card.querySelector('.focus-heading'),$('focus-title'),$('focus-state'),card.querySelector('.focus-actions'));
  card.prepend(copy,date);const facts=$('focus-facts');facts.append($('focus-cap').parentElement,$('focus-budget').parentElement,$('focus-needs').parentElement);
  installEmptyLineup(date);
  function stampDate(){const match=$('focus-time').textContent.match(/^(\d{4})-(\d{2})-(\d{2})/);day.textContent=match?match[3]:'—';month.textContent=match?`${match[1]} / ${match[2]}`:'日期未定';}
  const truth=document.createElement('span');truth.className='poster-truth';truth.textContent='官網未連線 · 未送單／票況未知';copy.querySelector('.focus-heading').append(truth);
  const details=document.createElement('details'),detailsSummary=document.createElement('summary'),detailList=document.createElement('dl');details.id='preparation-details';details.className='reading-details';detailsSummary.textContent='準備詳情';details.append(detailsSummary,detailList);card.append(details);
  function fullDetail(label,node){const term=document.createElement('dt'),description=document.createElement('dd');term.textContent=label;description.append(node);detailList.append(term,description);}
  const fullStatus=document.createElement('span'),fullNeeds=document.createElement('span'),dateFlag=document.createElement('p');dateFlag.id='poster-date-flag';dateFlag.className='poster-date-flag';date.append(dateFlag);
  fullDetail('提醒狀態',fullStatus);fullDetail('開賣時間來源',$('focus-time-note'));fullDetail('票價與費用',$('focus-budget-note'));fullDetail('手動核對項目',fullNeeds);
  const checkNote=$('focus-needs').nextElementSibling;if(checkNote)detailList.lastElementChild.append(checkNote);
  function compact(node,destination,format){let previous;function paint(){const raw=node.textContent;if(raw===previous)return;destination.textContent=raw;const value=format(raw);previous=value;if(raw!==value)node.textContent=value;}paint();new MutationObserver(paint).observe(node,{childList:true});}
  compact($('focus-state'),fullStatus,raw=>raw.startsWith('尚未建立提醒')?'未設提醒':raw==='這個分頁提醒已設定'?'此頁提醒已設':raw==='這個分頁提醒已響過'?'此頁已提醒':raw);
  compact($('focus-needs'),fullNeeds,raw=>{const match=raw.match(/待自查 (\d+) 項/);return match?`${match[1]} 項待核對`:raw.startsWith('自查清單已勾選')?'自查已勾選 · 待平台確認':raw;});
  function updateDate(){stampDate();dateFlag.textContent=$('focus-time').textContent.match(/^\d{4}-\d{2}-\d{2}/)?'自填 · 未核實':'時間未定';}
  updateDate();new MutationObserver(updateDate).observe($('focus-time'),{childList:true});
  document.querySelector('.page-heading h1').textContent='Encore 購票後台';card.after(document.querySelector('.view-switch'));
  const story=document.createElement('details'),summary=document.createElement('summary'),text=document.createElement('p'),link=document.createElement('a');
  story.id='design-story';story.className='reading-details design-story';summary.textContent='海報背後的故事';
  text.textContent='1955 年 Saul Bass 為《The Man with the Golden Arm》設計海報，並與作曲家 Elmer Bernstein 依音樂節拍構思片頭。Encore 借用「以視覺安排節奏」的想法，把開賣、提醒與入場準備排清楚；圖形為本案原創，非藝術家背書。';
  link.href='https://www.moma.org/collection/works/5665';link.target='_blank';link.rel='noopener noreferrer';link.textContent='MoMA：1955 年海報 ↗';
  const musicLink=document.createElement('a');musicLink.href='https://www.moma.org/collection/works/185648';musicLink.target='_blank';musicLink.rel='noopener noreferrer';musicLink.textContent='MoMA：音樂與片頭的合作 ↗';story.append(summary,text,link,musicLink);$('appearance').before(story);
}

function installEmptyLineup(datePanel) {
  if (!$('selected-events')) return;
  const references=$('selected-events'),lineup=document.createElement('section'),heading=document.createElement('h3'),note=document.createElement('p'),list=document.createElement('div'),stamp=document.createElement('p');
  const cards=[...references.querySelectorAll('.selected-event')],capText=references.querySelector('.selected-context p').textContent.match(/NT\$\s*([\d,]+)/)?.[1],cap=capText?Number(capText.replaceAll(',','')):NaN;
  const allOver=cards.length&&cards.every(item=>Number(item.querySelector('[data-reference-price]').firstChild.textContent.replace(/[^\d]/g,''))>cap),years=[...new Set(cards.map(item=>item.querySelector('.selected-sale time').dateTime.slice(0,4)))].join('/');
  lineup.className='empty-lineup';lineup.setAttribute('aria-labelledby','lineup-title');heading.id='lineup-title';heading.textContent=`已選 ${cards.length} 場 · 開賣`;
  note.className='lineup-note';note.textContent=allOver?`${years} 開賣 · 皆超過每張 NT$${capText}`:`${years} 開賣 · 查看票價與限制`;list.className='lineup-choices';stamp.className='lineup-stamp';
  const verified=references.querySelector('.selected-context time');stamp.textContent=`公告快照 ${verified.textContent} · 未排提醒`;
  lineup.append(heading,note,list,stamp);datePanel.after(lineup);
  const toolbar=document.createElement('div'),back=document.createElement('button');toolbar.className='lineup-return';toolbar.hidden=true;back.type='button';back.id='lineup-return';back.className='button secondary';back.textContent='返回比較';toolbar.append(back);references.querySelector('summary').after(toolbar);
  let origin=null;
  function returnToComparison(){
    const target=origin;origin=null;references.open=false;toolbar.hidden=true;
    if(target?.getClientRects().length) {target.focus({preventScroll:true});target.scrollIntoView({block:'center',behavior:'instant'});}
    else focusControl($('focus-edit').disabled?'focus-view':'focus-edit');
  }
  back.addEventListener('click',returnToComparison);
  references.addEventListener('keydown',event=>{if(event.key==='Escape'&&origin){event.preventDefault();event.stopPropagation();returnToComparison();}});
  references.addEventListener('toggle',()=>{if(!references.open){toolbar.hidden=true;origin=null;}});
  for(const reference of cards){
    reference.id='reference-'+reference.querySelector('h3').id;reference.tabIndex=-1;
    const choice=document.createElement('button'),sale=document.createElement('time'),name=document.createElement('strong'),facts=document.createElement('span'),text=document.createElement('span'),arrow=document.createElement('span');
    const sourceTime=reference.querySelector('.selected-sale time'),title=reference.querySelector('h3').firstChild.textContent.trim(),price=reference.querySelector('[data-reference-price]').firstChild.textContent.trim(),limit=reference.querySelector('[data-reference-limit]').textContent;
    choice.type='button';choice.className='lineup-choice';choice.dataset.reference=reference.id;
    choice.setAttribute('aria-label',`${title}，公開開賣 ${sourceTime.dateTime.slice(0,10)} ${sourceTime.dateTime.slice(11,16)}；查看票價與限制`);
    sale.dateTime=sourceTime.dateTime;sale.className='lineup-sale';
    const day=document.createElement('strong'),month=document.createElement('span'),hour=document.createElement('span');day.className='lineup-day';day.textContent=sourceTime.dateTime.slice(8,10);month.className='lineup-month';month.textContent=sourceTime.dateTime.slice(5,7)+'月';hour.className='lineup-hour';hour.textContent=sourceTime.dateTime.slice(11,16);sale.append(month,day,hour);name.textContent=title;
    facts.textContent=`${price} · ${limit.includes('每會員每帳戶 1 張')?'帳戶限1張':limit.includes('每筆最多 4 張')?'每筆最多4張':limit}`;
    text.className='lineup-name';text.append(name,facts);arrow.textContent='›';arrow.className='lineup-view';arrow.setAttribute('aria-hidden','true');choice.append(sale,text,arrow);list.append(choice);
    choice.addEventListener('click',()=>{origin=choice;references.open=true;toolbar.hidden=false;reference.focus({preventScroll:true});reference.scrollIntoView({block:'start',behavior:'instant'});});
  }
}

// Ephemeral, explicit user-write clipboard helper. Never reads clipboard or saves contact fields.
function installFillSheet(){
  const sheet=$('fill-sheet'),result=$('fill-result'),fallback=$('fill-fallback'),manual=$('fill-manual');
  let busy=false,revision=0,lastView='',copySerial=0;
  const identity=()=>JSON.stringify([mode,platform,$('event-title').value.trim(),$('event-url').value.trim()]);let contactIdentity=identity();
  const contact={name:$('fill-name'),email:$('fill-email'),phone:$('fill-phone')};
  function copyLabel(button){return button.dataset.copyPlan?'複製':{name:'複製姓名',email:'複製 Email',phone:'複製電話'}[button.dataset.copyContact];}
  function invalidate(){revision++;result.textContent='';fallback.hidden=true;manual.value='';if(!busy)for(const button of controls()){const text=copyLabel(button);if(text){button.textContent=text;button.removeAttribute('data-copy-done');}}}
  function controls(){return [...sheet.querySelectorAll('[data-copy-contact],[data-copy-plan],#fill-clear')];}
  function render(){
    if(!sheet.open)return;
    const signature=JSON.stringify([mode,rawPlan()]);if(signature===lastView)return;lastView=signature;
    $('fill-context').textContent=mode==='mock'?'離線演練 · 合成計畫':'購票準備 · 目前草稿，非官方票券';
    const input=rawPlan(),route=fillingRoute(platform),rows=$('fill-plan-rows'),references=$('fill-reference-rows');rows.replaceChildren();references.replaceChildren();
    const stages=route.stages.map(text=>{const item=document.createElement('li');item.textContent=text;return item;});$('fill-platform-order').replaceChildren(...stages);
    $('fill-platform-note').textContent=route.note;$('fill-platform-source').href=route.source;$('fill-platform-source').textContent=route.sourceLabel;
    if(route.contactFirst)rows.before($('fill-contact'));else $('fill-plan-reference').after($('fill-contact'));
    const labels={title:'活動',session:'場次',area:'票區',quantity:'張數',maxPrice:'每張上限'};
    for(const key of [...route.planOrder,...route.referenceOrder]){const label=labels[key],value=String(input[key]??'');
      const row=document.createElement('div'),content=document.createElement('div'),name=document.createElement('span'),text=document.createElement('strong'),button=document.createElement('button');
      row.className='fill-row';content.className='fill-value';name.textContent=key==='maxPrice'?'每張上限（非票價）':label;text.textContent=value||'未填';button.type='button';button.className='button secondary';button.dataset.copyPlan=key;button.textContent='複製';button.setAttribute('aria-label',`複製${label}`);button.disabled=busy||!value;
      button.addEventListener('click',()=>copy(String(rawPlan()[key]??''),label,button));content.append(name,text);row.append(content,button);(route.referenceOrder.includes(key)?references:rows).append(row);
    }
  }
  async function copy(value,label,button){
    if(busy)return;
    invalidate();
    if(!value.trim()){result.textContent=`請先填寫${label}。`;return;}
    if(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value)){result.textContent='內容含控制字元，請移除後再複製。';return;}
    if(button.dataset.copyContact==='email'&&!contact.email.validity.valid){result.textContent='Email 格式待修正。';contact.email.focus();return;}
    const version=revision,serial=++copySerial;let copied=false;busy=true;sheet.setAttribute('aria-busy','true');$('fill-cancel').hidden=false;controls().forEach(b=>b.disabled=true);button.textContent='複製中…';result.textContent='正在複製…';
    try{
      if(!navigator.clipboard?.writeText)throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(value);
      if(serial!==copySerial)return;
      copied=true;
      result.textContent=version===revision?`${label}已複製；請到官方頁貼上並核對。`:'舊值已複製；本頁內容已變更，請重新核對。';
    }catch{
      if(serial!==copySerial)return;
      if(version===revision){manual.value=value;fallback.hidden=false;result.textContent='複製未完成，請手動選取複製。';manual.focus();manual.select();}
      else result.textContent='複製未完成；內容已變更，請重試。';
    }finally{if(serial===copySerial){busy=false;sheet.removeAttribute('aria-busy');$('fill-cancel').hidden=true;controls().forEach(b=>b.disabled=Boolean(b.dataset.copyPlan&&!String(rawPlan()[b.dataset.copyPlan]??'')));button.textContent=copied&&version===revision?'已複製':copyLabel(button);if(copied&&version===revision)button.dataset.copyDone='true';render();}}
  }
  for(const [key,input]of Object.entries(contact)){
    input.addEventListener('input',invalidate);
    sheet.querySelector(`[data-copy-contact="${key}"]`).addEventListener('click',event=>copy(input.value,{name:'姓名',email:' Email',phone:'電話'}[key],event.currentTarget));
  }
  function clear(){for(const input of Object.values(contact))input.value='';invalidate();}
  $('fill-clear').addEventListener('click',()=>{clear();result.textContent='本頁聯絡資料已清空；系統剪貼簿不受影響。';contact.name.focus();});
  function abandon(){copySerial++;busy=false;sheet.removeAttribute('aria-busy');$('fill-cancel').hidden=true;lastView='';render();for(const b of controls()){b.disabled=Boolean(b.dataset.copyPlan&&!String(rawPlan()[b.dataset.copyPlan]??''));if(b.dataset.copyContact)b.textContent={name:'複製姓名',email:'複製 Email',phone:'複製電話'}[b.dataset.copyContact];}}
  $('fill-cancel').addEventListener('click',()=>{abandon();invalidate();result.textContent='已停止等待；系統複製仍可能完成，請自行核對。';contact.name.focus();});
  window.addEventListener('pagehide',()=>{abandon();clear();});
  sheet.addEventListener('toggle',render);
  const resetContext=()=>{abandon();clear();contactIdentity=identity();result.textContent='當次聯絡資料已清空；偏好保留，系統剪貼簿不受影響。';};
  document.addEventListener('encore-plan-replaced',resetContext);
  const changed=()=>{if(identity()!==contactIdentity)resetContext();if(JSON.stringify([mode,rawPlan()])!==lastView){invalidate();render();}};
  $('plan-fields').addEventListener('input',changed);$('plan-fields').addEventListener('change',changed);
  document.querySelectorAll('[data-platform]').forEach(button=>button.addEventListener('click',changed));
  document.addEventListener('encore-plan-view',changed);
  document.querySelector('.mode-switch').addEventListener('click',changed);document.querySelector('.mode-switch').addEventListener('keydown',changed);
}
installFillSheet();
function installManualRelay(){
  const relay=new ManualRelay(),panel=$('manual-relay'),main=$('relay-main');let signature='';
  panel.dataset.composition=new URL(location.href).searchParams.get('relay')==='ticket'?'ticket':'poster';
  const phases={
    ready:['準備接力','開始人工接力','只整理步驟；不會替你操作官網。','01'],
    official:['官網操作','我已進入填表','請在官方頁核對活動、場次與限購，再回報下一步。','01'],
    queue:['官網排隊中','我已離開排隊','留在原排隊頁，依官網提示等待；不補跑刷新。','01'],
    verification:['由你完成驗證','我已完成驗證','只在官網正常處理；完成後回到原階段，不代表訂單成功。','↗'],
    form:['逐欄填寫','我已到付款頁','開啟下方小抄複製；回官網貼上，核對票數、資料及實際金額。','02'],
    payment:['付款前核對','我已核對官方結果','付款由你操作；看官方票數、含費總額、截止及訂單結果。','03'],
    reported:['你已回報核對','重新開始接力','工具未核實付款、訂單或票券保留；以官方結果為準。','04'],
    paused:['接力已暫停','核對官網後繼續','先看官網目前階段再繼續；不重播點擊或補跑刷新。','Ⅱ'],
    stopped:['接力已停止','重新開始接力','只停止本頁指引，不會取消官網票券或訂單。','■'],
    stale:['草稿已變更','核對新計畫後開始','原回報已失效；官網狀態未知，請重新核對。','!']
  };
  function render(){
    const state=relay.snapshot(),phase=state.phase,[title,label,note,number]=phases[phase];panel.hidden=mode!=='live';
    const next=JSON.stringify([state,mode]);if(next===signature)return;signature=next;panel.dataset.phase=phase;
    $('relay-title').textContent=title;main.textContent=label;$('relay-note').textContent=note;$('relay-number').textContent=number;
    $('relay-plan').textContent=state.plan?`${platforms[state.plan.platform].short} · ${state.plan.title} · ${state.plan.quantity} 張 · 每張上限 NT$${money(state.plan.maxPrice)}`:'用目前草稿開始；不改已存偏好或提醒。';
    $('relay-pause').hidden=!relay.active||phase==='paused';$('relay-stop').hidden=!relay.active;
    $('relay-verify').hidden=!['official','form','payment'].includes(phase);$('relay-queue').hidden=phase!=='official';
    $('relay-copy').hidden=phase!=='form';
    $('relay-open').hidden=!state.plan||['ready','stale','stopped','reported','paused'].includes(phase);if(state.plan)$('relay-open').href=state.plan.eventUrl;
    const step={ready:0,official:0,queue:0,verification:state.returnTo==='payment'?2:state.returnTo==='form'?1:0,form:1,payment:2,reported:3,paused:state.pausedFrom==='payment'?2:state.pausedFrom==='form'?1:0}[phase];
    panel.querySelectorAll('[data-relay-step]').forEach((node,index)=>{node.setAttribute('aria-current',step===index?'step':'false');});
    const mark=document.createElement('span');mark.className='relay-cut';mark.setAttribute('aria-hidden','true');$('relay-art').replaceChildren(mark);
  }
  main.addEventListener('keydown',event=>{if(event.repeat&&['Enter',' '].includes(event.key))event.preventDefault();});
  main.addEventListener('click',event=>{
    if(event.detail>1)return;
    try{const state=relay.snapshot();if(state.phase==='paused')relay.resume(true);else if(relay.active)relay.advance();else relay.start(checkedPlan());render();main.focus();}
    catch(error){reportPlanError(error,'relay-main');}
  });
  for(const [id,action]of [['relay-pause',()=>relay.pause()],['relay-stop',()=>relay.stop()],['relay-verify',()=>relay.manual('verification')],['relay-queue',()=>relay.manual('queue')]])$(id).addEventListener('click',event=>{if(event.detail>1)return;action();render();main.focus();});
  $('relay-copy').addEventListener('click',()=>{$('fill-sheet').open=true;focusControl('fill-toggle');});
  $('relay-open').addEventListener('click',()=>{$('relay-note').textContent='已提出開啟要求；請自行確認官網是否開啟。此處階段沒有自動改變。';});
  document.addEventListener('encore-plan-view',()=>{if(mode==='live')relay.reconcile(rawPlan());else relay.stop();render();});
  document.addEventListener('encore-plan-replaced',()=>{relay.stop();signature='';render();});
  window.addEventListener('pagehide',()=>{relay.stop();signature='';render();});
  render();
  if(location.hash==='#manual-relay'){setPresentation('workspace',false);switchMode('live');panel.scrollIntoView({block:'start',behavior:'instant'});}
}
installManualRelay();

function installPhasePreparation(){
  const dialog=$('phase-preview');let pending=null,focusAfterApply=null,undo=null,events=null,catalogStatus='loading';
  const normalCopy=[$('phase-preview-title').textContent,$('phase-preview-policy').textContent,$('phase-preview-truth').textContent];
  dialog.addEventListener('close',()=>{if(focusAfterApply){const target=focusAfterApply;focusAfterApply=null;focusControl(target);}});
  const current=()=>JSON.stringify([mode,rawPlan(),drafts.live]);
  const storageStamp=()=>JSON.stringify(readBackupSnapshot(localStorage));
  const updateState=()=>sourceChanges(rawPlan(),events,{status:catalogStatus});
  const display=(value,key)=>{if(value===null||value==='')return '未知／未指定';if(['startsAt','endsAt'].includes(key))return typeof value==='string'&&/Z$/.test(value)&&Number.isFinite(Date.parse(value))?taipeiTime(Date.parse(value)):String(value).slice(0,100)+'（時區／格式待核）';return ({general:'一般開賣',member:'會員預售',card:'卡友預售',registration:'登記／抽選',cancelled:'取消待核',changed:'變更待核',published:'已公告',unknown:'未知',minute:'分鐘'}[value]??String(value)).slice(0,1000);};
  const facts=(target,entries)=>{target.replaceChildren();for(const[label,value]of entries){const a=document.createElement('dt'),b=document.createElement('dd');a.textContent=label;b.textContent=value??'未知';target.append(a,b);}};
  const invalidatePending=reason=>{if(pending?.kind==='source-update'&&dialog.open){pending.invalidated=true;$('phase-preview-confirm').disabled=true;$('phase-preview-error').textContent=reason;}};
  function renderReference(){
    const navigationPlan=mode==='live'?rawPlan():savedLivePlan,review=sourceChanges(navigationPlan,events,{status:catalogStatus});
    let completeNavigation=false;try{validatePlan(navigationPlan,{live:true});completeNavigation=true;}catch{}
    sourceNavigation=completeNavigation&&navigationPlan.origin&&catalogStatus!=='loading'&&(review.changes.length||review.blocked)?{target:review.changes.length&&review.candidate&&catalogStatus==='ready'?'source-update':'phase-reference',label:review.changes.length?'核對來源變更':'來源待核'}:null;
    const state=mode==='live'?sourceReferenceState(rawPlan(),events):null;$('phase-reference').hidden=!state;if(!state)return;
    const r=state.source;
    $('phase-reference-summary').textContent=r.label+' · '+r.eligibility;$('phase-reference-age').textContent=state.ageNote;
    facts($('phase-reference-facts'),[['選定階段／資格',r.label+' · '+r.eligibility],['引用狀態',state.snapshot],...(state.changed.length?[['草稿與原引用不同',state.changed.join('、')+'已修改；原來源 ID 保留，未重新關聯']]:[]),['來源時效',state.ageNote],['公告來源',r.sourceUrl],['原觀測（台灣 UTC+8）',r.observedAt?taipeiTime(Date.parse(r.observedAt)):'未知'],['原公告時間',r.startsAt?taipeiTime(Date.parse(r.startsAt))+' · '+r.precision:'未知；不使用演出日期']]);
    $('source-update').hidden=!review.changes.length;$('source-update').disabled=!review.candidate||catalogStatus!=='ready';$('source-update-status').textContent=review.blocked|| (review.changes.length?review.changes.map(c=>c.label).join('、')+'有差異；尚未改動計畫或提醒。':'來源參考 · 未確認資格或可買');
  }
  $('source-update').addEventListener('click',()=>{
    const review=updateState();if(!review.candidate||!review.changes.length||catalogStatus!=='ready')return;
    pending={kind:'source-update',origin:$('source-update'),before:current(),revision:userRevision,selection:null,signature:review.signature,invalidated:false};
    $('phase-preview-title').textContent='核對來源變更';$('phase-preview-confirm').textContent='採用至草稿';$('phase-preview-cancel').textContent='保留目前草稿';$('phase-preview-policy').textContent='只變更本頁草稿；已存計畫與提醒保留。之後需另按儲存，才會保存；儲存偏好不會建立或恢復提醒。';$('phase-preview-truth').textContent='採用會清空當次自查、聯絡與舊回報。可復原草稿；自查須重核，資格、限購、餘票及付款仍未知。';$('phase-preview-error').textContent='';
    const entries=review.changes.map(c=>[c.label,`原引用：${display(c.before,c.key)}\n本機新公告：${display(c.after,c.key)}`]);
    try{pending.storage=storageStamp();if(review.blocked)throw Error(review.blocked);pending.selection=sourceUpdatePreparation(rawPlan(),review.candidate.event,review.candidate.phase);const next=pending.selection.plan;
      entries.push(['採用後草稿',`${platforms[next.platform].short} · ${next.saleAt?next.saleAt.replace('T',' ')+'（台灣）':'無提醒時間'}\n${next.quantity} 張 · 每張上限 NT$${money(next.maxPrice)} · 票區 ${next.area||'未指定'}`]);
      if(rawPlan().saleAt!==next.saleAt)entries.push(['目前草稿時間',rawPlan().saleAt||'未填寫']);
      entries.push(['目前提醒',reminder?`${({armed:'仍用原設定',cancelled:'已取消，不恢復',fired:'已完成，不重播',missed:'已錯過，不補發'}[reminder.status]??'待核')} · ${reminder.plan.saleAt.replace('T',' ')}（台灣）`:'未建立；此步不新增']);
    }catch(error){$('phase-preview-error').textContent=error.message;}
    facts($('phase-preview-facts'),entries);$('phase-preview-confirm').disabled=!pending.selection;if(!dialog.open)dialog.showModal();$('phase-preview-cancel').focus();
  });
  document.addEventListener('encore-phase-preview',event=>{
    $('phase-preview-title').textContent=normalCopy[0];$('phase-preview-policy').textContent=normalCopy[1];$('phase-preview-truth').textContent=normalCopy[2];$('phase-preview-confirm').textContent='確認帶入草稿';$('phase-preview-cancel').textContent='取消，保留原稿';
    const {event:source,phase,origin}=event.detail;pending={origin,before:current(),revision:userRevision,selection:null};$('phase-preview-error').textContent='';
    try{pending.selection=phasePreparation(source,phase,mode==='live'?rawPlan():drafts.live);const {plan,reference:r}=pending.selection;
      facts($('phase-preview-facts'),[['活動',plan.title],['平台／官方入口',platforms[plan.platform].short+' · '+plan.eventUrl],['階段／資格',r.label+' · '+r.eligibility],['開賣時間（台灣 UTC+8）',plan.saleAt||'待核，不帶入'],['場次',r.sessionNote],['時間判斷',r.timeNote],['保留張數／每張上限',`${plan.quantity} 張 · NT$${money(plan.maxPrice)}`],['公告來源',r.sourceUrl],['來源抓取',r.fetchedAt]]);
    }catch(error){$('phase-preview-facts').replaceChildren();$('phase-preview-error').textContent=error.message;}
    $('phase-preview-confirm').disabled=!pending.selection;if(!dialog.open)dialog.showModal();$('phase-preview-cancel').focus();
  });
  const cancel=()=>{const origin=pending?.origin;pending=null;dialog.close();if(origin?.isConnected)origin.focus();else focusControl('sale-search');};
  $('phase-preview-cancel').addEventListener('click',cancel);dialog.addEventListener('cancel',event=>{event.preventDefault();cancel();});
  $('phase-preview-confirm').addEventListener('click',()=>{
    if(!pending?.selection)return;
    const updating=pending.kind==='source-update';
    if(updating){try{const latest=updateState();if(pending.invalidated||pending.storage!==storageStamp()||latest.blocked||latest.signature!==pending.signature){invalidatePending('來源或其他分頁資料已變更，未採用；請保留目前內容，取消後重新核對。');return;}}catch{invalidatePending('無法核對已存資料，未採用；請先恢復儲存後重新核對。');return;}}
    if(pending.before!==current()||pending.revision!==userRevision||clearing||restoring||uncertainStorage()){$('phase-preview-error').textContent='草稿已變更或資料處理未完成，未套用；請取消後重新預覽。';$('phase-preview-confirm').disabled=true;return;}
    const selected=pending.selection,store=pending.storage,before={mode,raw:structuredClone(rawPlan()),live:structuredClone(drafts.live),saveGuard:sourceSaveGuard};markUserChange();pending=null;focusAfterApply=updating?'save-button':'relay-main';dialog.close();switchMode('live');if(updating)document.querySelectorAll('#live-checklist input').forEach(input=>{input.checked=false;});drafts.live=selected.plan;writePlan(selected.plan);if(updating)sourceSaveGuard={text:JSON.parse(store)[storageKey]};activePlan=null;undo={before,after:current(),store:updating?store:null};$('phase-undo').hidden=false;
    $('open-event').hidden=true;$('open-event').removeAttribute('href');renderReference();
    setPresentation('workspace',false);message(updating?'已採用至草稿，自查需重核；已存計畫與提醒未變。可另按儲存偏好；此步未恢復取消提醒。':'已帶入未儲存草稿；聯絡資料已清空。未設提醒、未啟動接力或購票。');focusControl(updating?'save-button':'relay-main');
  });
  document.addEventListener('encore-plan-view',renderReference);
  document.addEventListener('encore-plan-replaced',renderReference);
  document.addEventListener('encore-source-snapshot',event=>{events=event.detail.events;catalogStatus='ready';if(pending?.kind==='source-update'&&pending.signature!==updateState().signature)invalidatePending('來源又有變更，未採用；請取消後重新核對。');renderFocus();});
  document.addEventListener('encore-source-state',event=>{catalogStatus=event.detail.status;if(catalogStatus!=='ready')invalidatePending('來源讀取狀態已改變，未採用；請取消後重新核對。');renderFocus();});
  window.addEventListener('storage',event=>{if([storageKey,reminderKey,null].includes(event.key))invalidatePending('其他分頁資料已變更，未採用；請取消後重新核對。');});
  $('phase-undo').addEventListener('click',()=>{if(!undo)return;let staleStorage=false;try{staleStorage=undo.store!==null&&undo.store!==storageStamp();}catch{staleStorage=true;}if(undo.after!==current()||staleStorage||clearing||restoring||uncertainStorage()){message('草稿已再修改、其他分頁變更或資料處理未完成，未用舊稿覆蓋；請保留目前內容。',true);return;}const old=undo.before;markUserChange();undo=null;$('phase-undo').hidden=true;switchMode(old.mode);drafts.live=old.live;drafts[old.mode]=old.raw;writePlan(old.raw);sourceSaveGuard=old.saveGuard??null;message('已復原帶入前草稿；聯絡資料與舊回報不復原。');focusControl('event-title');});
  renderReference();
}
installPhasePreparation();
// Keep preparation first; discovery remains one explicit jump away, without a new mode.
document.querySelector('.page-heading').after($('focus-card'));
$('focus-card').after(document.querySelector('.view-switch'));
document.querySelector('.dashboard-grid').after($('sale-tracker'));

// Dynamic import keeps the existing workspace usable until its server is upgraded.
import('./sale-tracker.mjs').then(module=>module.installSaleTracker()).catch(()=>{ $('sale-message').textContent='網站模組未載入，請重新整理；偏好與提醒不受影響。'; $('sale-message').classList.add('error'); $('sale-reload').disabled=true; $('sale-reload').title='目前服務尚未載入新版追蹤模組'; });
