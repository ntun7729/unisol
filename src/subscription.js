import { isIpv6 } from './core.js';

export function buildNodes(config, requestUrl) {
  const url = requestUrl instanceof URL ? requestUrl : new URL(requestUrl);
  const edgeHost = url.hostname;
  const endpoints = (config.preferred?.length ? config.preferred : [{ host: edgeHost, port: 443, name: 'Edge' }])
    .filter(item => !(config.disableIpv6 && isIpv6(item.host)));
  const nodes = [];
  let index = 0;

  for (const endpoint of endpoints) {
    index += 1;
    const baseName = `${config.subscriptionName}-${endpoint.name || index}`;
    if (config.enableWs) {
      nodes.push({
        protocol: 'vless', transport: 'ws', name: `${baseName}-WS`,
        server: endpoint.host, port: endpoint.port || 443, host: edgeHost,
        path: `/${config.path}/ws`, uuid: config.uuid
      });
      if (config.trojanPassword) nodes.push({
        protocol: 'trojan', transport: 'ws', name: `${baseName}-Trojan-WS`,
        server: endpoint.host, port: endpoint.port || 443, host: edgeHost,
        path: `/${config.path}/ws`, password: config.trojanPassword
      });
    }
    if (config.enableXhttp) {
      nodes.push({
        protocol: 'vless', transport: 'xhttp', name: `${baseName}-XHTTP`,
        server: endpoint.host, port: endpoint.port || 443, host: edgeHost,
        path: `/${config.path}/xhttp`, uuid: config.uuid
      });
      if (config.trojanPassword) nodes.push({
        protocol: 'trojan', transport: 'xhttp', name: `${baseName}-Trojan-XHTTP`,
        server: endpoint.host, port: endpoint.port || 443, host: edgeHost,
        path: `/${config.path}/xhttp`, password: config.trojanPassword
      });
    }
  }
  return nodes;
}

export function renderSubscription(config, requestUrl, format = 'base64') {
  if (!config.uuid) throw new Error('UUID is not configured');
  const nodes = buildNodes(config, requestUrl);
  const normalized = String(format || 'base64').toLowerCase();
  if (['plain', 'raw', 'text'].includes(normalized)) return { body: nodes.map(nodeToUri).join('\n'), contentType: 'text/plain; charset=utf-8' };
  if (['clash', 'clashmeta', 'meta'].includes(normalized)) return { body: clashYaml(nodes), contentType: 'text/yaml; charset=utf-8' };
  if (['singbox', 'sing-box'].includes(normalized)) return { body: JSON.stringify(singBox(nodes), null, 2), contentType: 'application/json; charset=utf-8' };
  const text = nodes.map(nodeToUri).join('\n');
  return { body: base64Utf8(text), contentType: 'text/plain; charset=utf-8' };
}

export function nodeToUri(node) {
  const server = node.server.includes(':') ? `[${node.server}]` : node.server;
  const params = new URLSearchParams();
  params.set('security', 'tls');
  params.set('sni', node.host);
  params.set('fp', 'chrome');
  params.set('type', node.transport);
  params.set('host', node.host);
  params.set('path', node.path);
  if (node.transport === 'xhttp') params.set('mode', 'stream-one');
  if (node.protocol === 'vless') {
    params.set('encryption', 'none');
    return `vless://${node.uuid}@${server}:${node.port}?${params.toString()}#${encodeURIComponent(node.name)}`;
  }
  return `trojan://${encodeURIComponent(node.password)}@${server}:${node.port}?${params.toString()}#${encodeURIComponent(node.name)}`;
}

function clashYaml(nodes) {
  const compatible = nodes.filter(node => node.transport === 'ws');
  const lines = ['mixed-port: 7890', 'allow-lan: true', 'mode: rule', 'log-level: info', 'proxies:'];
  for (const node of compatible) {
    lines.push(`  - name: ${yamlString(node.name)}`);
    lines.push(`    type: ${node.protocol}`);
    lines.push(`    server: ${yamlString(node.server)}`);
    lines.push(`    port: ${node.port}`);
    if (node.protocol === 'vless') {
      lines.push(`    uuid: ${yamlString(node.uuid)}`);
      lines.push('    udp: true');
    } else lines.push(`    password: ${yamlString(node.password)}`);
    lines.push('    tls: true');
    lines.push(`    servername: ${yamlString(node.host)}`);
    lines.push('    network: ws');
    lines.push('    ws-opts:');
    lines.push(`      path: ${yamlString(node.path)}`);
    lines.push('      headers:');
    lines.push(`        Host: ${yamlString(node.host)}`);
  }
  lines.push('proxy-groups:');
  lines.push('  - name: "Unisol"');
  lines.push('    type: select');
  lines.push('    proxies:');
  for (const node of compatible) lines.push(`      - ${yamlString(node.name)}`);
  lines.push('rules:');
  lines.push('  - MATCH,Unisol');
  return lines.join('\n');
}

function singBox(nodes) {
  const compatible = nodes.filter(node => node.transport === 'ws');
  const outbounds = compatible.map(node => {
    const outbound = {
      type: node.protocol,
      tag: node.name,
      server: node.server,
      server_port: node.port,
      tls: { enabled: true, server_name: node.host },
      transport: { type: 'ws', path: node.path, headers: { Host: node.host } }
    };
    if (node.protocol === 'vless') outbound.uuid = node.uuid;
    else outbound.password = node.password;
    return outbound;
  });
  return {
    log: { level: 'info' },
    inbounds: [{ type: 'mixed', tag: 'mixed-in', listen: '127.0.0.1', listen_port: 2080 }],
    outbounds: [...outbounds, { type: 'direct', tag: 'direct' }],
    route: { final: outbounds[0]?.tag || 'direct' }
  };
}

function yamlString(value) {
  return JSON.stringify(String(value ?? ''));
}

function base64Utf8(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
