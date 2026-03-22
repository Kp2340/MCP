/**
 * src/http/uiRoutes.js
 *
 * Web UI at GET /ui — browser-based dashboard for the MCP server.
 * No extra dependencies — pure HTML/CSS/JS served as a single string.
 *
 * Features:
 *   • Live job queue with SSE streaming per job
 *   • Diff viewer with Accept / Reject buttons
 *   • Job history list
 *   • Server health stats
 *   • Submit new tasks (with project path + prompt)
 */

import { createLogger } from "../core/logger.js";
const log = createLogger("ui");

export function attachUiRoutes(app) {
    app.get("/ui", (_req, res) => {
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.send(UI_HTML);
    });
    log.info("Web UI attached: GET /ui");
}

const UI_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>AI Dev MCP</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:13px;background:#0d0d0d;color:#d4d4d4;min-height:100vh}
#app{max-width:1100px;margin:0 auto;padding:20px 16px}
header{display:flex;align-items:center;gap:12px;margin-bottom:20px;padding-bottom:14px;border-bottom:1px solid #222}
header h1{font-size:16px;font-weight:600;color:#fff}
.badge{font-size:11px;padding:2px 8px;border-radius:10px;background:#1a1a1a;border:1px solid #333}
.badge.ok{border-color:#1d9e75;color:#4ec9b0}
.badge.err{border-color:#a32d2d;color:#f48771}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}
@media(max-width:700px){.grid{grid-template-columns:1fr}}
.card{background:#111;border:1px solid #1e1e1e;border-radius:8px;overflow:hidden}
.card-header{padding:10px 14px;border-bottom:1px solid #1e1e1e;font-weight:500;font-size:12px;color:#888;display:flex;align-items:center;justify-content:space-between}
.card-body{padding:12px 14px}
textarea,input,select{width:100%;background:#0a0a0a;border:1px solid #2a2a2a;border-radius:4px;color:#d4d4d4;font-family:inherit;font-size:12px;padding:7px 10px;outline:none;resize:vertical}
textarea:focus,input:focus{border-color:#378add}
label{display:block;font-size:11px;color:#666;margin-bottom:4px;margin-top:10px}
label:first-child{margin-top:0}
.btn{display:inline-flex;align-items:center;gap:6px;padding:6px 14px;border-radius:4px;border:none;cursor:pointer;font-family:inherit;font-size:12px;font-weight:500}
.btn-primary{background:#185fa5;color:#fff}
.btn-primary:hover{background:#1a6fc0}
.btn-primary:disabled{opacity:.5;cursor:not-allowed}
.btn-success{background:#16825d;color:#fff}
.btn-success:hover{background:#1a9e6e}
.btn-danger{background:#5a1d1d;color:#f48771;border:1px solid #7a2d2d}
.btn-danger:hover{background:#6a2525}
.btn-sm{padding:3px 10px;font-size:11px}
#job-list{display:flex;flex-direction:column;gap:6px}
.job-row{padding:8px 10px;border-radius:4px;border:1px solid #1e1e1e;background:#0a0a0a;display:flex;align-items:center;gap:10px;cursor:pointer}
.job-row:hover{border-color:#333}
.job-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0}
.job-dot.completed{background:#4ec9b0}
.job-dot.failed{background:#f48771}
.job-dot.running{background:#dcdcaa;animation:pulse .8s ease-in-out infinite}
.job-dot.pending{background:#888}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
.job-info{flex:1;overflow:hidden}
.job-prompt{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:12px;color:#c8c8c8}
.job-meta{font-size:10px;color:#555;margin-top:2px}
.job-actions{display:flex;gap:6px;flex-shrink:0}
#stream-output{font-family:monospace;font-size:11px;line-height:1.6;white-space:pre-wrap;word-break:break-word;max-height:300px;overflow-y:auto;color:#9cdcfe}
#diff-content{font-family:monospace;font-size:11px;line-height:1.5;white-space:pre;overflow-x:auto;max-height:400px;overflow-y:auto}
.diff-add{color:#4ec9b0;background:rgba(78,201,112,.06)}
.diff-del{color:#f48771;background:rgba(244,135,113,.06)}
.diff-meta{color:#555}
#health-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:8px}
.stat-box{background:#0a0a0a;border:1px solid #1e1e1e;border-radius:6px;padding:10px;text-align:center}
.stat-val{font-size:20px;font-weight:600;color:#fff;margin-bottom:4px}
.stat-label{font-size:10px;color:#555}
.divider{border:none;border-top:1px solid #1e1e1e;margin:12px 0}
</style>
</head>
<body>
<div id="app">
  <header>
    <h1>AI Dev MCP</h1>
    <span id="health-badge" class="badge">connecting...</span>
    <span style="flex:1"></span>
    <button class="btn btn-sm" onclick="loadJobs()" style="background:#1a1a1a;color:#888;border:1px solid #2a2a2a">Refresh</button>
  </header>

  <div class="grid">
    <!-- Left: Submit + Stream -->
    <div>
      <div class="card" style="margin-bottom:16px">
        <div class="card-header">Submit task</div>
        <div class="card-body">
          <label>Project path (absolute, on server machine)</label>
          <input id="inp-path" placeholder="C:/Projects/myapp or /home/user/myapp" />
          <label>Prompt</label>
          <textarea id="inp-prompt" rows="3" placeholder="Fix the login bug, Add a new API endpoint..."></textarea>
          <div style="margin-top:10px;display:flex;gap:8px;align-items:center">
            <button class="btn btn-primary" id="run-btn" onclick="submitTask()">Run agent</button>
            <span id="run-status" style="font-size:11px;color:#666"></span>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-header">Live output <span id="stream-job-id" style="color:#555;font-size:10px"></span></div>
        <div class="card-body">
          <div id="stream-output" style="min-height:60px;color:#666">Run a task to see live output...</div>
        </div>
      </div>
    </div>

    <!-- Right: Jobs + Diff -->
    <div>
      <div class="card" style="margin-bottom:16px">
        <div class="card-header">
          Job history
          <select id="filter-status" onchange="loadJobs()" style="width:auto;padding:2px 6px;font-size:11px">
            <option value="">All</option>
            <option value="completed">Completed</option>
            <option value="failed">Failed</option>
            <option value="running">Running</option>
          </select>
        </div>
        <div class="card-body">
          <div id="job-list"><span style="color:#555">Loading...</span></div>
        </div>
      </div>

      <div class="card" id="diff-card" style="display:none">
        <div class="card-header">
          <span id="diff-commit-msg">Changes</span>
          <div style="display:flex;gap:6px">
            <button class="btn btn-success btn-sm" id="accept-btn" onclick="acceptChanges()">Accept</button>
            <button class="btn btn-danger btn-sm" id="reject-btn" onclick="rejectChanges()">Reject</button>
          </div>
        </div>
        <div class="card-body">
          <div id="diff-files" style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px"></div>
          <div id="diff-content"></div>
        </div>
      </div>
    </div>
  </div>

  <div class="card" style="margin-top:16px">
    <div class="card-header">Server health</div>
    <div class="card-body">
      <div id="health-grid"></div>
    </div>
  </div>
</div>

<script>
let currentJobId = null;
let streamSource = null;

// ── Health check ──
function loadHealth() {
  fetch('/health').then(r=>r.json()).then(h=>{
    const badge = document.getElementById('health-badge');
    badge.textContent = 'v' + h.version + ' • ' + h.uptimeSeconds + 's';
    badge.className = 'badge ok';
    const grid = document.getElementById('health-grid');
    var stats = [
      ['Queue running', h.queue && h.queue.running ? 'Yes' : 'No'],
      ['Pending jobs', h.queue ? h.queue.pending : 0],
      ['Projects', h.projects ? h.projects.count : 0],
      ['Free RAM', (h.system ? h.system.freeMemMb : '?') + ' MB'],
      ['Node', h.system ? h.system.nodeVersion : '?'],
      ['Training examples', h.training ? h.training.examples : 0]
    ];
    grid.innerHTML = stats.map(function(s){
      return '<div class="stat-box"><div class="stat-val">' + s[1] + '</div><div class="stat-label">' + s[0] + '</div></div>';
    }).join('');
  }).catch(()=>{
    const b=document.getElementById('health-badge');
    b.textContent='unreachable'; b.className='badge err';
  });
}

// ── Submit task ──
async function submitTask() {
  const path   = document.getElementById('inp-path').value.trim();
  const prompt = document.getElementById('inp-prompt').value.trim();
  if (!path || !prompt) { alert('Enter both a project path and a prompt.'); return; }
  const btn = document.getElementById('run-btn');
  btn.disabled = true;
  document.getElementById('run-status').textContent = 'Submitting...';
  try {
    const res  = await fetch('/run', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ prompt, path }) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || res.statusText);
    document.getElementById('run-status').textContent = 'Job ' + data.id + ' queued';
    streamJob(data.id);
    loadJobs();
  } catch(e) {
    document.getElementById('run-status').textContent = 'Error: ' + e.message;
  } finally { btn.disabled = false; }
}

// ── SSE stream ──
function streamJob(jobId) {
  currentJobId = jobId;
  if (streamSource) streamSource.close();
  const out = document.getElementById('stream-output');
  out.textContent = '';
  document.getElementById('stream-job-id').textContent = '(' + jobId + ')';

  streamSource = new EventSource('/stream/' + jobId);
  const addLine = txt => { out.textContent += txt + '\n'; out.scrollTop = out.scrollHeight; };

  streamSource.addEventListener('step',      e => { const d=JSON.parse(e.data); addLine('[' + (d.step||'?') + '] ' + (d.detail||'')); });
  streamSource.addEventListener('completed', e => { const d=JSON.parse(e.data); addLine('\u2714 Done: ' + (d.result||'')); streamSource.close(); loadDiff(jobId); loadJobs(); });
  streamSource.addEventListener('failed',    e => { const d=JSON.parse(e.data); addLine('\u2718 Failed: ' + (d.error||JSON.stringify(d))); streamSource.close(); loadJobs(); });
  streamSource.onerror = () => addLine('[stream closed]');
}

// ── Load diff ──
async function loadDiff(jobId) {
  try {
    const data = await fetch('/diff/' + jobId).then(r=>r.json());
    currentJobId = jobId;
    document.getElementById('diff-commit-msg').textContent = data.commitMsg || 'Agent changes';
    document.getElementById('diff-card').style.display = '';

    const filesEl = document.getElementById('diff-files');
    filesEl.innerHTML = (data.files||[]).map(function(f){
      var col = f.status==='A' ? '#4ec9b0' : f.status==='D' ? '#f48771' : '#4fc1ff';
      var name = f.path.split(/[\/\\]/).pop();
      return '<span style="font-size:11px;padding:2px 8px;border-radius:10px;background:#1a1a1a;color:' + col + '">' + name + '</span>';
    }).join('');

    const diffEl = document.getElementById('diff-content');
    diffEl.innerHTML = (data.diff||'').split('\n').map(function(line){
      var cls = line.startsWith('+') && !line.startsWith('+++') ? 'diff-add'
              : line.startsWith('-') && !line.startsWith('---') ? 'diff-del'
              : line.startsWith('@@') ? 'diff-meta' : '';
      return '<div class="' + cls + '">' + escHtml(line) + '</div>';
    }).join('');
  } catch(e) { console.warn('getDiff error:', e.message); }
}

function escHtml(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

function acceptChanges() {
  document.getElementById('diff-commit-msg').textContent = '\u2714 Changes accepted';
  document.getElementById('accept-btn').style.display = 'none';
  document.getElementById('reject-btn').style.display = 'none';
}

async function rejectChanges() {
  if (!currentJobId) return;
  if (!confirm('Reject and revert agent changes? This creates a git revert commit.')) return;
  try {
    await fetch('/revert/' + currentJobId, {method:'POST',body:'{}'});
    document.getElementById('diff-commit-msg').textContent = '\u21a9 Changes reverted';
    document.getElementById('accept-btn').style.display = 'none';
    document.getElementById('reject-btn').style.display = 'none';
  } catch(e) { alert('Revert failed: ' + e.message); }
}

// ── Job list ──
async function loadJobs() {
  const status = document.getElementById('filter-status').value;
  const qs = status ? '?status=' + status : '';
  try {
    const jobs = await fetch('/jobs' + qs).then(r=>r.json());
    const list = document.getElementById('job-list');
    if (!jobs.length) { list.innerHTML = '<span style="color:#555">No jobs yet</span>'; return; }
    list.innerHTML = jobs.slice(0,40).map(function(j){
      var dur = j.endedAt && j.startedAt ? ((j.endedAt-j.startedAt)/1000).toFixed(1)+'s \u00b7 ' : '';
      var meta = dur + j.status + ' \u00b7 ' + (j.project||'') + ' \u00b7 ' + new Date(j.createdAt).toLocaleTimeString();
      var streamBtn = j.status==='running' ? '<button class="btn btn-sm" style="background:#1a1a1a;color:#dcdcaa;border:1px solid #333" onclick="event.stopPropagation();streamJob(\'' + j.id + '\')">Stream</button>' : '';
      var diffBtn   = j.status==='completed' ? '<button class="btn btn-sm" style="background:#1a1a1a;color:#4fc1ff;border:1px solid #333" onclick="event.stopPropagation();loadDiff(\'' + j.id + '\')">Diff</button>' : '';
      return '<div class="job-row" onclick="j_click(\'' + j.id + '\',\'' + j.status + '\')">' +
        '<div class="job-dot ' + j.status + '"></div>' +
        '<div class="job-info">' +
          '<div class="job-prompt">' + escHtml(j.prompt||'') + '</div>' +
          '<div class="job-meta">' + meta + '</div>' +
        '</div>' +
        '<div class="job-actions">' + streamBtn + diffBtn + '</div>' +
        '</div>';
    }).join('');
  } catch(e) { document.getElementById('job-list').innerHTML = '<span style="color:#f48771">'+e.message+'</span>'; }
}

function j_click(id, status) {
  if (status === 'running')   streamJob(id);
  if (status === 'completed') loadDiff(id);
}

// Init
loadHealth();
loadJobs();
setInterval(loadHealth, 30000);
setInterval(loadJobs,  10000);
</script>
</body>
</html>`;
