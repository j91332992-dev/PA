'use strict';

// JSON is kept as the safe local-development mode.  Set DATABASE_URL to a
// Supabase/PostgreSQL connection string to use durable cloud storage instead.
const fs=require('fs');
const path=require('path');
const {Pool}=require('pg');

function jsonStorage(file, initial){
  fs.mkdirSync(path.dirname(file),{recursive:true});
  let writes=Promise.resolve();
  function load(){
    if(!fs.existsSync(file))return initial();
    try{return {...initial(),...JSON.parse(fs.readFileSync(file,'utf8'))};}
    catch{
      fs.copyFileSync(file,`${file}.corrupt-${Date.now()}`);
      return initial();
    }
  }
  function save(data){
    const text=JSON.stringify(data,null,2),tmp=`${file}.tmp`;
    const job=writes.catch(()=>{}).then(()=>{
      fs.writeFileSync(tmp,text);
      if(fs.existsSync(file))fs.copyFileSync(file,`${file}.bak`);
      try{fs.renameSync(tmp,file);}
      catch(error){
        fs.copyFileSync(tmp,file);
        try{fs.rmSync(tmp,{force:true});}catch{}
        console.warn(`[SAVE] safe overwrite: ${error.code||error.message}`);
      }
    });
    writes=job.catch(error=>console.error(`[SAVE] ${error.message}`));
    return job;
  }
  return {
    mode:'json',load:async()=>load(),reload:async()=>load(),save,close:async()=>{},
    syncDeviceOwnership:async()=>{},
    claimDeviceOwnership:async()=>({ok:true}),
    refreshCommands:async()=>{},
    releaseGatewayOwnership:async()=>({ok:true,releasedHangerIds:[]}),
    releaseHangerOwnership:async()=>({ok:true}),
  };
}

function postgresStorage(connectionString, initial){
  const localDatabase=/localhost|127\.0\.0\.1/.test(connectionString);
  let normalizedConnectionString=connectionString;
  if(!localDatabase){
    const parsed=new URL(connectionString);
    // pg-connection-string lets an sslmode query parameter replace the
    // explicit TLS object. Remove it so rejectUnauthorized is deterministic.
    parsed.searchParams.delete('sslmode');
    normalizedConnectionString=parsed.toString();
  }
  const pool=new Pool({
    connectionString:normalizedConnectionString,
    // Hosted Supabase endpoints require TLS. Local PostgreSQL URLs keep their
    // own SSL settings instead of silently disabling certificate checks.
    ssl:localDatabase?undefined:{rejectUnauthorized:false},
    // Serverless instances can multiply quickly. A small pool prevents one
    // mobile dashboard's polling from exhausting the shared Supabase pool.
    max:Number(process.env.PG_POOL_MAX||2),
    connectionTimeoutMillis:Number(process.env.PG_CONNECTION_TIMEOUT_MS||20000),
    keepAlive:true,
  });
  const scalar={
    users:['id','email','name','passwordHash','role','lastLoginAt','createdAt'],
    wardrobes:['id','userId','name','createdAt'],
    gateways:['gatewayId','wardrobeId','name','customName','gatewayNumber','state','lastSeen','channel','firmwareVersion','createdAt'],
    hangers:['hangerId','wardrobeId','gatewayId','alias','customName','hangerNumber','state','reportedState','tagUid','lastSeen','lastSequence','bootId','channel','rssi','errorFlags','firmwareVersion','createdAt'],
    garments:['id','wardrobeId','createdBy','tagUid','name','category','color','season','brand','memo','imageUrl','originalImagePath','processedImagePath','imageProcessingStatus','classification','classificationConfidence','processingError','currentState','currentHanger','lastSeen','createdAt'],
    commands:['id','numericId','wardrobeId','requestedBy','command','targets','durationMs','status','acknowledgements','createdAt','expiresAt','sentAt'],
    events:['id','wardrobeId','type','severity','payload','at'],
  };
  const table={users:'app_users',wardrobes:'wardrobes',gateways:'gateways',hangers:'hangers',garments:'garments',commands:'device_commands',events:'wardrobe_events'};
  let ownershipSchemaReady = false;
  let ownershipSeeded = false;
  async function ensureDeviceOwnershipSchema(client) {
    if (ownershipSchemaReady) return;
    await client.query(`
      create table if not exists device_ownership (
        device_kind text not null check (device_kind in ('gateway','hanger')),
        device_id text not null,
        wardrobe_id text,
        gateway_id text,
        release_blocked boolean not null default false,
        updated_at timestamptz not null default now(),
        primary key (device_kind, device_id)
      )
    `);
    await client.query('alter table device_ownership add column if not exists release_blocked boolean not null default false');
    await client.query('create index if not exists device_ownership_wardrobe_idx on device_ownership(wardrobe_id)');
    await client.query(`
      create table if not exists device_ownership_meta (
        singleton boolean primary key default true check (singleton),
        migrated_at timestamptz not null default now()
      )
    `);
    ownershipSchemaReady = true;
  }
  async function seedDeviceOwnership(client) {
    if (ownershipSeeded) return;
    // One atomic migration captures both claimed and already-released devices.
    // It never runs again, so a stale legacy instance cannot later seed an old
    // owner after the deployment has established the ownership authority.
    await client.query(`
      with first_run as (
        insert into device_ownership_meta(singleton) values(true)
        on conflict(singleton) do nothing returning singleton
      ), candidates as (
        select 'gateway'::text as device_kind,gateway_id as device_id,wardrobe_id,null::text as gateway_id from gateways
        union all
        select 'hanger'::text,hanger_id,wardrobe_id,gateway_id from hangers
      )
      insert into device_ownership(device_kind,device_id,wardrobe_id,gateway_id)
      select device_kind,device_id,wardrobe_id,gateway_id from candidates
      where exists(select 1 from first_run)
      on conflict(device_kind,device_id) do nothing
    `);
    ownershipSeeded = true;
  }
  function enforceDeviceOwnership(data, rows) {
    const ownership=new Map(rows.map(row=>[`${row.device_kind}:${row.device_id}`,row]));
    // An unclaimed hanger still needs its physical gateway link so the
    // owner's "detected new hangers" list can show it. Ownership rows are
    // authoritative across Vercel instances; when an old instance crosses an
    // ownership boundary, also restore the latest persisted name and number.
    const gatewayOwners=new Map(rows.filter(row=>row.device_kind==='gateway').map(row=>[row.device_id,row.wardrobe_id||null]));
    for(const gateway of data.gateways||[]){
      const authoritative=ownership.get(`gateway:${gateway.gatewayId}`);
      const previousWardrobeId=gateway.wardrobeId||null;
      gateway.wardrobeId=authoritative?.wardrobe_id||null;
      if(gateway.wardrobeId&&previousWardrobeId!==gateway.wardrobeId){
        gateway.gatewayNumber=authoritative.gateway_number??gateway.gatewayNumber;
        gateway.customName=authoritative.gateway_custom_name??'';
        gateway.name=authoritative.gateway_name||gateway.name;
      }
      if(!gateway.wardrobeId){gateway.gatewayNumber=null;gateway.customName='';}
    }
    for(const hanger of data.hangers||[]){
      const authoritative=ownership.get(`hanger:${hanger.hangerId}`);
      const previousWardrobeId=hanger.wardrobeId||null;
      hanger.wardrobeId=authoritative?.wardrobe_id||null;
      const candidateGatewayId=authoritative
        ? (authoritative.gateway_id || hanger.gatewayId || null)
        : (hanger.gatewayId||null);
      const gatewayIsOwned=!!candidateGatewayId && !!gatewayOwners.get(candidateGatewayId);
      hanger.gatewayId=hanger.wardrobeId
        ? candidateGatewayId
        : (gatewayIsOwned ? candidateGatewayId : null);
      if(hanger.wardrobeId&&previousWardrobeId!==hanger.wardrobeId){
        hanger.hangerNumber=authoritative.hanger_number??hanger.hangerNumber;
        hanger.customName=authoritative.hanger_custom_name??'';
        hanger.alias=authoritative.hanger_alias||hanger.alias;
      }
      if(!hanger.wardrobeId){hanger.hangerNumber=null;hanger.customName='';}
    }
  }
  async function readAndEnforceDeviceOwnership(client,data){
    await ensureDeviceOwnershipSchema(client);
    await seedDeviceOwnership(client);
    const result=await client.query(`
      select ownership.device_kind,ownership.device_id,ownership.wardrobe_id,ownership.gateway_id,
        hanger.hanger_number,hanger.alias as hanger_alias,hanger.custom_name as hanger_custom_name,
        gateway.gateway_number,gateway.name as gateway_name,gateway.custom_name as gateway_custom_name
      from device_ownership ownership
      left join hangers hanger on ownership.device_kind='hanger' and hanger.hanger_id=ownership.device_id
      left join gateways gateway on ownership.device_kind='gateway' and gateway.gateway_id=ownership.device_id
    `);
    enforceDeviceOwnership(data,result.rows);
    return result.rows;
  }
  async function runGarmentsMigration(client) {
    for (const statement of [
      "alter table garments add column if not exists category text not null default ''",
      "alter table garments add column if not exists color text not null default ''",
      "alter table garments add column if not exists season text not null default ''",
      "alter table garments add column if not exists brand text not null default ''",
      "alter table garments add column if not exists memo text not null default ''",
      "alter table garments add column if not exists image_url text not null default ''",
      "alter table garments add column if not exists current_state text not null default 'OUT'",
      'alter table garments add column if not exists current_hanger text',
      'alter table garments add column if not exists last_seen timestamptz',
      "alter table garments add column if not exists payload jsonb not null default '{}'::jsonb",
    ]) await client.query(statement);
  }
  async function load(){
    const client=await pool.connect();
    try{
      const check=await client.query("select to_regclass('public.app_users') as users, to_regclass('public.wardrobes') as wardrobes");
      if(!check.rows[0].users||!check.rows[0].wardrobes)throw new Error('Supabase 스키마가 없습니다. supabase/schema.sql을 먼저 실행하세요.');
      const out=initial();
      for(const key of Object.keys(table)){
        // Events are timestamped with `at`; all other persisted records use
        // `created_at`. Keep the restore order deterministic in both cases.
        const orderColumn=key==='events'?'at':'created_at';
        const bounded=key==='events'
          ? ' order by at desc limit 300'
          : key==='commands'
            ? ' order by created_at desc limit 300'
            : ` order by ${orderColumn} asc`;
        const result=await client.query(`select payload from ${table[key]}${bounded}`);
        out[key]=result.rows.map(row=>row.payload||{});
      }
      await readAndEnforceDeviceOwnership(client,out);
      // The one-time importer intentionally runs only against an empty cloud
      // database. It never replaces an existing friend's data.
      const seed=process.env.SEED_JSON_PATH;
      if(!out.users.length&&seed&&fs.existsSync(seed)){
        console.log(`[STORAGE] importing empty cloud DB from ${seed}`);
        const imported={...initial(),...JSON.parse(fs.readFileSync(seed,'utf8'))};
        // Persist immediately. A v5 seed does not need a schema migration, so
        // relying on the caller's migration flag would never write it.
        await persist(imported);
        return imported;
      }
      const hydrated={...out,schemaVersion:5};
      baselineByData.set(hydrated,clone(hydrated));
      return hydrated;
    }finally{client.release();}
  }
  const clone = value => JSON.parse(JSON.stringify(value));
  const baselineByData = new WeakMap();
  const recordKey = {
    users: value => value.id,
    wardrobes: value => value.id,
    gateways: value => value.gatewayId,
    hangers: value => value.hangerId,
    garments: value => value.id,
    commands: value => value.id,
    events: value => value.id,
  };
  const changedRecords = (key, current, baseline) => {
    const before = new Map((baseline || []).map(value => [recordKey[key](value), JSON.stringify(value)]));
    return (current || []).filter(value => before.get(recordKey[key](value)) !== JSON.stringify(value));
  };
  const removedRecordIds = (key, current, baseline) => {
    const present = new Set((current || []).map(recordKey[key]));
    return (baseline || []).map(recordKey[key]).filter(value => !present.has(value));
  };

  async function insertBatch(client, tableName, columns, rows, mapRow, conflictColumn = columns[0], batchSize = 100) {
    if (!rows || rows.length === 0) return;
    const colList = columns.join(',');
    const colCount = columns.length;
    const updates = columns.filter(column => column !== conflictColumn).map(column => `${column}=excluded.${column}`).join(',');
    for (let i = 0; i < rows.length; i += batchSize) {
      const chunk = rows.slice(i, i + batchSize);
      const valuePlaceholders = [];
      const flatParams = [];
      for (let r = 0; r < chunk.length; r++) {
        const rowVals = mapRow(chunk[r]);
        const placeholders = [];
        for (let c = 0; c < colCount; c++) {
          placeholders.push(`$${flatParams.length + 1}`);
          flatParams.push(rowVals[c]);
        }
        valuePlaceholders.push(`(${placeholders.join(',')})`);
      }
      const query = `insert into ${tableName} (${colList}) values ${valuePlaceholders.join(',')} on conflict (${conflictColumn}) do update set ${updates}`;
      await client.query(query, flatParams);
    }
  }

  async function deleteRemoved(client, tableName, column, ids) {
    if (!ids.length) return;
    await client.query(`delete from ${tableName} where ${column} = any($1::text[])`, [ids]);
  }

  async function persist(data, baseline = initial()) {
    const client = await pool.connect();
    try {
      await client.query('begin');
      // Ownership has its own authority table. Reconcile it before calculating
      // the delta so a stale serverless instance cannot reclaim a released rod.
      await readAndEnforceDeviceOwnership(client,data);
      const changed = key => changedRecords(key, data[key], baseline[key]);
      const removed = key => removedRecordIds(key, data[key], baseline[key]);
      // Delete only records this request actually removed from the version it
      // loaded. Never truncate shared tables: other accounts stay untouched.
      await deleteRemoved(client, 'wardrobe_events', 'id', removed('events'));
      await deleteRemoved(client, 'device_commands', 'id', removed('commands'));
      await deleteRemoved(client, 'garments', 'id', removed('garments'));
      await deleteRemoved(client, 'hangers', 'hanger_id', removed('hangers'));
      await deleteRemoved(client, 'gateways', 'gateway_id', removed('gateways'));
      await deleteRemoved(client, 'wardrobes', 'id', removed('wardrobes'));
      await deleteRemoved(client, 'app_users', 'id', removed('users'));
      const asJson = value => JSON.stringify(value ?? {});

      await insertBatch(client, 'app_users', ['id', 'email', 'name', 'password_hash', 'role', 'last_login_at', 'created_at', 'payload'], changed('users'), u => [u.id, u.email, u.name, u.passwordHash, u.role || 'user', u.lastLoginAt || null, u.createdAt, asJson(u)]);
      await insertBatch(client, 'wardrobes', ['id', 'user_id', 'name', 'created_at', 'payload'], changed('wardrobes'), w => [w.id, w.userId, w.name, w.createdAt, asJson(w)]);
      await insertBatch(client, 'gateways', ['gateway_id', 'wardrobe_id', 'name', 'custom_name', 'gateway_number', 'state', 'last_seen', 'channel', 'firmware_version', 'created_at', 'payload'], changed('gateways'), g => [g.gatewayId, g.wardrobeId, g.name || '새 옷봉', g.customName || '', g.gatewayNumber || null, g.state || null, g.lastSeen || null, g.channel || null, g.firmwareVersion || null, g.createdAt || new Date().toISOString(), asJson(g)]);
      const changedHangers=changed('hangers');
      // Existing rows can need a number swap (for example 1<->2). PostgreSQL
      // checks a non-deferrable unique index during each row update, so clear
      // only the changed rows inside this transaction before assigning their
      // final unique numbers. No row or ownership data is removed.
      if(changedHangers.length)await client.query(
        'update hangers set hanger_number=null where hanger_id=any($1::text[])',
        [changedHangers.map(h=>h.hangerId)],
      );
      await insertBatch(client, 'hangers', ['hanger_id', 'wardrobe_id', 'gateway_id', 'alias', 'custom_name', 'hanger_number', 'state', 'reported_state', 'tag_uid', 'last_seen', 'last_sequence', 'boot_id', 'channel', 'rssi', 'error_flags', 'firmware_version', 'created_at', 'payload'], changedHangers, h => [h.hangerId, h.wardrobeId, h.gatewayId || null, h.alias || '', h.customName || '', h.hangerNumber || null, h.state || null, h.reportedState || null, h.tagUid || null, h.lastSeen || null, h.lastSequence ?? -1, h.bootId || null, h.channel || null, h.rssi || null, h.errorFlags || null, h.firmwareVersion || null, h.createdAt || new Date().toISOString(), asJson(h)]);
      await insertBatch(client, 'garments', ['id', 'wardrobe_id', 'created_by', 'tag_uid', 'name', 'category', 'color', 'season', 'brand', 'memo', 'image_url', 'original_image_path', 'processed_image_path', 'image_processing_status', 'classification', 'classification_confidence', 'processing_error', 'current_state', 'current_hanger', 'last_seen', 'created_at', 'payload'], changed('garments'), g => [g.id, g.wardrobeId, g.createdBy || null, g.tagUid, g.name, g.category || '', g.color || '', g.season || '', g.brand || '', g.memo || '', g.imageUrl || '', g.originalImagePath || '', g.processedImagePath || '', g.imageProcessingStatus || 'ready', asJson(g.classification || {}), asJson(g.classificationConfidence || {}), g.processingError || '', g.currentState || 'OUT', g.currentHanger || null, g.lastSeen || null, g.createdAt || new Date().toISOString(), asJson(g)]);
      for (const c of changed('commands')) await client.query(`
        insert into device_commands(id,numeric_id,wardrobe_id,requested_by,command,targets,duration_ms,status,acknowledgements,created_at,expires_at,sent_at,payload)
        values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
        on conflict(id) do update set
          status=excluded.status,acknowledgements=excluded.acknowledgements,sent_at=coalesce(excluded.sent_at,device_commands.sent_at),payload=excluded.payload
        where (case excluded.status when 'QUEUED' then 0 when 'SENT' then 1 when 'PARTIAL' then 2 when 'ACKED' then 3 when 'TIMEOUT' then 3 when 'CANCELLED' then 4 else 0 end)
           >= (case device_commands.status when 'QUEUED' then 0 when 'SENT' then 1 when 'PARTIAL' then 2 when 'ACKED' then 3 when 'TIMEOUT' then 3 when 'CANCELLED' then 4 else 0 end)
      `,[c.id,c.numericId,c.wardrobeId,c.requestedBy||null,c.command,asJson(c.targets||[]),c.durationMs||0,c.status,asJson(c.acknowledgements||{}),c.createdAt,c.expiresAt||null,c.sentAt||null,asJson(c)]);
      await insertBatch(client, 'wardrobe_events', ['id', 'wardrobe_id', 'type', 'severity', 'payload', 'at'], changed('events'), e => [e.id, e.wardrobeId || null, e.type, e.severity || 'info', asJson(e), e.at]);
      await client.query('commit');
    } catch (error) {
      await client.query('rollback').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  let isSaving = false;
  let pendingSnapshot = null;
  let pendingWaiters = [];

  async function runSaveLoop() {
    if (isSaving) return;
    isSaving = true;
    while (pendingSnapshot) {
      const pending = pendingSnapshot;
      const waiters = pendingWaiters;
      pendingSnapshot = null;
      pendingWaiters = [];
      try {
        await persist(pending.snapshot, pending.baseline);
        baselineByData.set(pending.source, clone(pending.snapshot));
        waiters.forEach(w => w.resolve());
      } catch (err) {
        waiters.forEach(w => w.reject(err));
      }
    }
    isSaving = false;
  }

  function save(data) {
    const snapshot = clone(data);
    const baseline = clone(baselineByData.get(data) || initial());
    pendingSnapshot = {snapshot, baseline, source: data};
    return new Promise((resolve, reject) => {
      pendingWaiters.push({ resolve, reject });
      runSaveLoop().catch(() => {});
    });
  }
  async function refreshCommands(data){
    const client=await pool.connect();
    try{
      const result=await client.query("select payload from device_commands where status in ('QUEUED','SENT','PARTIAL') and expires_at>now() order by created_at desc limit 100");
      const pending=result.rows.map(row=>row.payload||{});
      const byId=new Map((data.commands||[]).map(command=>[command.id,command]));
      for(const command of pending)byId.set(command.id,command);
      data.commands=[...byId.values()];
    }finally{
      client.release();
    }
  }
  async function syncDeviceOwnership(data){
    const client=await pool.connect();
    try{await readAndEnforceDeviceOwnership(client,data);}finally{client.release();}
  }

  async function claimDeviceOwnership(kind,deviceId,wardrobeId,gatewayId=null){
    const client=await pool.connect();
    try{
      await client.query('begin');
      await ensureDeviceOwnershipSchema(client);
      await seedDeviceOwnership(client);
      // Different serverless instances can register different hangers at the
      // same moment. Serialize number allocation per physical gateway in the
      // database, not merely in one browser or one Vercel process.
      if(kind==='hanger'){
        await client.query('select pg_advisory_xact_lock(hashtext($1))',[`otkok-hanger-number:${gatewayId}`]);
      }
      const current=await client.query(
        'select wardrobe_id from device_ownership where device_kind=$1 and device_id=$2 for update',
        [kind,deviceId],
      );
      const currentWardrobeId=current.rows[0]?.wardrobe_id||null;
      if(currentWardrobeId&&currentWardrobeId!==wardrobeId){
        await client.query('rollback');
        return {ok:false,wardrobeId:currentWardrobeId};
      }
      let hangerNumber=null;
      if(kind==='hanger'){
        const hangerRow=await client.query('select hanger_number from hangers where hanger_id=$1 for update',[deviceId]);
        const existing=Number(hangerRow.rows[0]?.hanger_number||0);
        const conflict=existing>0?await client.query(
          'select 1 from hangers where gateway_id=$1 and hanger_id<>$2 and hanger_number=$3 limit 1',
          [gatewayId,deviceId,existing],
        ):null;
        if(Number.isInteger(existing)&&existing>0&&!conflict?.rowCount)hangerNumber=existing;
        else{
          const next=await client.query(
            'select coalesce(max(hanger_number),0)+1 as number from hangers where gateway_id=$1 and hanger_id<>$2 and wardrobe_id=$3',
            [gatewayId,deviceId,wardrobeId],
          );
          hangerNumber=Number(next.rows[0]?.number||1);
        }
      }
      await client.query(`
        insert into device_ownership(device_kind,device_id,wardrobe_id,gateway_id,release_blocked,updated_at)
        values($1,$2,$3,$4,false,now())
        on conflict(device_kind,device_id) do update
        set wardrobe_id=excluded.wardrobe_id,gateway_id=excluded.gateway_id,release_blocked=false,updated_at=now()
      `,[kind,deviceId,wardrobeId,gatewayId]);
      if(kind==='gateway'){
        await client.query(`update gateways set wardrobe_id=$2,payload=coalesce(payload,'{}'::jsonb)||jsonb_build_object('wardrobeId',$2::text) where gateway_id=$1`,[deviceId,wardrobeId]);
      }else{
        await client.query(`update hangers set wardrobe_id=$2,gateway_id=$3,hanger_number=$4,payload=coalesce(payload,'{}'::jsonb)||jsonb_build_object('wardrobeId',$2::text,'gatewayId',$3::text,'hangerNumber',$4::int) where hanger_id=$1`,[deviceId,wardrobeId,gatewayId,hangerNumber]);
      }
      await client.query('commit');
      return {ok:true,hangerNumber};
    }catch(error){await client.query('rollback').catch(()=>{});throw error;}finally{client.release();}
  }

  async function releaseGatewayOwnership(gatewayId,wardrobeId){
    const client=await pool.connect();
    try{
      await client.query('begin');
      await ensureDeviceOwnershipSchema(client);
      await seedDeviceOwnership(client);
      const current=await client.query(
        "select wardrobe_id from device_ownership where device_kind='gateway' and device_id=$1 for update",
        [gatewayId],
      );
      if(current.rows[0]?.wardrobe_id!==wardrobeId){await client.query('rollback');return {ok:false,releasedHangerIds:[]};}
      const hangers=await client.query(`
        select distinct device_id as hanger_id from device_ownership
        where device_kind='hanger' and wardrobe_id=$2 and gateway_id=$1
        union select hanger_id from hangers where gateway_id=$1 and wardrobe_id=$2
      `,[gatewayId,wardrobeId]);
      const hangerIds=hangers.rows.map(row=>row.hanger_id);
      await client.query(`
        insert into device_ownership(device_kind,device_id,wardrobe_id,gateway_id,release_blocked,updated_at)
        values('gateway',$1,null,null,true,now())
        on conflict(device_kind,device_id) do update set wardrobe_id=null,gateway_id=null,release_blocked=true,updated_at=now()
      `,[gatewayId]);
      for(const hangerId of hangerIds)await client.query(`
        insert into device_ownership(device_kind,device_id,wardrobe_id,gateway_id,release_blocked,updated_at)
        values('hanger',$1,null,null,true,now())
        on conflict(device_kind,device_id) do update set wardrobe_id=null,gateway_id=null,release_blocked=true,updated_at=now()
      `,[hangerId]);
      await client.query(`update gateways set wardrobe_id=null,gateway_number=null,custom_name='',payload=coalesce(payload,'{}'::jsonb)||'{"wardrobeId":null,"gatewayNumber":null,"customName":""}'::jsonb where gateway_id=$1`,[gatewayId]);
      await client.query(`update hangers set wardrobe_id=null,gateway_id=null,hanger_number=null,custom_name='',payload=coalesce(payload,'{}'::jsonb)||'{"wardrobeId":null,"gatewayId":null,"hangerNumber":null,"customName":""}'::jsonb where hanger_id=any($1::text[])`,[hangerIds]);
      await client.query('commit');
      return {ok:true,releasedHangerIds:hangerIds};
    }catch(error){await client.query('rollback').catch(()=>{});throw error;}finally{client.release();}
  }

  async function releaseHangerOwnership(hangerId,wardrobeId){
    const client=await pool.connect();
    try{
      await client.query('begin');
      await ensureDeviceOwnershipSchema(client);
      await seedDeviceOwnership(client);
      const current=await client.query(
        "select wardrobe_id from device_ownership where device_kind='hanger' and device_id=$1 for update",
        [hangerId],
      );
      if(current.rows[0]?.wardrobe_id!==wardrobeId){await client.query('rollback');return {ok:false};}
      await client.query(`
        insert into device_ownership(device_kind,device_id,wardrobe_id,gateway_id,release_blocked,updated_at)
        values('hanger',$1,null,null,true,now())
        on conflict(device_kind,device_id) do update set wardrobe_id=null,gateway_id=null,release_blocked=true,updated_at=now()
      `,[hangerId]);
      await client.query(`update hangers set wardrobe_id=null,gateway_id=null,hanger_number=null,custom_name='',payload=coalesce(payload,'{}'::jsonb)||'{"wardrobeId":null,"gatewayId":null,"hangerNumber":null,"customName":""}'::jsonb where hanger_id=$1`,[hangerId]);
      await client.query('commit');
      return {ok:true};
    }catch(error){await client.query('rollback').catch(()=>{});throw error;}finally{client.release();}
  }

  async function close() {
    while (isSaving || pendingSnapshot) {
      await new Promise(r => setTimeout(r, 20));
    }
    await pool.end();
  }
  return {mode:'postgres',load,reload:load,save,close,syncDeviceOwnership,refreshCommands,claimDeviceOwnership,releaseGatewayOwnership,releaseHangerOwnership};
}

function createStorage({file,initial}){
  const connectionString=process.env.DATABASE_URL
    ||process.env.POSTGRES_URL
    ||process.env.POSTGRES_URL_NON_POOLING
    ||process.env.SUPABASE_DB_URL;
  return connectionString?postgresStorage(connectionString,initial):jsonStorage(file,initial);
}

module.exports={createStorage};
