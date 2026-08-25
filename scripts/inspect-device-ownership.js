'use strict';

// Read-only production ownership diagnostic. It deliberately never prints
// email addresses, password hashes, tokens, or the database connection URL.
const fs = require('fs');

function readEnv(file) {
  const values = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const separator = line.indexOf('=');
    if (separator > 0 && line[0] !== '#') {
      const key = line.slice(0, separator).trim();
      let value = line.slice(separator + 1).trim();
      if (value.startsWith('"') && value.endsWith('"')) {
        try { value = JSON.parse(value); } catch { value = value.slice(1, -1); }
      } else if (value.startsWith("'") && value.endsWith("'")) {
        value = value.slice(1, -1);
      }
      values[key] = value;
    }
  }
  return values;
}

function maskName(value) {
  const chars = [...String(value || '').trim()];
  if (!chars.length) return '알 수 없음';
  return `${chars[0]}${'*'.repeat(Math.min(Math.max(chars.length - 1, 1), 3))}`;
}

async function main() {
  const env = readEnv(process.argv[2] || '.env');
  const supabaseUrl = env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SECRET_KEY;
  if (!supabaseUrl || !serviceKey) throw new Error('Supabase 운영 조회 환경변수가 비어 있습니다.');
  const query = async (table, select, order = 'created_at.asc') => {
    const response = await fetch(`${supabaseUrl}/rest/v1/${table}?select=${encodeURIComponent(select)}&order=${encodeURIComponent(order)}`, {
      headers: { apikey: serviceKey, authorization: `Bearer ${serviceKey}` },
    });
    if (!response.ok) throw new Error(`${table} 조회 실패 (${response.status})`);
    return response.json();
  };
  const [users, wardrobes, gateways, hangers, ownership] = await Promise.all([
    query('app_users', 'id,name'),
    query('wardrobes', 'id,user_id'),
    query('gateways', 'gateway_id,wardrobe_id,name,gateway_number,state,last_seen,payload'),
    query('hangers', 'hanger_id,wardrobe_id,gateway_id,alias,hanger_number,state,tag_uid,last_seen'),
    query('device_ownership', 'device_kind,device_id,wardrobe_id,gateway_id,updated_at', 'updated_at.asc'),
  ]);
  const ownerByUser = new Map(users.map(user => [user.id, maskName(user.name)]));
  const ownerByWardrobe = new Map(wardrobes.map(wardrobe => [wardrobe.id, ownerByUser.get(wardrobe.user_id) || '알 수 없음']));
    const result = {
      databaseHost: new URL(supabaseUrl).hostname,
      counts: {
        users: users.length,
        wardrobes: wardrobes.length,
        gateways: gateways.length,
        hangers: hangers.length,
        ownershipRecords: ownership.length,
      },
      users: users.map(user => ({ userId: `${user.id.slice(0, 12)}…`, name: maskName(user.name) })),
      gateways: gateways.map(gateway => ({
        gatewayId: gateway.gateway_id,
        owner: gateway.wardrobe_id ? ownerByWardrobe.get(gateway.wardrobe_id) || '고아 소유권' : '미등록',
        number: gateway.gateway_number,
        state: gateway.state,
        lastSeen: gateway.last_seen,
        resetPending: gateway.payload?.resetPending || null,
      })),
      hangers: hangers.map(hanger => ({
        hangerId: hanger.hanger_id,
        owner: hanger.wardrobe_id ? ownerByWardrobe.get(hanger.wardrobe_id) || '고아 소유권' : '미등록',
        gatewayId: hanger.gateway_id || null,
        number: hanger.hanger_number,
        state: hanger.state,
        tag: hanger.tag_uid ? '감지됨' : '없음',
        lastSeen: hanger.last_seen,
      })),
      authoritativeOwnership: ownership.map(item => ({
        kind: item.device_kind,
        deviceId: item.device_id,
        owner: item.wardrobe_id ? ownerByWardrobe.get(item.wardrobe_id) || '고아 소유권' : '삭제됨(미등록)',
        gatewayId: item.gateway_id || null,
        updatedAt: item.updated_at,
      })),
    };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch(error => {
  console.error(`DB_QUERY_ERROR=${error.message}`);
  process.exitCode = 1;
});
