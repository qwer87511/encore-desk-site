const hosts=new Set(['tixcraft.com','www.livenation.com.tw','www.opentix.life','www.farglorydome.com.tw','www.cpbl.com.tw','www.wdragons.com','kktix.com']);
const safe=value=>{try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&hosts.has(u.hostname)&&!/(?:\/ticket\/|\/activity\/(?:game|search-suggest)\/|\/login|\/account)/i.test(decodeURIComponent(u.pathname));}catch{return false;}};
const stamp=value=>value===null||typeof value==='string'&&Number.isFinite(Date.parse(value));
const observed=value=>typeof value==='string'&&Number.isFinite(Date.parse(value));
function require(condition){if(!condition)throw Error('Invalid read-only calendar contract');}

// Announcement-time classification only; never live availability, payment or hold state.
export function salePhaseTimeState(phase,now=Date.now()){
 const start=phase.startsAt==null?null:Date.parse(phase.startsAt),end=phase.endsAt==null?null:Date.parse(phase.endsAt);
 if(!Number.isFinite(now)||start!==null&&!Number.isFinite(start)||end!==null&&!Number.isFinite(end)||start!==null&&end!==null&&end<=start||start!==null&&phase.precision==='unknown')return 'needs-review';
 if(phase.kind==='cancelled')return 'cancelled';
 if(phase.status==='needs_review')return 'needs-review';
 if(start===null)return 'unknown';
 if(end!==null&&now>=end)return 'ended';
 if(now<start)return 'upcoming';
 return end===null?'started-unknown-end':'within-window';
}
export const salePhaseTimeLabels={upcoming:'未到時間','within-window':'公告期間內',ended:'公告已截止','started-unknown-end':'截止待核',unknown:'時間待核','needs-review':'時間／精度待核',cancelled:'取消待核'};
export function summarizeSaleCoverage(events,now=Date.now()){
 const counts={rows:0,future:0,started:0,unknown:0,ended:0};
 for(const event of events)for(const phase of event.sale_phases){counts.rows++;const state=salePhaseTimeState(phase,now);if(state==='upcoming')counts.future++;else if(['within-window','started-unknown-end','ended'].includes(state)){counts.started++;if(state==='ended')counts.ended++;}else counts.unknown++;}
 return counts;
}

// Reference consumer: transforms only public announcement fields, never user plans or reminders.
export function saleCalendarView(calendar){
 require(calendar?.contract==='encore.sale-calendar'&&calendar.contractVersion===1&&calendar.timezone==='Asia/Taipei');
 require(calendar.capabilities?.readOnly===true&&['purchase','inventory','notifications','consumerMayFetchSources','continuousUpdatesGuaranteed'].every(key=>calendar.capabilities[key]===false));
 require(calendar.snapshot?.complete===false&&observed(calendar.snapshot.generatedAt)&&Array.isArray(calendar.events)&&calendar.events.length<=2000&&calendar.coverage?.complete===false&&Array.isArray(calendar.coverage.sources));
 const events=calendar.events.map(event=>{
  require(typeof event.title==='string'&&event.title.length<=300&&Array.isArray(event.sources)&&event.sources.length>0&&event.sources.every(s=>safe(s.url)&&observed(s.fetchedAt))&&Array.isArray(event.salePhases)&&event.salePhases.length<=1000&&Array.isArray(event.unresolvedEvidence));
  const claims=[...event.unresolvedEvidence,...event.salePhases.flatMap(p=>p.claims??[])];
  require(claims.length<=1000&&claims.every(c=>typeof c.evidenceText==='string'&&c.evidenceText.length<=500&&safe(c.sourceUrl)&&observed(c.fetchedAt)&&event.sources.some(s=>s.recordId===c.sourceRecordId&&s.url===c.sourceUrl)));
  const primary=event.sources[0],common={id:event.id,title:event.title,category:event.category,venue:event.venue,venueTag:event.venueTag,sourceId:primary.sourceId,sourceUrl:primary.url,eventAt:primary.eventAt,eventDateText:primary.eventDateText,stale:event.status==='stale',status:event.status,sourceCount:event.sources.length,sourceRecords:event.sources,identitySummary:event.identity?.decision==='evidence-merged'?'活動已比對；場次仍依各來源證據':'單一來源活動',unresolvedCount:event.unresolvedEvidence.length};
  const sale_phases=event.salePhases.map(phase=>{require(stamp(phase.startsAt)&&stamp(phase.endsAt)&&typeof phase.label==='string'&&Array.isArray(phase.claims)&&phase.claims.length>0);const first=phase.claims[0];return {...phase,sourceUrl:first.sourceUrl,evidenceText:first.evidenceText,fetchedAt:first.fetchedAt,sourceClaims:phase.claims,sourceIds:[...new Set(phase.claims.map(c=>event.sources.find(s=>s.recordId===c.sourceRecordId).sourceId))],appliesToSessions:[...new Set(phase.claims.flatMap(c=>c.appliesToSessionStartsAt))],previousStartsAt:first.previousStartsAt};});
  if(!sale_phases.length){require(event.unresolvedEvidence.length>0);const first=event.unresolvedEvidence[0];sale_phases.push({id:event.id+'-unresolved',kind:'announced',unresolvedPlaceholder:true,label:'開賣時間待核實',startsAt:null,endsAt:null,eligibility:'資格未核實',appliesToSessions:[],sourceUrl:first.sourceUrl,evidenceText:first.evidenceText,fetchedAt:first.fetchedAt,status:'unknown',sourceClaims:event.unresolvedEvidence,sourceIds:[...new Set(event.sources.map(s=>s.sourceId))]});}
  return {...common,sale_phases};
 });
 return {schemaVersion:1,viewKind:'calendar',generatedAt:calendar.snapshot.generatedAt,sources:calendar.coverage.sources,events,sourceRecordCount:calendar.coverage.sourceRecordCount,reviewPairCount:calendar.identityDecisions.filter(d=>d.outcome==='review').length,sourceSnapshotHash:calendar.snapshot.sourceSnapshotHash};
}
