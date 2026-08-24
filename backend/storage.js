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
  return {mode:'json',load:async()=>load(),save,close:async()=>{}};
}

function postgresStorage(connectionString, initial){
  const pool=new Pool({
    connectionString,
    // Hosted Supabase endpoints require TLS. Local PostgreSQL URLs keep their
    // own SSL settings instead of silently disabling certificate checks.
    ssl:/localhost|127\.0\.0\.1/.test(connectionString)?undefined:{rejectUnauthorized:false},
    max:Number(process.env.PG_POOL_MAX||10),
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
        const result=await client.query(`select payload from ${table[key]} order by ${orderColumn} asc`);
        out[key]=result.rows.map(row=>row.payload||{});
      }
      // The one-time importer intentionally runs only against an empty cloud
      // database. It never replaces an existing friend's data.
      const seed=process.env.SEED_JSON_PATH;
      if(!out.users.length&&seed&&fs.existsSync(seed)){
        console.log(`[STORAGE] importing empty cloud DB from ${seed}`);
        return {...initial(),...JSON.parse(fs.readFileSync(seed,'utf8'))};
      }
      return {...out,schemaVersion:4};
    }finally{client.release();}
  }
  async function insertBatch(client, tableName, columns, rows, mapRow, batchSize = 100) {
    if (!rows || rows.length === 0) return;
    const colList = columns.join(',');
    const colCount = columns.length;
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
      const query = `insert into ${tableName} (${colList}) values ${valuePlaceholders.join(',')}`;
      await client.query(query, flatParams);
    }
  }

  async function persist(data) {
    const client = await pool.connect();
    try {
      await client.query('begin');
      for (const key of ['commands', 'events', 'garments', 'hangers', 'gateways', 'wardrobes', 'users']) {
        await client.query(`delete from ${table[key]}`);
      }
      const asJson = value => JSON.stringify(value ?? {});

      await insertBatch(client, 'app_users', ['id', 'email', 'name', 'password_hash', 'role', 'last_login_at', 'created_at', 'payload'], data.users, u => [u.id, u.email, u.name, u.passwordHash, u.role || 'user', u.lastLoginAt || null, u.createdAt, asJson(u)]);
      await insertBatch(client, 'wardrobes', ['id', 'user_id', 'name', 'created_at', 'payload'], data.wardrobes, w => [w.id, w.userId, w.name, w.createdAt, asJson(w)]);
      await insertBatch(client, 'gateways', ['gateway_id', 'wardrobe_id', 'name', 'custom_name', 'gateway_number', 'state', 'last_seen', 'channel', 'firmware_version', 'created_at', 'payload'], data.gateways, g => [g.gatewayId, g.wardrobeId, g.name || '새 옷봉', g.customName || '', g.gatewayNumber || null, g.state || null, g.lastSeen || null, g.channel || null, g.firmwareVersion || null, g.createdAt || new Date().toISOString(), asJson(g)]);
      await insertBatch(client, 'hangers', ['hanger_id', 'wardrobe_id', 'gateway_id', 'alias', 'custom_name', 'hanger_number', 'state', 'reported_state', 'tag_uid', 'last_seen', 'last_sequence', 'boot_id', 'channel', 'rssi', 'error_flags', 'firmware_version', 'created_at', 'payload'], data.hangers, h => [h.hangerId, h.wardrobeId, h.gatewayId || null, h.alias || '', h.customName || '', h.hangerNumber || null, h.state || null, h.reportedState || null, h.tagUid || null, h.lastSeen || null, h.lastSequence ?? -1, h.bootId || null, h.channel || null, h.rssi || null, h.errorFlags || null, h.firmwareVersion || null, h.createdAt || new Date().toISOString(), asJson(h)]);
      await insertBatch(client, 'garments', ['id', 'wardrobe_id', 'created_by', 'tag_uid', 'name', 'category', 'color', 'season', 'brand', 'memo', 'image_url', 'original_image_path', 'processed_image_path', 'image_processing_status', 'classification', 'classification_confidence', 'processing_error', 'current_state', 'current_hanger', 'last_seen', 'created_at', 'payload'], data.garments, g => [g.id, g.wardrobeId, g.createdBy || null, g.tagUid, g.name, g.category || '', g.color || '', g.season || '', g.brand || '', g.memo || '', g.imageUrl || '', g.originalImagePath || '', g.processedImagePath || '', g.imageProcessingStatus || 'ready', asJson(g.classification || {}), asJson(g.classificationConfidence || {}), g.processingError || '', g.currentState || 'OUT', g.currentHanger || null, g.lastSeen || null, g.createdAt || new Date().toISOString(), asJson(g)]);
      await insertBatch(client, 'device_commands', ['id', 'numeric_id', 'wardrobe_id', 'requested_by', 'command', 'targets', 'duration_ms', 'status', 'acknowledgements', 'created_at', 'expires_at', 'sent_at', 'payload'], data.commands, c => [c.id, c.numericId, c.wardrobeId, c.requestedBy || null, c.command, asJson(c.targets || []), c.durationMs || 0, c.status, asJson(c.acknowledgements || {}), c.createdAt, c.expiresAt || null, c.sentAt || null, asJson(c)]);
      await insertBatch(client, 'wardrobe_events', ['id', 'wardrobe_id', 'type', 'severity', 'payload', 'at'], data.events, e => [e.id, e.wardrobeId || null, e.type, e.severity || 'info', asJson(e), e.at]);

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
      const snapshot = pendingSnapshot;
      const waiters = pendingWaiters;
      pendingSnapshot = null;
      pendingWaiters = [];

      try {
        await persist(snapshot);
        waiters.forEach(w => w.resolve());
      } catch (err) {
        waiters.forEach(w => w.reject(err));
      }
    }
    isSaving = false;
  }

  function save(data) {
    const snapshot = JSON.parse(JSON.stringify(data));
    pendingSnapshot = snapshot;
    return new Promise((resolve, reject) => {
      pendingWaiters.push({ resolve, reject });
      runSaveLoop().catch(() => {});
    });
  }

  async function close() {
    while (isSaving || pendingSnapshot) {
      await new Promise(r => setTimeout(r, 20));
    }
    await pool.end();
  }
  return { mode: 'postgres', load, save, close };
}

function createStorage({file,initial}){
  return process.env.DATABASE_URL?postgresStorage(process.env.DATABASE_URL,initial):jsonStorage(file,initial);
}

module.exports={createStorage};
