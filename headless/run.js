/* RV Terminal · headless runner.
   Boots the SAME rv_terminal.html the browser runs, in Node, with real fetch — then:
   sbPull() (previous state) → refresh() (Stripe) → sbPush() (Supabase) → pushSync() (bridge).
   Nothing is ported or re-implemented: the app's own code does the work, so the numbers cannot
   drift from what the page shows. Secrets come from env; nothing is written to disk.
     STRIPE_KEY     restricted READ-ONLY Stripe key
     SB_EMAIL / SB_PASSWORD   the Supabase login the browser uses (RLS pins rows to this user)
     BIN_ID / BIN_KEY         jsonbin main bundle + master key (bridge publish)
     STRIPE_FAKE=<export.json> dry-run: serve that export's subs as Stripe pages instead of calling Stripe */
const fs=require('fs'), vm=require('vm'), path=require('path');
const HTML=path.join(__dirname,'..','rv_terminal.html');
const html=fs.readFileSync(HTML,'utf8');
const script=(html.match(/<script>([\s\S]*?)<\/script>/g)||[]).map(x=>x.replace(/<\/?script>/g,'')).join('\n');
const realIds=new Set([...html.matchAll(/id="([^"]+)"/g)].map(m=>m[1]));
const E=process.env, need=k=>{ if(!E[k]) { console.error('missing env '+k); process.exit(2); } return E[k]; };
const fake=E.STRIPE_FAKE||null;
const STRIPE_KEY=fake? 'rk_test_fake' : need('STRIPE_KEY');
const SB_EMAIL=need('SB_EMAIL'), SB_PASSWORD=need('SB_PASSWORD'), BIN_ID=need('BIN_ID'), BIN_KEY=need('BIN_KEY');

/* ---- DOM stub (same shape the render harness has proven against the whole app) ---- */
const made={};
function El(id){ this.id=id; this._html=''; this._text=''; this.style={}; this.dataset={}; this.value=''; this.checked=false;
  this.classList={add(){},remove(){},toggle(){},contains(){return false}}; this.children=[]; this.hidden=false; this.disabled=false; }
Object.defineProperty(El.prototype,'innerHTML',{get(){return this._html},set(v){this._html=String(v)}});
Object.defineProperty(El.prototype,'textContent',{get(){return this._text},set(v){this._text=String(v)}});
El.prototype.querySelectorAll=function(){ return []; }; El.prototype.querySelector=function(s){ return new El('q'+s); };
['appendChild','prepend','remove','scrollIntoView','setAttribute','removeAttribute','addEventListener','focus','blur','click','insertAdjacentHTML'].forEach(k=>{ El.prototype[k]=function(){}; });
El.prototype.getAttribute=()=>null; El.prototype.closest=()=>null;
El.prototype.getBoundingClientRect=()=>({width:900,height:400,top:0,left:0,right:900,bottom:400});
El.prototype.getContext=()=>({ createLinearGradient:()=>({addColorStop(){}}), canvas:{width:900,height:400} });
const document={ getElementById(id){ return realIds.has(id)? (made[id]||(made[id]=new El(id))) : null; },
  querySelector(s){ const m=/#([A-Za-z0-9_-]+)/.exec(s); return m? (document.getElementById(m[1])||new El('missing')) : new El('q'); },
  querySelectorAll(){ return []; }, createElement(){ return new El('new'); }, addEventListener(){},
  body:new El('body'), documentElement:new El('html'), head:{appendChild(){}}, title:'', readyState:'complete' };
const mem={};
const localStorage={ getItem:k=>Object.prototype.hasOwnProperty.call(mem,k)? mem[k]:null, setItem:(k,v)=>{mem[k]=String(v)}, removeItem:k=>{delete mem[k]}, clear(){}, get length(){return Object.keys(mem).length} };
/* seed the settings the app reads at load — exactly what the browser has in localStorage */
mem.rv_settings=JSON.stringify({key:STRIPE_KEY, binId:BIN_ID, binKey:BIN_KEY, autoRefresh:false});
mem.rv_sb=JSON.stringify({email:SB_EMAIL, password:SB_PASSWORD, remember:true, auto:true});
function Chart(){ this.destroy=()=>{}; this.resize=()=>{}; this.update=()=>{}; this.data={datasets:[]}; }
Chart.getChart=()=>null; Chart.register=()=>{};

/* ---- fetch: real, except a dry run answers Stripe from an export ---- */
let stripeCalls=0;
const realFetch=globalThis.fetch;
async function fetchX(url,opt){
  const u=String(url);
  if(u.startsWith('https://api.stripe.com')){ stripeCalls++;
    if(!fake) return realFetch(url,opt);
    const ex=JSON.parse(fs.readFileSync(fake,'utf8'));
    const q=new URL(u).searchParams, after=q.get('starting_after');
    if(u.includes('/v1/subscriptions')){
      /* the export holds SLIMMED subs; hand back rows shaped enough for slimSub to re-slim */
      const rows=(ex.subs||[]).map(s=>({id:s.id, customer:{id:s.cust, email:s.cemail, name:s.cname}, status:s.status,
        created:Math.floor(s.created/1000), current_period_end:s.cpe? Math.floor(s.cpe/1000):null, canceled_at:s.canceled? Math.floor(s.canceled/1000):null,
        cancel_at_period_end:!!s.cape, trial_end:s.trialEnd? Math.floor(s.trialEnd/1000):null, pause_collection:s.paused?{}:null,
        cancellation_details:s.reason?{reason:s.reason}:null, discounts:[], items:{data:[{price:{unit_amount:Math.round((s.gross||s.monthly||0)*100), currency:s.eur?'eur':'gbp', recurring:{interval:'month',interval_count:1}, product:s.prod}}]},
        metadata:{}, latest_invoice:(s.status==='incomplete'||s.status==='incomplete_expired')? null
          : {id:'in_fake_'+s.id, status:'paid', paid:true, amount_paid:Math.round((s.gross||s.monthly||0)*100), currency:s.eur?'eur':'gbp',
             created:Math.floor(s.created/1000), status_transitions:{paid_at:Math.floor(s.created/1000)}, lines:{data:[]}}}));
      const i=after? rows.findIndex(r=>r.id===after)+1 : 0, page=rows.slice(i,i+100);
      return new Response(JSON.stringify({data:page, has_more:i+100<rows.length}),{status:200,headers:{'content-type':'application/json'}}); }
    return new Response(JSON.stringify({data:[],has_more:false}),{status:200,headers:{'content-type':'application/json'}}); }
  return realFetch(url,opt);
}

const win={};
const ctx=vm.createContext(Object.assign(win,{ Chart, document, localStorage, navigator:{clipboard:{writeText:()=>Promise.resolve()},userAgent:'node'},
  location:{hash:'',href:'http://x/',replace(){}}, history:{replaceState(){}}, console,
  setTimeout, clearTimeout, setInterval:()=>0, clearInterval(){}, requestAnimationFrame:()=>0,
  matchMedia:()=>({matches:false,addEventListener(){},addListener(){}}), getComputedStyle:()=>({getPropertyValue:()=>''}),
  fetch:fetchX, TextEncoder, TextDecoder, devicePixelRatio:1, AbortController, Response, URL, Headers,
  alert(){}, confirm:()=>true, prompt:()=>null, addEventListener(){}, removeEventListener(){}, dispatchEvent(){} }));
/* real-run overrides on top of the proven harness context */
Object.assign(ctx,{ fetch:fetchX, setTimeout, clearTimeout, Intl, crypto, Response, URL, URLSearchParams, Headers, AbortController,
  /* Node has no IndexedDB. The app's idb layer already falls back to memory when open() fails;
     this shim makes it fail QUIETLY instead of printing three stack traces per save. */
  indexedDB:{ open(){ const req={}; setTimeout(()=>{ req.error=new Error('no IndexedDB in headless'); if(req.onerror) req.onerror({target:req}); },0); return req; } },
  TextEncoder, TextDecoder, CompressionStream, DecompressionStream, Blob, structuredClone, performance,
  location:{hash:'',href:'headless',search:'',pathname:'/'}, alert(){}, confirm:()=>false, prompt:()=>null });
ctx.window=ctx; ctx.self=ctx; ctx.globalThis=ctx;
const t0=Date.now(), log=m=>console.log(new Date().toISOString().slice(11,19)+'  '+m);
try{ vm.runInContext(script, ctx, {timeout:120000}); }catch(e){ console.error('boot failed: '+e.message); process.exit(1); }

(async()=>{
  const run=(code)=>vm.runInContext(code, ctx);
  const out={startedAt:new Date(t0).toISOString(), dryRun:!!fake};
  try{
    log('signing in to Supabase');
    await run("sbAuth({grant:'password', payload:{email:S.sb.email, password:S.sb.password}})");
    log('pulling previous state'); out.pulled=await run('sbPull()');
    /* The app runs its expensive 6-hourly "slow lane" (catalogs, invoice sweep, nested decline-code
       expand) whenever window._rvSlowAt is older than 6h — and a fresh Node process always starts at 0,
       so the FIRST run took 8m23s and every scheduled run would have too. 96 x 8 min a day blows the
       free Actions minutes. Take the slow lane only on the first tick of every 6th hour. */
    const d=new Date(), SLOW = E.SLOW==='1' || (d.getUTCHours()%6===0 && d.getUTCMinutes()<20);
    run('window._rvSlowAt = '+(SLOW? 0 : Date.now())+';');
    out.lane = SLOW? 'slow (6-hourly full pass)' : 'fast';
    log('refreshing from Stripe · '+out.lane+(fake?' (FAKE: '+path.basename(fake)+')':'')); await run('refresh()');
    out.subs=run('S.subs.length'); out.stripeCalls=stripeCalls; out.mrr=run('Math.round(mrrAt(liveSubsList(), Date.now()))');
    /* SB_DRY=1: sign in + pull only. A dry run must NEVER upsert an old export over the live rows. */
    if(E.SB_DRY){ log('SB_DRY set — skipping sbPush()'); out.pushed='skipped (dry)'; }
    else { log('pushing to Supabase'); out.pushed=await run('sbPush()'); }
    log('publishing bridge'); await run('pushSync()');
    out.weekly=run('(function(){ try{ const W=weeklyState(); return {week:W.weekStart, locked:!!(W.locked&&W.locked.lockedAt)}; }catch(e){ return {err:e.message}; } })()');
    out.ok=true;
  }catch(e){ out.ok=false; out.error=e.message; out.stack=String(e.stack||'').split('\n').slice(0,4).join(' | '); }
  out.seconds=Math.round((Date.now()-t0)/1000);
  console.log(JSON.stringify(out,null,1)); process.exit(out.ok?0:1);
})();
