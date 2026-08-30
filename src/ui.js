import { safeConfigView } from './core.js';

export function cafePage() {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Unisol Coffee</title><style>
:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;font-family:system-ui,-apple-system,Segoe UI,sans-serif;background:#16120f;color:#f4eadf;min-height:100vh;display:grid;place-items:center}.card{width:min(680px,92vw);padding:48px;border:1px solid #4d3829;border-radius:28px;background:linear-gradient(145deg,#211914,#17110e);box-shadow:0 24px 80px #0008}.mark{font-size:52px}h1{font-size:42px;margin:14px 0 8px}.muted{color:#bca895;line-height:1.65}.pill{display:inline-block;margin-top:22px;padding:9px 14px;border-radius:999px;background:#2c211a;color:#d7c0aa;font-size:13px;letter-spacing:.08em;text-transform:uppercase}</style></head>
<body><main class="card"><div class="mark">☕</div><h1>Unisol Coffee</h1><p class="muted">Small-batch coffee, quiet tables, and a simple edge service behind the counter.</p><span class="pill">Open daily</span></main></body></html>`;
}

export function adminPage() {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Unisol Admin</title>
<style>:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;background:#0b0d10;color:#e8edf2;font:14px system-ui,-apple-system,Segoe UI,sans-serif}.wrap{max-width:980px;margin:auto;padding:28px}h1{font-size:30px;margin:0 0 6px}.sub{color:#8e9aa7;margin-bottom:24px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:14px}.card{background:#11151a;border:1px solid #252c34;border-radius:16px;padding:18px}.wide{grid-column:1/-1}label{display:block;color:#aeb8c2;margin:10px 0 6px}input,select,textarea{width:100%;padding:11px 12px;border-radius:9px;border:1px solid #303944;background:#0c1014;color:#edf3f8}textarea{min-height:96px;resize:vertical}.row{display:flex;gap:12px;flex-wrap:wrap}.check{display:flex;align-items:center;gap:8px;margin:8px 14px 8px 0}.check input{width:auto}button{border:0;border-radius:10px;padding:11px 16px;font-weight:700;cursor:pointer;background:#e9eef3;color:#11161b}.secondary{background:#252c34;color:#e8edf2}.actions{display:flex;gap:10px;align-items:center;margin-top:18px}.status{color:#9fb0c0}</style></head>
<body><div class="wrap"><h1>Unisol</h1><div class="sub">Live Worker configuration. Secrets stay in this browser session and are sent only as an Authorization header.</div>
<div class="grid"><section class="card"><h3>Identity</h3><label>UUID v4</label><input id="uuid"><label>Ingress path</label><input id="path"><label>Trojan password</label><input id="trojanPassword" type="password"><label>Subscription name</label><input id="subscriptionName"></section>
<section class="card"><h3>Outbound</h3><label>Proxy</label><input id="outbound" placeholder="socks5://user:pass@host:1080"><label>Mode</label><select id="mode"><option>proxy-first</option><option>direct-first</option><option>proxy-only</option><option>direct</option></select><label>Dial race</label><input id="dialRace" type="number" min="1" max="4"></section>
<section class="card wide"><h3>Routing and preferred edges</h3><label>ProxyIP fallbacks</label><textarea id="proxyIp" placeholder="host:443#name, [IPv6]:443#name"></textarea><label>Preferred subscription endpoints</label><textarea id="preferred"></textarea><label>Routes</label><textarea id="routes" placeholder="*.example.com=proxy-only; *.internal=block"></textarea></section>
<section class="card wide"><h3>Switches</h3><div class="row"><label class="check"><input id="enableWs" type="checkbox"> WebSocket</label><label class="check"><input id="enableXhttp" type="checkbox"> XHTTP</label><label class="check"><input id="blockPrivate" type="checkbox"> Block private targets</label><label class="check"><input id="disableIpv6" type="checkbox"> Disable IPv6</label><label class="check"><input id="allowPathOverride" type="checkbox"> Allow path overrides</label></div></section></div>
<div class="actions"><button onclick="save()">Save to KV</button><button class="secondary" onclick="load()">Reload</button><span class="status" id="status"></span></div></div>
<script>
let token=sessionStorage.getItem('unisol-admin')||prompt('Admin password')||'';if(token)sessionStorage.setItem('unisol-admin',token);
const ids=['uuid','path','trojanPassword','subscriptionName','outbound','mode','dialRace','proxyIp','preferred','routes','enableWs','enableXhttp','blockPrivate','disableIpv6','allowPathOverride'];
function auth(){return {'Authorization':'Bearer '+token,'Content-Type':'application/json'}}
function value(id){const e=document.getElementById(id);return e.type==='checkbox'?e.checked:e.value}
function set(id,v){const e=document.getElementById(id);if(e.type==='checkbox')e.checked=!!v;else if(id==='routes'&&Array.isArray(v))e.value=v.map(x=>x.pattern+'='+x.policy).join('; ');else if(Array.isArray(v))e.value=v.map(x=>typeof x==='string'?x:(x.host+(x.port?':'+x.port:'')+(x.name?'#'+x.name:''))).join(', ');else e.value=v??''}
async function load(){status.textContent='Loading…';const r=await fetch('/api/config',{headers:auth()});if(r.status===401){sessionStorage.removeItem('unisol-admin');status.textContent='Unauthorized';return}const j=await r.json();for(const id of ids)set(id,j[id]);status.textContent=j.kvEnabled?'Loaded from Worker/KV':'Loaded; KV is not bound'}
async function save(){status.textContent='Saving…';const body={};for(const id of ids)body[id]=value(id);body.dialRace=Number(body.dialRace)||2;const r=await fetch('/api/config',{method:'POST',headers:auth(),body:JSON.stringify(body)});const j=await r.json().catch(()=>({}));status.textContent=r.ok?'Saved. New connections use it immediately.':(j.error||'Save failed')}
load();
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
