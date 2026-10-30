// Only public announcement provenance. Never contacts, browser state or user reports.
const selectionKeys=['platform','title','eventUrl','session','saleAt'];
const keys=['schemaVersion','eventId','phaseId','sourceIdentities','label','kind','eligibility','sourceUrl','observedAt','startsAt','endsAt','timeZone','precision','status','selection'];
function exact(value,names){if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==names.length||names.some(key=>!Object.hasOwn(value,key)))throw Error('來源引用欄位不完整或含不支援的資料');}
function text(value,max){if(typeof value!=='string'||!value.trim()||value.length>max||/[\u0000-\u001f\u007f-\u009f\u061c\u200b\u200e\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/u.test(value))throw Error('來源引用文字格式不正確');return value;}
function instant(value){if(value===null)return null;if(typeof value!=='string'||value.length>30||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)||!Number.isFinite(Date.parse(value))||new Date(value).toISOString().replace('.000Z','Z')!==value.replace('.000Z','Z'))throw Error('來源觀測時間格式不正確');return value;}
const observedStatus=(event,phase)=>event.status==='cancelled'?'cancelled':phase.status??'unknown';
function sameInstant(left,right){if(left===right)return true;try{return instant(left)!==null&&instant(right)!==null&&Date.parse(left)===Date.parse(right);}catch{return false;}}
export function validatePlanSource(value){
 exact(value,Object.hasOwn(value??{},'sourceIdentities')?keys:keys.filter(key=>key!=='sourceIdentities'));if(value.schemaVersion!==1)throw Error('不支援此來源引用版本');
 if(value.timeZone!=='Asia/Taipei')throw Error('來源引用時區不正確');
 const result={schemaVersion:1,eventId:text(value.eventId,200),phaseId:text(value.phaseId,200),label:text(value.label,200),kind:text(value.kind,40),eligibility:text(value.eligibility,1000),sourceUrl:text(value.sourceUrl,2048),observedAt:instant(value.observedAt),startsAt:instant(value.startsAt),endsAt:instant(value.endsAt),timeZone:'Asia/Taipei',precision:text(value.precision,40),status:text(value.status,40)};
 const identities=Object.hasOwn(value,'sourceIdentities')?value.sourceIdentities:[];
 if(!Array.isArray(identities)||identities.length>50)throw Error('來源識別格式不正確');
 result.sourceIdentities=identities.map(identity=>{exact(identity,['recordId','phaseId']);return {recordId:text(identity.recordId,200),phaseId:text(identity.phaseId,200)};});
 if(new Set(result.sourceIdentities.map(x=>JSON.stringify(x))).size!==result.sourceIdentities.length)throw Error('來源識別重複');
 const url=new URL(result.sourceUrl),host=url.hostname;
 const official=['tixcraft.com','kktix.com','www.livenation.com.tw','livenation.com.tw','www.opentix.life','www.arena.taipei','www.farglorydome.com.tw'];
 if(url.protocol!=='https:'||url.username||url.password||url.port||url.search||url.hash||/[^\x21-\x7e]|\\/u.test(result.sourceUrl)||!(official.includes(host)||/^[a-z0-9-]+\.kktix\.cc$/.test(host)))throw Error('來源引用須為支援的公開官方 HTTPS 公告，不可含查詢或登入資料');
 exact(value.selection,selectionKeys);result.selection={};
 for(const key of selectionKeys){const v=value.selection[key];if(typeof v!=='string'||v.length>({title:100,eventUrl:2048,session:80,saleAt:16}[key]??20)||/[\u0000-\u001f\u007f-\u009f\u061c\u200b\u200e\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/u.test(v))throw Error('來源選定內容格式不正確');result.selection[key]=v;}
 if(!['tixcraft','kktix'].includes(result.selection.platform))throw Error('來源選定平台不正確');
 if(!result.selection.title.trim()||/[^\x21-\x7e]|\\/u.test(result.selection.eventUrl))throw Error('來源選定活動格式不正確');
 const selectedTime=result.selection.saleAt;if(selectedTime&&(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(selectedTime)||!Number.isFinite(Date.parse(selectedTime+':00+08:00'))||new Date(Date.parse(selectedTime+':00+08:00')+8*3600000).toISOString().slice(0,16)!==selectedTime))throw Error('來源選定時間不正確');
 const entry=new URL(result.selection.eventUrl),p=result.selection.platform;
 if(entry.protocol!=='https:'||entry.username||entry.password||entry.port||entry.search||entry.hash||!(p==='tixcraft'?entry.hostname==='tixcraft.com'&&/^\/activity\/detail\/[\w-]+\/?$/.test(entry.pathname):(entry.hostname==='kktix.com'||/^[a-z0-9-]+\.kktix\.cc$/.test(entry.hostname))&&/^\/events\/[\w-]+\/?$/.test(entry.pathname)))throw Error('來源選定活動入口不正確');
 return result;
}
export function makePlanSource(event,phase,plan){
 for(const value of phase.appliesToSessions??[])if(instant(value)===null)throw Error('來源場次時間未知');
 const identities=(phase.sourceClaims??[]).filter(c=>typeof c.sourceRecordId==='string'&&typeof c.sourcePhaseId==='string').map(c=>({recordId:c.sourceRecordId,phaseId:c.sourcePhaseId}));
 const sourceIdentities=[...new Map(identities.map(i=>[JSON.stringify(i),i])).values()];
 return validatePlanSource({schemaVersion:1,eventId:event.id,phaseId:phase.id,sourceIdentities,label:phase.label,kind:phase.kind,eligibility:phase.eligibility||'未知',sourceUrl:phase.sourceUrl,observedAt:phase.fetchedAt??null,startsAt:phase.startsAt??null,endsAt:phase.endsAt??null,timeZone:'Asia/Taipei',precision:phase.precision??'unknown',status:observedStatus(event,phase),selection:Object.fromEntries(selectionKeys.map(key=>[key,plan[key]]))});
}
export function sourceReferenceState(plan,events=null,now=Date.now()){
 const source=plan?.origin;if(!source)return null;
 const changed=selectionKeys.filter(key=>source.selection[key]!==String(plan[key]??''));
 const labels={platform:'平台',title:'活動',eventUrl:'網址',session:'場次',saleAt:'開賣時間'};
 let snapshot='上次選定的公開來源；不是目前可買狀態';
 if(events){const event=events.find(e=>e.id===source.eventId),phase=event?.sale_phases?.find(p=>p.id===source.phaseId);
  if(!phase)snapshot='目前本機快照找不到此階段；保留原引用，請人工核對';
  else if(event.title!==source.selection.title||['label','kind','sourceUrl','precision'].some(k=>(phase[k]??'unknown')!==source[k])||(phase.eligibility||'未知')!==source.eligibility||!sameInstant(phase.startsAt??null,source.startsAt)||!sameInstant(phase.endsAt??null,source.endsAt)||observedStatus(event,phase)!==source.status||phase.stale||event.stale)snapshot='本機公告內容已變更或過期；保留原引用，未自動改寫計畫';
 }
 const age=source.observedAt?now-Date.parse(source.observedAt):null;
 if(source.endsAt&&Date.parse(source.endsAt)<=now)snapshot+='；原公告截止時間已過';
 return {source,changed:changed.map(k=>labels[k]),snapshot,ageNote:age===null?'原觀測時間未知':age<0?'原觀測時間晚於本機時鐘，請核對':age>86400000?'原觀測已超過 24 小時；尚未重新核實':'原觀測時間僅供追溯；不是即時查詢'};
}
export function preferencesRecord(preferences){return {...(preferences.mock?.origin||preferences.live?.origin?{schemaVersion:2}:{}),...preferences};}

function activityEntry(value){try{const u=new URL(value);if(typeof value!=='string'||/[^\x21-\x7e]|\\/u.test(value)||u.protocol!=='https:'||u.username||u.password||u.port||u.search||u.hash)return null;if(u.hostname==='tixcraft.com'&&/^\/activity\/detail\/[\w-]+\/?$/.test(u.pathname)||(u.hostname==='kktix.com'||/^[a-z0-9-]+\.kktix\.cc$/.test(u.hostname))&&/^\/events\/[\w-]+\/?$/.test(u.pathname))return u.href;}catch{}return null;}
// Compares the saved observation to the same local phase. Does not fetch or mutate.
export function sourceChanges(plan,events,{status='ready'}={}){
 const source=plan?.origin;if(!source)return {changes:[],candidate:null,blocked:'此計畫沒有來源引用'};
 const matches=events?.filter(e=>e.id===source.eventId)??[],event=matches.length===1?matches[0]:null,phases=event?.sale_phases?.filter(p=>p.id===source.phaseId)??[],phase=phases.length===1?phases[0]:null;
 const result={changes:[],candidate:event&&phase?{event,phase}:null,blocked:'',signature:event&&phase?JSON.stringify([event.id,event.title,phase]):null};
 const block=reason=>{if(!result.blocked)result.blocked=reason;};
 if(status==='loading')block('正在讀取本機快照，暫不採用');else if(status==='failed')block('本機快照讀取失敗；原計畫保留，請重新讀取');
 if(!events)block('本機快照尚未載入');else if(matches.length>1||phases.length>1)block('來源識別不唯一，請人工核對');else if(!phase)block('目前快照找不到原階段；不刪除計畫或猜新時間');
 if(!phase)return result;
 const compare=(key,label,before,after)=>{if(['startsAt','endsAt'].includes(key)?!sameInstant(before??null,after??null):(before??null)!==(after??null))result.changes.push({key,label,before:before??null,after:after??null});};
 for(const [key,label]of [['label','階段'],['kind','售票類型'],['eligibility','資格'],['sourceUrl','公告來源'],['startsAt','公告開始'],['endsAt','公告截止'],['precision','時間精度'],['status','公告狀態']])compare(key,label,source[key],key==='status'?observedStatus(event,phase):phase[key]??({eligibility:'未知',precision:'unknown'}[key]??null));
 compare('title','活動名稱',source.selection.title,event.title);
 const entries=[...new Set([phase.sourceUrl,...(phase.sourceClaims??[]).map(c=>c.sourceUrl)].map(activityEntry).filter(Boolean))];
 if(entries.length!==1)block(entries.length?'新來源有多個活動入口，請人工核對':'新來源沒有可核實的拓元／KKTIX活動入口');
 compare('eventUrl','活動入口',source.selection.eventUrl,entries.length===1?entries[0]:entries.length?'多個入口待核':'支援入口待核');
 const sessions=[...new Set(phase.appliesToSessions??[])],session=sessions.length===1&&Number.isFinite(Date.parse(sessions[0]))?new Date(Date.parse(sessions[0])+8*3600000).toISOString().slice(0,16):'';compare('session','適用場次',source.selection.session,session);
 try{instant(phase.fetchedAt);if(!phase.fetchedAt)block('新來源觀測時間未知，暫不採用');else if(source.observedAt&&Date.parse(phase.fetchedAt)<Date.parse(source.observedAt))block('收到較舊的來源觀測，不能覆蓋原引用');}catch{block('新來源觀測時間格式不正確');}
 if(event.stale||phase.stale)block('新來源仍是舊快照，請人工核對');
 if(event.status==='needs_review'||phase.status==='needs_review')block('新來源仍待核對，暫不採用');
 return result;
}
