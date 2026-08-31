import { safeConfigView } from './core.js';
import { SINGLE_CF_EDGE_IP } from './adaptive.js';

export function cafePage() {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Unisol Coffee</title><style>
:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;font-family:system-ui,-apple-system,Segoe UI,sans-serif;background:#16120f;color:#f4eadf;min-height:100vh;display:grid;place-items:center}.card{width:min(680px,92vw);padding:48px;border:1px solid #4d3829;border-radius:28px;background:linear-gradient(145deg,#211914,#17110e);box-shadow:0 24px 80px #0008}.mark{font-size:52px}h1{font-size:42px;margin:14px 0 8px}.muted{color:#bca895;line-height:1.65}.pill{display:inline-block;margin-top:22px;padding:9px 14px;border-radius:999px;background:#2c211a;color:#d7c0aa;font-size:13px;letter-spacing:.08em;text-transform:uppercase}</style></head>
<body><main class="card"><div class="mark">☕</div><h1>Unisol Coffee</h1><p class="muted">Small-batch coffee, quiet tables, and a simple edge service behind the counter.</p><span class="pill">Open daily</span></main></body></html>`;
}

export function adminPage(adminConfigured = true) {
  const setupNote = adminConfigured ? '' : `<div class="notice"><strong>ADMIN is not configured.</strong><br>The panel is available, but configuration access is locked. Add a Worker variable named <code>ADMIN</code> with a strong password. To save settings from this panel, also bind a Cloudflare KV namespace as <code>KV</code>. Deploy the Worker again, then reload this page.</div>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Unisol Admin</title>
<style>:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;background:#0b0d10;color:#e8edf2;font:14px system-ui,-apple-system,Segoe UI,sans-serif}.wrap{max-width:1040px;margin:auto;padding:28px}h1{font-size:30px;margin:0 0 6px}.sub{color:#8e9aa7;margin-bottom:24px}.notice{margin:0 0 18px;padding:14px 16px;border:1px solid #745f24;border-radius:12px;background:#231f12;color:#eadb9f;line-height:1.55}.notice code{padding:2px 5px;border-radius:5px;background:#0c1014;color:#f0f4f8}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:14px}.card{background:#11151a;border:1px solid #252c34;border-radius:16px;padding:18px}.wide{grid-column:1/-1}.hint{color:#8593a0;font-size:12px;line-height:1.55;margin-top:8px}label{display:block;color:#aeb8c2;margin:10px 0 6px}input,select,textarea{width:100%;padding:11px 12px;border-radius:9px;border:1px solid #303944;background:#0c1014;color:#edf3f8}input:disabled{opacity:.75;color:#aab5bf}textarea{min-height:96px;resize:vertical}.row{display:flex;gap:12px;flex-wrap:wrap}.check{display:flex;align-items:center;gap:8px;margin:8px 14px 8px 0}.check input{width:auto}.metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px}button{border:0;border-radius:10px;padding:11px 16px;font-weight:700;cursor:pointer;background:#e9eef3;color:#11161b}.secondary{background:#252c34;color:#e8edf2}button:disabled{opacity:.45;cursor:not-allowed}.actions{display:flex;gap:10px;align-items:center;margin-top:18px;flex-wrap:wrap}.status{color:#9fb0c0}.flow{margin-top:12px;padding:12px;border-radius:10px;background:#0c1014;border:1px solid #25303a;color:#c7d2dc;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;overflow:auto}</style></head>
<body><div class="wrap"><h1>Unisol Admin</h1><div class="sub">Live Worker configuration. The admin password stays in this browser session and is sent only in the Authorization header.</div>${setupNote}
<div class="grid"><section class="card"><h3>Identity</h3><label>UUID v4</label><input id="uuid"><label>Ingress path</label><input id="path"><label>Trojan password</label><input id="trojanPassword" type="password"><label>Subscription name</label><input id="subscriptionName"></section>
<section class="card"><h3>Outbound</h3><label>SOCKS / HTTP(S) proxy</label><input id="outbound" placeholder="socks5://user:pass@host:1080"><label>Mode</label><select id="mode"><option>adaptive</option><option>proxy-first</option><option>direct-first</option><option>proxy-only</option><option>direct</option></select><label>Dial race</label><input id="dialRace" type="number" min="1" max="4"><div class="hint">In adaptive mode the configured proxy is a real fallback route; it is not bypassed by the Cloudflare edge step.</div></section>
<section class="card wide"><h3>Adaptive egress</h3><div class="row"><label class="check"><input id="adaptiveEdge" type="checkbox"> Try single Cloudflare edge before user fallbacks</label></div><div class="metrics"><div><label>Single CF Anycast edge</label><input value="${SINGLE_CF_EDGE_IP}" disabled></div><div><label>Direct hedge delay (ms)</label><input id="hedgeDelayMs" type="number" min="100" max="5000"></div><div><label>Proxy first-byte timeout (ms)</label><input id="firstByteTimeoutMs" type="number" min="1000" max="15000"></div><div><label>Edge / ProxyIP timeout (ms)</label><input id="edgeFirstByteTimeoutMs" type="number" min="750" max="10000"></div></div><div class="flow">direct → one CF edge → ProxyIP → SOCKS/HTTP(S)</div><div class="hint">There is no Cloudflare edge pool and no edge race. After the direct hedge delay expires, the stalled direct socket is closed. Cloudflare-backed web traffic gets at most one fixed CF Anycast attempt; if it fails, configured ProxyIP entries are tried in order, followed by the configured SOCKS/HTTP(S) proxy. Cloudflare Anycast decides the physical PoP, so the fixed address is not a guaranteed Singapore-only IP.</div></section>
<section class="card wide"><h3>Routing and preferred edges</h3><label>ProxyIP fallbacks</label><textarea id="proxyIp" placeholder="host:443#name, [IPv6]:443#name"></textarea><label>Preferred subscription endpoints</label><textarea id="preferred"></textarea><label>Routes</label><textarea id="routes" placeholder="*.example.com=adaptive; *.internal=block"></textarea></section>
<section class="card wide"><h3>Switches</h3><div class="row"><label class="check"><input id="enableWs" type="checkbox"> WebSocket</label><label class="check"><input id="enableXhttp" type="checkbox"> XHTTP</label><label class="check"><input id="blockPrivate" type="checkbox"> Block private targets</label><label class="check"><input id="disableIpv6" type="checkbox"> Disable IPv6</label><label class="check"><input id="allowPathOverride" type="checkbox"> Allow path overrides</label></div></section></div>
<div class="actions"><button id="saveButton" onclick="save()">Save to KV</button><button id="reloadButton" class="secondary" onclick="load()">Reload</button><span class="status" id="status"></span></div></div>
<script>
const adminConfigured=${adminConfigured ? 'true' : 'false'};
let token='';
const status=document.getElementById('status');
const saveButton=document.getElementById('saveButton');
const reloadButton=document.getElementById('reloadButton');
const ids=['uuid','path','trojanPassword','subscriptionName','outbound','mode','dialRace','hedgeDelayMs','firstByteTimeoutMs','edgeFirstByteTimeoutMs','adaptiveEdge','proxyIp','preferred','routes','enableWs','enableXhttp','blockPrivate','disableIpv6','allowPathOverride'];
const numericIds=new Set(['dialRace','hedgeDelayMs','firstByteTimeoutMs','edgeFirstByteTimeoutMs']);
if(adminConfigured){token=sessionStorage.getItem('unisol-admin')||prompt('Admin password')||'';if(token)sessionStorage.setItem('unisol-admin',token)}else{saveButton.disabled=true;reloadButton.disabled=true;status.textContent='Set ADMIN in Worker variables, then redeploy.'}
function auth(){return {'Authorization':'Bearer '+token,'Content-Type':'application/json'}}
function value(id){const e=document.getElementById(id);if(e.type==='checkbox')return e.checked;if(numericIds.has(id))return Number(e.value)||0;return e.value}
function set(id,v){const e=document.getElementById(id);if(e.type==='checkbox')e.checked=!!v;else if(id==='routes'&&Array.isArray(v))e.value=v.map(x=>x.pattern+'='+x.policy).join('; ');else if(Array.isArray(v))e.value=v.map(x=>typeof x==='string'?x:(x.host+(x.port?':'+x.port:'')+(x.name?'#'+x.name:''))).join(', ');else e.value=v??''}
async function load(){if(!adminConfigured)return;status.textContent='Loading…';const r=await fetch('/api/config',{headers:auth()});if(r.status===401){sessionStorage.removeItem('unisol-admin');token=prompt('Admin password')||'';if(token){sessionStorage.setItem('unisol-admin',token);status.textContent='Password updated. Press Reload again.'}else status.textContent='Unauthorized';return}const j=await r.json();for(const id of ids)set(id,j[id]);status.textContent=j.kvEnabled?'Loaded from Worker/KV':'Loaded; KV is not bound'}
async function save(){if(!adminConfigured)return;status.textContent='Saving…';const body={};for(const id of ids)body[id]=value(id);const r=await fetch('/api/config',{method:'POST',headers:auth(),body:JSON.stringify(body)});const j=await r.json().catch(()=>({}));if(r.status===401){sessionStorage.removeItem('unisol-admin');status.textContent='Unauthorized. Reload and enter the ADMIN password.';return}status.textContent=r.ok?'Saved. New connections use it immediately.':(j.error||'Save failed')}
if(adminConfigured)load();
</script></body></html>`;
}

export function configApiResponse(config, kvEnabled) {
  return { ...safeConfigView(config), trojanPassword: config.trojanPassword, outbound: config.outboundRaw, kvEnabled };
}

export function isAdminAuthorized(request, admin) {
  if (!admin) return false;
  const header = request.headers.get('Authorization') || '';
  return header === `Bearer ${admin}`;
}
