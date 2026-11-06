import {useEffect, useRef, useState} from 'react';

type Page = 'Overview' | 'API explorer' | 'Webhooks' | 'Security & limits';
type Availability = 'live' | 'planned';

interface Endpoint {
  method: 'GET' | 'POST';
  path: string;
  label: string;
  availability: Availability;
  milestone: string;
  description: string;
  demo: 'job_analysis' | 'match' | 'cv_tailoring' | null;
  notes: string[];
}
const endpoints: Endpoint[] = [
  {method:'GET',path:'/v1/health',label:'Service health',availability:'live',milestone:'M1',description:'Readiness probe. Returns status only; infrastructure detail stays private.',demo:null,notes:['No authentication. 60 requests/minute per IP.','200 ready, 503 not ready.']},
  {method:'GET',path:'/v1/capabilities',label:'Capabilities',availability:'live',milestone:'M2',description:'Implemented features, inference mode and hard limits for this deployment.',demo:null,notes:['Requires capabilities:read.','Flags are never aspirational: an unavailable feature is false.']},
  {method:'POST',path:'/v1/jobs/analyze',label:'Analyze a job',availability:'live',milestone:'M2',description:'Queue job extraction and normalization. Returns a run, not the result.',demo:'job_analysis',notes:['Requires jobs:analyze and a unique Idempotency-Key.','202 with Location; the run engine writes the validated result.']},
  {method:'POST',path:'/v1/matches',label:'Candidate match',availability:'live',milestone:'M2',description:'Assess each job requirement against authorized candidate facts.',demo:'match',notes:['Requires matches:write.','The client must hold a candidate grant for subject_ref; consent purpose must be job_matching.','Returns evidence, gaps and limitations — never a hiring probability.']},
  {method:'POST',path:'/v1/runs',label:'Create a typed run',availability:'live',milestone:'M2',description:'Create any implemented operation through one endpoint.',demo:null,notes:['Requires runs:write plus the operation scope.','Unsupported operations return 422 FEATURE_DISABLED.']},
  {method:'GET',path:'/v1/runs/{run_id}',label:'Run status',availability:'live',milestone:'M2',description:'Authoritative status, progress and validated result.',demo:null,notes:['Requires runs:read.','Another tenant\'s run is indistinguishable from a missing one (404).','Expired retention windows return 410.']},
  {method:'GET',path:'/v1/runs/{run_id}/events',label:'Run events',availability:'live',milestone:'M2',description:'Ordered, redacted execution history with cursor pagination.',demo:null,notes:['Runs:read. after_sequence and limit (1-100).','No prompts, CV fields or page content are stored in events.']},
  {method:'POST',path:'/v1/runs/{run_id}/cancel',label:'Cancel a run',availability:'live',milestone:'M2',description:'Persist a cancellation request with an expected version.',demo:null,notes:['Runs:control and expected_version for optimistic concurrency.','Queued runs cancel immediately; running work stops at the next safe point.','Already-finished runs return 409 RUN_TERMINAL.']},
  {method:'POST',path:'/v1/cv/tailor',label:'Tailor a CV',availability:'live',milestone:'M3',description:'Grounded, versioned CV artifacts that only reuse supplied facts.',demo:'cv_tailoring',notes:['Requires cv:tailor and the candidate grant; consent purpose must be cv_tailoring.','Extractive mode: each line is exact supplied text or its exact title, employer, dates. Paraphrase is rejected.','Returns a run; the artifact id arrives with the completed result.']},
  {method:'GET',path:'/v1/artifacts/{artifact_id}',label:'Retrieve an artifact',availability:'live',milestone:'M3',description:'Authorized, immutable artifact versions with a SHA-256 checksum.',demo:null,notes:['Requires artifacts:read plus the candidate grant for the owning subject.','Immutable: a re-run creates a new version instead of editing this one.','Foreign tenant 404, expired retention 410, no signed URL while binary storage is disabled.']},
  {method:'POST',path:'/v1/webhooks',label:'Register a webhook',availability:'planned',milestone:'M6',description:'Signed delivery subscriptions for run events.',demo:null,notes:['Not implemented. Returns 422 FEATURE_DISABLED.']},
];

const sampleJob = `Example Ltd seeks a Backend Engineer with TypeScript and API testing experience.
You must have 3+ years of experience with Node.js.
Experience with PostgreSQL is preferred.
The role is based in Berlin.`;

interface RunView {
  run_id: string; operation: string; status: string; progress: number; version: number;
  created_at: string | null; started_at: string | null; completed_at: string | null;
  cancel_requested_at: string | null;
  result: unknown; error: unknown;
  usage: {model: string | null; prompt_version: string | null; browser_seconds: number};
}
interface EventView { event_id: string; sequence: number; type: string; status: string; occurred_at: string }
interface ArtifactView { artifact_id: string; run_id: string; version: number; checksum: string; created_at: string | null; expires_at: string | null; content: unknown }
interface Health { status: string }

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function text(value: unknown): string | null { return typeof value === 'string' ? value : null; }
function list(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
const isTerminal = (status: string) => ['completed','partially_completed','failed','cancelled','expired'].includes(status);

export default function App(){
  const [page,setPage]=useState<Page>('Overview');
  const [selected,setSelected]=useState(2);
  const [health,setHealth]=useState<'checking'|'ready'|'unavailable'>('checking');
  const [demo,setDemo]=useState<'checking'|'enabled'|'disabled'>('checking');
  const [jobText,setJobText]=useState(sampleJob);
  const [accepted,setAccepted]=useState<{run_id:string;status_url:string;created_at:string}|null>(null);
  const [run,setRun]=useState<RunView|null>(null);
  const [artifact,setArtifact]=useState<ArtifactView|null>(null);
  const [events,setEvents]=useState<EventView[]>([]);
  const [error,setError]=useState('');
  const [activity,setActivity]=useState<{path:string;status:number;time:string}[]>([]);
  const [busy,setBusy]=useState(false);
  const cancelled=useRef(false);

  useEffect(()=>{
    cancelled.current=false;
    void (async()=>{
      try {const response=await fetch('/v1/health');setHealth(response.ok?'ready':'unavailable');} catch {setHealth('unavailable');}
      try {
        const response=await fetch('/v1/demo/capabilities',{headers:{'X-Jobauto-Demo':'true'}});
        setDemo(response.ok?'enabled':'disabled');
      } catch {setDemo('disabled');}
    })();
    return ()=>{cancelled.current=true;};
  },[]);

  const endpoint=endpoints[selected] ?? endpoints[0]!;
  const go=(next:Page)=>{setPage(next);setError('');};
  const pick=(index:number)=>{setSelected(index);setRun(null);setArtifact(null);setEvents([]);setAccepted(null);setError('');};

  const payload = endpoint.demo==='cv_tailoring'
    ? {candidate:{subject_ref:'candidate-42',consent:{purpose:'cv_tailoring',granted_at:'<ISO-8601 UTC>'},facts:[{id:'fact-1',kind:'summary',text:'Backend engineer with TypeScript experience.'},{id:'fact-2',kind:'skill',text:'TypeScript'},{id:'fact-3',kind:'experience',text:'Built API endpoints and automated tests at Example Ltd.',employer:'Example Ltd',title:'Software Engineer',start_date:'2021-03-01',end_date:null}],preferences:{preparation_only:true}},job:{kind:'text',text:jobText}}
    : endpoint.demo==='match'
    ? {candidate:{subject_ref:'candidate-42',consent:{purpose:'job_matching',granted_at:'<ISO-8601 UTC>'},facts:[{id:'fact-1',kind:'skill',text:'TypeScript'},{id:'fact-2',kind:'experience',text:'Built API endpoints and automated tests at Example Ltd.',employer:'Example Ltd'}],preferences:{preparation_only:true}},job:{kind:'text',text:jobText}}
    : endpoint.demo==='job_analysis'
      ? {job:{kind:'text',text:jobText},options:{locale:'en',timeout_seconds:300}}
      : {operation:'job_analysis',job:{kind:'text',text:jobText}};
  const snippet = `curl $JOBAUTO_ORIGIN${endpoint.path} \\\n  -X ${endpoint.method} \\\n  -H "Authorization: Bearer $JOBAUTO_API_KEY" \\\n  -H "Content-Type: application/json"${endpoint.method==='POST'&&endpoint.demo?' \\\n  -H "Idempotency-Key: tailor-candidate42-001"':''}${endpoint.method==='POST'?` \\\n  -d '${JSON.stringify(payload,null,2)}'`:''}`;

  async function startDemo(){
    if(!endpoint.demo)return;
    setBusy(true);setError('');setRun(null);setArtifact(null);setEvents([]);setAccepted(null);
    try{
      const response=await fetch('/v1/demo/runs',{method:'POST',headers:{'Content-Type':'application/json','X-Jobauto-Demo':'true'},body:JSON.stringify({scenario:endpoint.demo,job_text:jobText})});
      const created=await response.json() as Record<string,unknown>;
      setActivity(previous=>[{path:'POST /v1/demo/runs',status:response.status,time:new Date().toLocaleTimeString()},...previous].slice(0,8));
      if(!response.ok){setError(describe(created));setBusy(false);return;}
      const data=record(created.data);
      const runId=text(data?.run_id);
      if(!runId){setError('The demo response did not include a run id.');setBusy(false);return;}
      setAccepted({run_id:runId,status_url:text(data?.status_url) ?? '',created_at:text(data?.created_at) ?? ''});
      let finished:RunView|null=null;
      for(let attempt=0;attempt<80&&!cancelled.current;attempt++){
        await Bun_sleep(300);
        const state=await fetch(`/v1/demo/runs/${runId}`,{headers:{'X-Jobauto-Demo':'true'}});
        const body=await state.json() as Record<string,unknown>;
        const current=record(body.data) as RunView | null;
        if(!state.ok){setError(describe(body));break;}
        setRun(current);finished=current;
        const history=await fetch(`/v1/demo/runs/${runId}/events`,{headers:{'X-Jobauto-Demo':'true'}});
        if(history.ok){const hb=await history.json() as Record<string,unknown>;setEvents((record(hb.data)?.events ?? []) as EventView[]);}
        if(current&&isTerminal(current.status))break;
      }
      // A tailored CV is a separate immutable artifact, so it is fetched by id.
      const artifactId=text(record(finished?.result)?.artifact_id);
      if(artifactId){
        const response=await fetch(`/v1/demo/artifacts/${artifactId}`,{headers:{'X-Jobauto-Demo':'true'}});
        if(response.ok){const body=await response.json() as Record<string,unknown>;setArtifact(record(body.data) as ArtifactView|null);setActivity(previous=>[{path:'GET /v1/demo/artifacts/:id',status:response.status,time:new Date().toLocaleTimeString()},...previous].slice(0,8));}
      }
      setActivity(previous=>[{path:'GET /v1/demo/runs/:id',status:200,time:new Date().toLocaleTimeString()},...previous].slice(0,8));
    }catch{setError('Could not reach the local API. Start the API, then retry.');}
    finally{setBusy(false);}
  }

  const copy=async(value:string)=>{try{await navigator.clipboard.writeText(value);}catch{setError('Clipboard unavailable. Select and copy manually.');}};
  const availability = endpoint.availability==='live' ? (endpoint.demo?'Live · async':'Live') : `Planned · ${endpoint.milestone}`;

  return <div className="app-shell">
    <aside className="sidebar">
      <a className="brand" href="#overview" onClick={()=>go('Overview')}><span className="brand-icon">j<span>↗</span></span>jobauto<span className="brand-dot">.</span></a>
      <div className="workspace"><span className="workspace-avatar">D</span><div>Developer workspace<small>Local development</small></div><span className="chevrons">⌃<br/>⌄</span></div>
      <div className="nav-label">BUILD</div>
      <nav>{(['Overview','API explorer','Webhooks','Security & limits'] as Page[]).map((entry,index)=><button key={entry} onClick={()=>go(entry)} className={page===entry?'nav-item active':'nav-item'}><span className="nav-icon">{['◫','⌘','⌁','◇'][index]}</span>{entry}{entry==='API explorer'&&<span className="nav-badge">{endpoints.length}</span>}</button>)}</nav>
      <div className="nav-label resources-label">RESOURCES</div>
      <a className="resource-link" href="/v1/openapi.json" target="_blank" rel="noreferrer"><span>↗</span> Live OpenAPI contract</a>
      <button className="resource-link" onClick={()=>go('Security & limits')}><span>⌑</span> Integration guide</button>
      <div className="sidebar-bottom"><div className="foundation-label"><span className="status-dot amber"/> MILESTONE 03</div><p>Grounded artifacts.<br/>Honest execution state.</p><span className="version">API v1 <span>·</span> Cequre + Bun</span></div>
    </aside>
    <main>
      <header className="topbar"><div><span className="breadcrumb">Workspace</span><span className="slash">/</span>{page}</div><div className="topbar-right"><span className="environment"><span className="status-dot"/>Development</span><a href="/v1/openapi.json" target="_blank" rel="noreferrer">API reference ↗</a><span className="user-avatar">D</span></div></header>
      <div className="content">
        <div className="page-heading"><div><div className="eyebrow">DEVELOPER PLATFORM</div><h1>{page==='Overview'?'Your next integration starts here.':page==='API explorer'?'One API. Clear contracts.':page==='Webhooks'?'Events, without the guesswork.':'Secure by design. Explicit by default.'}</h1><p>{page==='Overview'?'Job intelligence infrastructure for the products you’re building.':page==='API explorer'?'Send a real request, watch the durable run, inspect the validated result.':page==='Webhooks'?'Build against an event-driven contract. Delivery is a future capability.':'A service boundary you can reason about, test, and control.'}</p></div><span className="release-tag">MILESTONE 03 <span>Tailoring</span></span></div>

        {page==='Overview'&&<>
          <section className="intro-card"><div><span className="mini-label"><span className="status-dot"/> API-FIRST AUTOMATION</span><h2>Your product.<br/>Our execution layer.</h2><p>Analyze jobs and assess candidate evidence through an async,<br className="desktop-break"/> idempotent API with durable run state.</p><div className="intro-actions"><button className="primary" onClick={()=>{pick(2);go('API explorer');}}>Run the live demo <span>↗</span></button><a href="/v1/openapi.json" target="_blank" rel="noreferrer">View live contract <span>→</span></a></div></div><div className="diagram" aria-label="Your application calls the versioned API, which executes work in the Cequre runtime"><div className="diagram-node">▣ <span>Your application</span></div><div className="diagram-connector">HTTPS / JSON <span>↓</span></div><div className="diagram-node api-node"><span className="node-logo">j↗</span><span>jobauto<span className="muted"> / v1</span></span><span className="status-dot"/></div><div className="diagram-line"/><div className="diagram-branches"><span>◇ Durable run</span><span>⌁ Cequre</span></div><small>Idempotent · Tenant-scoped · Provider-independent</small></div></section>
          <div className="metric-grid"><div className="metric"><span>API status <span className="metric-symbol">↗</span></span><strong><span className={`status-dot ${health==='ready'?'':'amber'}`}/>{health==='ready'?'Operational':health==='checking'?'Checking…':'Unavailable'}</strong><small>Live readiness check</small></div><div className="metric"><span>Implemented endpoints <span className="metric-symbol">⌘</span></span><strong>{String(endpoints.filter(entry=>entry.availability==='live').length).padStart(2,'0')} <span className="metric-sub">/ {endpoints.length} documented</span></strong><small>Runs, analysis, matching, tailoring</small></div><div className="metric"><span>Inference mode <span className="metric-symbol">◇</span></span><strong>Deterministic</strong><small>No model calls, no browser sessions</small></div></div>
          <div className="section-heading"><div><h2>Built to plug in</h2><p>Independent capabilities. One consistent integration boundary.</p></div><button className="text-button" onClick={()=>go('API explorer')}>All endpoints <span>→</span></button></div>
          <div className="capability-grid">{[{icon:'≡',title:'Job intelligence',text:'Structure a posting into grounded, quotable requirements.',endpoint:'POST /v1/jobs/analyze',milestone:'LIVE · M2',index:2},{icon:'▤',title:'Evidence matching',text:'Assess each requirement against authorized candidate facts.',endpoint:'POST /v1/matches',milestone:'LIVE · M2',index:3},{icon:'⌁',title:'Runs & events',text:'Poll authoritative status and redacted execution history.',endpoint:'GET /v1/runs/{run_id}',milestone:'LIVE · M2',index:5},{icon:'◈',title:'Grounded CV tailoring',text:'Versioned artifacts that reuse only supplied facts.',endpoint:'POST /v1/cv/tailor',milestone:'LIVE · M3',index:8}].map(card=><button className="capability-card" key={card.title} onClick={()=>{pick(card.index);go('API explorer');}}><div className="card-top"><span className="capability-icon">{card.icon}</span><span className={card.milestone.startsWith('LIVE')?'live-label':'planned'}>{card.milestone}</span></div><h3>{card.title} <span>↗</span></h3><p>{card.text}</p><code>{card.endpoint}</code></button>)}</div>
          <section className="getting-started"><div className="getting-icon">⌘</div><div><h3>Integrate in three calls</h3><p>Submit work with an idempotency key, poll the run, then read the result.</p></div><button className="secondary" onClick={()=>{pick(2);go('API explorer');}}>Open API explorer →</button></section>
          <pre className="code-block">{`# 1. Accept work (202 + Location)\ncurl $JOBAUTO_ORIGIN/v1/jobs/analyze \\\n  -H "Authorization: Bearer $JOBAUTO_API_KEY" \\\n  -H "Idempotency-Key: analyze-posting-001" \\\n  -H "Content-Type: application/json" \\\n  -d '{"job":{"kind":"text","text":"..."}}'\n\n# 2. Poll until terminal\ncurl $JOBAUTO_ORIGIN/v1/runs/{run_id} -H "Authorization: Bearer $JOBAUTO_API_KEY"`}</pre>
          <div className="foundation-note"><span>ⓘ</span><p><strong>Real execution, honestly reported.</strong> Accepted work is durable in PostgreSQL. The Cequre run engine executes it in-process and a one-minute cron recovers queued work; uncertain outcomes are never reported as success.</p></div>
        </>}

        {page==='API explorer'&&<>
          <div className="notice"><span>ⓘ</span>{demo==='enabled'?'Live demo enabled on this machine: analysis, matching and CV tailoring run through the real Cequre engine with a fixed synthetic candidate. Your production calls authenticate with your own scoped key.':demo==='checking'?'Checking the local demo…':'The loopback demo is off. Start it with bun run demo:enable and restart the API to try requests in the browser; the contract examples remain available.'}</div>
          <div className="explorer-layout">
            <section className="endpoint-list">{endpoints.map((entry,index)=><button key={entry.path} className={selected===index?'endpoint active':'endpoint'} onClick={()=>pick(index)}><span className={`method ${entry.method==='POST'?'post':''}`}>{entry.method}</span><span>{entry.label}<code>{entry.path}</code></span><span className={entry.availability==='live'?'live-label':'endpoint-planned'}>{entry.availability==='live'?'LIVE':'SOON'}</span></button>)}</section>
            <section className="request-panel">
              <div className="panel-heading"><div><h2>{endpoint.label}</h2><p>{endpoint.description}</p></div><span className={endpoint.availability==='live'?'pill-live':'planned'}>{availability}</span></div>
              <div className="request-bar"><span className={`method ${endpoint.method==='POST'?'post':''}`}>{endpoint.method}</span><code>{endpoint.path}</code>{endpoint.demo?<button className="primary" disabled={busy||demo!=='enabled'} onClick={()=>void startDemo()}>{busy?'Running…':demo==='enabled'?'Send live demo ↗':'Demo disabled'}</button>:<button className="secondary" onClick={()=>void copy(snippet)}>Copy request ⧉</button>}</div>
              {endpoint.demo&&<label className="field"><span>Job description (20–30,000 characters)</span><textarea className="textarea" value={jobText} onChange={event=>setJobText(event.target.value)} rows={6} maxLength={30000}/></label>}
              <div className="code-heading"><span>cURL <span className="code-hint">SERVER-SIDE CREDENTIAL</span></span><button onClick={()=>void copy(snippet)}>Copy request ⧉</button></div>
              <pre className="code-block">{snippet}</pre>
              <ul className="checklist">{endpoint.notes.map(note=><li key={note}>{note}</li>)}</ul>
              {endpoint.availability==='planned'&&<p className="inline-note">This endpoint is documented but not implemented. Calling it returns 422 FEATURE_DISABLED after authentication, and /v1/capabilities reports {endpoint.demo?'false':'the feature as unavailable'}.</p>}
              {error&&<p role="alert" className="error-banner">{error}</p>}
              {accepted&&<div className="run-summary"><div><span className="mini-label">ACCEPTED</span><code>{accepted.run_id}</code></div><span className="success-text">202</span></div>}
              {run&&<>
                <div className="lifecycle">{['queued','validating','running',run.status].filter((value,index,all)=>all.indexOf(value)===index).map(step=><span key={step} className={step===run.status?'lifecycle-step active':'lifecycle-step'}>{step}</span>)}</div>
                <div className="run-meta"><div><span>Status</span><strong className={run.status==='completed'?'success-text':run.status==='failed'?'error-text':''}>{run.status}</strong></div><div><span>Progress</span><strong>{run.progress}%</strong></div><div><span>Version</span><strong>{run.version}</strong></div><div><span>Prompt</span><strong>{run.usage.prompt_version ?? '—'}</strong></div><div><span>Tokens</span><strong>{run.usage.model ? 'metered' : 'none'}</strong></div><div><span>Browser</span><strong>{run.usage.browser_seconds}s</strong></div></div>
                <RunResult result={run.result} error={run.error} artifact={artifact}/>
                <div className="response-heading"><h3>Raw run</h3><button onClick={()=>void copy(JSON.stringify(run,null,2))}>Copy JSON ⧉</button></div>
                <pre className="response-block">{JSON.stringify(run,null,2)}</pre>
                <div className="response-heading"><h3>Events</h3><span className="muted">{events.length} recorded</span></div>
                {events.length?<div className="timeline">{events.map(event=><div key={event.event_id}><span className="timeline-seq">#{event.sequence}</span><code>{event.type}</code><span className="timeline-status">{event.status}</span><time>{new Date(event.occurred_at).toLocaleTimeString()}</time></div>)}</div>:<p className="inline-note">No events recorded for this run yet.</p>}
              </>}
              <div className="response-heading"><h3>Status codes</h3></div>
              <table><thead><tr><th>Code</th><th>Meaning</th></tr></thead><tbody><tr><td>202</td><td>Durably accepted; poll Location</td></tr><tr><td>400</td><td>Malformed or invalid payload with field details</td></tr><tr><td>401 / 403</td><td>Credential, scope or candidate grant denied</td></tr><tr><td>409</td><td>Idempotency, version or state conflict</td></tr><tr><td>410</td><td>Retention window expired</td></tr><tr><td>422</td><td>Unsupported operation or consent mismatch</td></tr><tr><td>429</td><td>Rate limit or active-run quota</td></tr></tbody></table>
            </section>
          </div>
          <section className="activity"><h3>Session request history <span>In memory only</span></h3>{activity.length?<div className="activity-table">{activity.map((entry,index)=><div key={`${entry.time}-${index}`}><span className={entry.status<400?'success-text':'error-text'}>{entry.status}</span><code>{entry.path}</code><time>{entry.time}</time></div>)}</div>:<p>Your actual requests will appear here. No seeded usage or simulated responses.</p>}</section>
        </>}

        {page==='Webhooks'&&<><section className="plain-card"><span className="planned">PLANNED · M6</span><h2>Listen for progress. Retrieve the truth.</h2><p>Webhook delivery is not enabled. Consumers will receive signed notifications and must retrieve authoritative state from the runs API. Events may be duplicated or arrive out of order.</p><div className="webhook-flow"><span>Run event</span><b>→</b><span>Durable outbox</span><b>→</b><span>Signed HTTPS delivery</span><b>→</b><span>Your endpoint</span></div></section><div className="two-columns"><section className="plain-card"><h3>Proposed event envelope</h3><p>Illustrative contract only · not a received delivery</p><pre className="response-block">{JSON.stringify({event_id:'949f3dc1-fef3-4e38-af7c-eb048f269724',type:'run.completed',occurred_at:'2026-10-31T12:00:01Z',run_id:'c0db54c8-3dde-4ab8-95ed-3a1c1ed3d0b1',sequence:4,status:'completed',schema_version:'v1'},null,2)}</pre></section><section className="plain-card"><h3>Verification checklist</h3><ul className="checklist"><li>Verify HMAC-SHA256 over timestamp + raw body.</li><li>Reject timestamps outside a 300-second tolerance.</li><li>Deduplicate using the event ID.</li><li>Handle out-of-order sequences.</li><li>Retrieve the run to confirm its current state.</li><li>Never treat an agent’s completion as submission evidence.</li></ul></section></div><section className="plain-card"><h3>Designed event types</h3><div className="event-tags">{['run.created','run.started','run.completed','run.partially_completed','run.failed','run.cancelled','run.expired','run.awaiting_approval'].map(event=><code key={event}>{event}</code>)}</div><p className="inline-note">Registration, secret rotation, retries and delivery history will ship together. Nothing can be registered against in this release.</p></section></>}

        {page==='Security & limits'&&<><div className="two-columns"><section className="plain-card"><span className="mini-label">IDENTITY</span><h2>Keys belong on your server.</h2><p>Scoped API keys are stored as keyed HMAC digests. Secrets are issued once. Tenant and candidate authority come from the credential, never from the request body.</p><pre className="response-block">{`bun run keys create\nbun run keys rotate <key-id>\nbun run keys revoke <key-id>`}</pre><p className="inline-note">Candidate access is a separate grant on the client: a key with matches:write cannot read a candidate it was not granted.</p></section><section className="plain-card"><span className="mini-label">GUARDRAILS</span><h2>Explicit boundaries.</h2><ul className="checklist"><li>Credential-derived tenant identity</li><li>Immediate revocation checks</li><li>Strict payload validation, unknown properties rejected</li><li>Idempotency keys required for run creation</li><li>In-process execution with cron recovery</li><li>No model calls or browser sessions in this release</li></ul></section></div><section className="plain-card"><h3>Current limits</h3><table><thead><tr><th>Resource</th><th>Limit</th><th>Enforcement</th></tr></thead><tbody><tr><td>Authenticated reads</td><td>120 / minute / client</td><td>Redis atomic counter</td></tr><tr><td>Authenticated mutations</td><td>20 / minute / client</td><td>Redis atomic counter</td></tr><tr><td>Run creation</td><td>10 / minute / client</td><td>Redis atomic counter</td></tr><tr><td>Active intelligence runs</td><td>2 / tenant</td><td>Transactional quota check</td></tr><tr><td>Request body</td><td>256 KiB</td><td>Server + bounded stream</td></tr><tr><td>Idempotency window</td><td>24 hours</td><td>Unique (tenant, client, key)</td></tr><tr><td>Input / result retention</td><td>30 days</td><td>expires_at, 410 afterwards</td></tr><tr><td>CV artifacts</td><td>30 days, immutable</td><td>Versioned per subject; 410 after expiry</td></tr><tr><td>Candidate deletion</td><td>Async purge</td><td>Runs fenced, artifacts and snapshots removed</td></tr></tbody></table></section><section className="plain-card"><h3>Error envelope</h3><pre className="response-block">{JSON.stringify({error:{code:'INVALID_INPUT',message:'The request payload is invalid.',retryable:false,details:[{path:'job.text',code:'LENGTH_OUT_OF_RANGE'}]},request_id:'949f3dc1-fef3-4e38-af7c-eb048f269724'},null,2)}</pre><p className="inline-note">Codes are stable and machine-readable. Messages never include stack traces, SQL, credentials or another tenant’s data.</p></section></>}

        <footer><span><span className="footer-logo">j↗</span> jobauto developer platform</span><span>Independent by design. <span className="footer-separator">/</span> API v1</span></footer>
      </div>
    </main>
  </div>;
}

function describe(body:Record<string,unknown>):string{
  const error=record(body.error);
  const code=text(error?.code) ?? 'REQUEST_FAILED';
  const message=text(error?.message) ?? 'The request could not be completed.';
  const details=list(error?.details).map(entry=>record(entry)).filter(Boolean).map(entry=>`${text(entry?.path) ?? ''} ${text(entry?.code) ?? ''}`.trim()).filter(Boolean);
  return `${code}: ${message}${details.length?` (${details.join('; ')})`:''}`;
}
function Bun_sleep(ms:number){return new Promise<void>(resolve=>setTimeout(resolve,ms));}

function CvArtifact({artifact}:{artifact:ArtifactView}){
  const content=record(artifact.content);
  const sections=list(content?.sections).map(entry=>record(entry)).filter(Boolean);
  return <div className="result-block"><h3>Tailored CV <span className="muted">version {artifact.version}</span></h3>
    <div className="run-meta"><div><span>Artifact</span><strong><code>{artifact.artifact_id.slice(0,8)}…</code></strong></div><div><span>Mode</span><strong>{text(content?.mode) ?? '—'}</strong></div><div><span>Sections</span><strong>{sections.length}</strong></div><div><span>Checksum</span><strong><code>{artifact.checksum.slice(0,12)}…</code></strong></div><div><span>Expires</span><strong>{artifact.expires_at?new Date(artifact.expires_at).toLocaleDateString():'—'}</strong></div></div>
    {sections.map((section,index)=>{const items=list(section?.items).map(entry=>record(entry)).filter(Boolean);return <div key={`${text(section?.heading) ?? index}`}><h4>{text(section?.heading) ?? 'Section'} <span className="muted">{items.length}</span></h4><ul className="checklist">{items.map((item,position)=><li key={position}>{text(item?.text)} <small className="muted">facts: {list(item?.fact_ids).join(', ')}</small></li>)}</ul></div>;})}
    <p className="inline-note">Every line above is supplied fact text or its exact title, employer and dates. Nothing was paraphrased, and the original CV was not modified.</p>
  </div>;
}

function RunResult({result,error,artifact}:{result:unknown;error:unknown;artifact:ArtifactView|null}){
  if(error){
    const payload=record(error);
    return <div className="result-block"><h3 className="error-text">Run failed</h3><p>{text(payload?.message) ?? 'The run did not complete.'}</p><pre className="response-block">{JSON.stringify(error,null,2)}</pre></div>;
  }
  if(!result)return <p className="inline-note">The result appears here after the Cequre engine completes the run.</p>;
  const payload=record(result);
  const kind=text(payload?.kind);
  if(kind==='job_analysis'){
    const job=record(payload?.job);
    const requirements=list(job?.requirements).map(entry=>record(entry)).filter(Boolean);
    return <div className="result-block"><h3>Normalized job</h3><div className="run-meta"><div><span>Title</span><strong>{text(job?.title) ?? '—'}</strong></div><div><span>Employer</span><strong>{text(job?.employer) ?? '—'}</strong></div><div><span>Location</span><strong>{text(job?.location) ?? '—'}</strong></div><div><span>Seniority</span><strong>{text(job?.seniority) ?? '—'}</strong></div></div><h4>Requirements <span className="muted">{requirements.length}</span></h4>{requirements.length?<div className="requirement-list">{requirements.map((entry,index)=><div key={`${text(entry?.id) ?? index}`} className="requirement"><span className={text(entry?.importance)==='required'?'tag required':'tag'}>{text(entry?.importance) ?? 'unknown'}</span><div><p>{text(entry?.text)}</p><blockquote>{text(entry?.source_quote)}</blockquote></div></div>)}</div>:<p className="inline-note">No explicit requirements were detected in this text.</p>}{list(job?.missing_information).length>0&&<><h4>Missing information</h4><ul className="checklist">{list(job?.missing_information).map((entry,index)=><li key={index}>{String(entry)}</li>)}</ul></>}<h4>Limitations</h4><ul className="checklist">{list(job?.limitations).map((entry,index)=><li key={index}>{String(entry)}</li>)}</ul></div>;
  }
  if(kind==='match'){
    const match=record(payload?.match);
    const assessments=list(match?.assessments).map(entry=>record(entry)).filter(Boolean);
    return <div className="result-block"><h3>Evidence assessment</h3><div className="assessment-grid">{assessments.map((entry,index)=><div key={`${text(entry?.requirement_id) ?? index}`} className={`assessment ${text(entry?.assessment) ?? 'unknown'}`}><span className="tag">{String(text(entry?.assessment) ?? 'unknown').replace('_',' ')}</span><code>{text(entry?.requirement_id)}</code><p>{text(entry?.explanation)}</p>{list(entry?.fact_ids).length>0&&<small>facts: {list(entry?.fact_ids).join(', ')}</small>}</div>)}</div><h4>Recommendations</h4><ul className="checklist">{list(match?.recommendations).map((entry,index)=><li key={index}>{String(entry)}</li>)}</ul><h4>Limitations</h4><ul className="checklist">{list(match?.limitations).map((entry,index)=><li key={index}>{String(entry)}</li>)}</ul></div>;
  }
  if(kind==='cv_tailoring'){
    return <div className="result-block">{artifact?<CvArtifact artifact={artifact}/>:<p className="inline-note">The artifact is fetched separately once the run completes.</p>}<h4>Limitations</h4><ul className="checklist">{list(payload?.limitations).map((entry,index)=><li key={index}>{String(entry)}</li>)}</ul></div>;
  }
  return <pre className="response-block">{JSON.stringify(result,null,2)}</pre>;
}
