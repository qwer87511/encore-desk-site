import { fixture, validatePlan, selectTicket, samePreparation } from './adapters.mjs';

// Local user-reported guide only. No browser, timers, refresh, inventory or order actions.
export class ManualRelay {
  constructor(){this.state={phase:'ready',plan:null,returnTo:null};}
  snapshot(){return structuredClone(this.state);}
  get active(){return ['official','queue','verification','form','payment','paused'].includes(this.state.phase);}
  start(input){if(this.active)return false;this.state={phase:'official',plan:validatePlan(input,{live:true}),returnTo:null};return true;}
  advance(){
    const next={official:'form',queue:'official',form:'payment',payment:'reported'}[this.state.phase];
    if(this.state.phase==='verification'){this.state={...this.state,phase:this.state.returnTo,returnTo:null};return true;}
    if(!next)return false;this.state={...this.state,phase:next,returnTo:null};return true;
  }
  manual(phase){
    if(phase==='queue'&&this.state.phase==='official'){this.state={...this.state,phase:'queue',returnTo:'official'};return true;}
    if(phase==='verification'&&['official','form','payment'].includes(this.state.phase)){this.state={...this.state,phase,returnTo:this.state.phase};return true;}
    return false;
  }
  pause(){if(!this.active||this.state.phase==='paused')return false;this.state={...this.state,pausedFrom:this.state.phase,phase:'paused'};return true;}
  resume(confirmed=false){if(this.state.phase!=='paused'||confirmed!==true)return false;const {pausedFrom,...rest}=this.state;this.state={...rest,phase:pausedFrom};return true;}
  stop(){if(['ready','stopped','stale'].includes(this.state.phase))return false;this.state={...this.state,phase:'stopped',returnTo:null};return true;}
  reconcile(input){
    if(!this.state.plan||['ready','stopped','stale'].includes(this.state.phase))return false;
    let same=false;try{same=samePreparation(validatePlan(input,{live:true}),this.state.plan);}catch{/* Invalid draft also invalidates the old report. */}
    if(same)return false;this.state={...this.state,phase:'stale',returnTo:null};return true;
  }
}

// A display-only synthetic comparison. Never derives reservation from a payment page.
export function paymentHandoffDemo(selected, input, { variant = 'unknown', anchor, now = Date.now() } = {}) {
  const plan = validatePlan(input);
  if (!['unknown', 'held', 'expired', 'paid'].includes(variant) || !Number.isSafeInteger(anchor) || Math.abs(anchor) > 8640000000000000 - 600000 || !Number.isSafeInteger(now) || Math.abs(now) > 8640000000000000
    || !selected || !Number.isSafeInteger(selected.price) || selected.price < 1 || selected.price > 100000) throw new Error('交接示範資料無效');
  const deadline = variant === 'unknown' ? null : anchor + (variant === 'expired' ? -1 : 10 * 60000);
  const payment = variant === 'paid' ? 'paid' : variant === 'unknown' ? 'unknown' : 'pending';
  const reservation = ['held', 'expired'].includes(variant) ? now >= deadline ? 'expired' : 'held' : 'unknown';
  const phase = payment === 'paid' ? 'paid' : reservation;
  const fees = variant === 'unknown' ? null : 100;
  const subtotal = selected.price * plan.quantity;
  return { synthetic: true, phase, reservation, payment, quantity: plan.quantity, unitPrice: selected.price, subtotal, fees,
    total: fees === null ? null : subtotal + fees, deadline,
    remainingSeconds: phase === 'held' ? Math.max(0, Math.ceil((deadline - now) / 1000)) : null,
    unitCap: plan.maxPrice, faceValueCap: plan.quantity * plan.maxPrice, inclusiveBudget: null };
}

export function retryDelay(attempt, retryAfter = 0) {
  return Math.max(60000 * 2 ** Math.max(0, Math.min(attempt - 1, 5)), Number.isFinite(retryAfter) ? Math.max(0, retryAfter) * 1000 : 0);
}
export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new DOMException('Stopped', 'AbortError'));
    const abort = () => { clearTimeout(timer); reject(new DOMException('Stopped', 'AbortError')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}
const terminal = new Set(['idle', 'stopped', 'failed', 'completed']);
export class Rehearsal {
  constructor({ onChange = () => {}, wait = sleep, timeScale = 0.025 } = {}) {
    this.onChange = onChange; this.wait = wait; this.timeScale = timeScale; this.serial = 0;
    this.state = { status: 'idle', logs: [], selected: null, retries: 0, mockOrders: 0, runId: 0, detail: '尚未開始演練', pending: null };
  }
  get active() { return !terminal.has(this.state.status); }
  snapshot() { return structuredClone(this.state); }
  emit(status, detail, extra = {}) {
    this.state = { ...this.state, ...extra, status, detail };
    this.state.logs.push({ status, detail, at: new Date().toISOString() });
    this.onChange(this.snapshot());
  }
  async start(input, scenario = 'normal', mode = 'mock') {
    if (mode !== 'mock') throw new Error('自動執行器只可在離線演練使用');
    if (this.active) return false;
    const plan = validatePlan(input), frames = fixture(plan.platform, scenario);
    this.abort?.abort(); this.abort = new AbortController();
    const runId = ++this.serial;
    this.plan = plan; this.frames = frames;
    this.state = { status: 'idle', logs: [], selected: null, retries: 0, mockOrders: 0, runId, detail: '', pending: null };
    this.emit('reading', '演練開始 · 所有資料皆為合成');
    await this.drive(runId, this.abort.signal);
    return true;
  }
  async drive(runId, signal) {
    const current = () => !signal.aborted && this.state.runId === runId;
    try {
      while (this.frames.length && current()) {
        const frame = this.frames.shift();
        if (frame.type === 'unknown') { this.emit('failed', '無法辨識頁面，停止並交由人工檢查'); return; }
        if (frame.type === 'rateLimit' || frame.type === 'timeout') {
          const retries = this.state.retries + 1;
          if (retries > 3) { this.emit('failed', '已達 3 次重試上限，停止演練'); return; }
          const delay = retryDelay(retries, frame.retryAfter);
          this.emit('backoff', `${frame.type === 'rateLimit' ? '模擬 429 限流' : '模擬網路逾時'} · 退避 ${delay / 1000} 秒（僅演練加速）`, { retries, delay });
          await this.wait(delay * this.timeScale, signal);
          continue;
        }
        if (frame.type === 'available') {
          const selected = selectTicket(frame.tickets, this.plan);
          if (!selected) { this.emit('failed', '沒有符合場次、票價及張數的合成票種；未放寬偏好'); return; }
          this.emit('matched', `已匹配 ${selected.session} · ${selected.area}`, { selected });
        } else if (['captcha', 'expired', 'review'].includes(frame.type)) {
          this.emit('handoff', frame.detail, { pending: frame.type }); return;
        } else if (frame.type === 'completed') {
          this.emit('completed', frame.detail, { mockOrders: this.state.mockOrders + 1, pending: null }); return;
        } else this.emit(frame.type, frame.detail);
        await this.wait(650, signal);
      }
    } catch (error) {
      if (current()) this.emit('failed', '演練執行失敗，已停止；請重新開始');
    }
  }
  async confirm() {
    if (this.state.status !== 'handoff' || !this.state.pending) return false;
    const pending = this.state.pending;
    this.emit('resuming', pending === 'review' ? '人工確認完成，僅建立模擬訂單' : '人工接手完成，繼續演練', { pending: null });
    await this.drive(this.state.runId, this.abort.signal);
    return true;
  }
  stop() {
    if (!this.active) return false;
    this.abort.abort(); this.frames = [];
    this.emit('stopped', '已停止；待處理的演練回應已取消', { pending: null }); return true;
  }
}
