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
    users:['id','email','name','passwordHash','createdAt'],
    wardrobes:['id','userId','name','createdAt'],
    gateways:['gatewayId','wardrobeId','name','state','lastSeen','channel','firmwareVersion','createdAt'],
    hangers:['hangerId','wardrobeId','gatewayId','alias','state','reportedState','tagUid','lastSeen','lastSequence','bootId','channel','rssi','errorFlags','firmwareVersion','createdAt'],
    garments:['id','wardrobeId','createdBy','tagUid','name','category','color','season','brand','memo','imageUrl','currentState','currentHanger','lastSeen','createdAt'],
    commands:['id','numericId','wardrobeId','requestedBy','command','targets','durationMs','status','acknowledgements','createdAt','expiresAt','sentAt'],
    events:['id','wardrobeId','type','severity','payload','at'],
  };
  const table={users:'app_users',wardrobes:'wardrobes',gateways:'gateways',hangers:'hangers',garments:'garments',commands:'device_commands',events:'wardrobe_events'};
  async function upgradeOlderGarmentsTable(client){
    // The early beta had a smaller garments table. These additive changes are
    // safe to run at every startup and prevent an old cloud project from
    // blocking a first JSON import.
    for(const statement of [
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
    ])await client.query(statement);
  }
  async function load(){
    const client=await pool.connect();
    try{
      const check=await client.query("select to_regclass('public.app_users') as users, to_regclass('public.wardrobes') as wardrobes");
      if(!check.rows[0].users||!check.rows[0].wardrobes)throw new Error('Supabase 스키마가 없습니다. supabase/schema.sql을 먼저 실행하세요.');
      await upgradeOlderGarmentsTable(client);
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
      return {...out,schemaVersion:3};
    }finally{client.release();}
  }
  async function save(data){
    const client=await pool.connect();
    try{
      await client.query('begin');
      // A single process owns the free-beta service. Replacing the snapshot in
      // one transaction avoids partial state after a power or deploy failure.
      for(const key of ['commands','events','garments','hangers','gateways','wardrobes','users'])await client.query(`delete from ${table[key]}`);
      for(const user of data.users)await client.query('insert into app_users (id,email,name,password_hash,created_at,payload) values ($1,$2,$3,$4,$5,$6)',[user.id,user.email,user.name,user.passwordHash,user.createdAt,user]);
      for(const wardrobe of data.wardrobes)await client.query('insert into wardrobes (id,user_id,name,created_at,payload) values ($1,$2,$3,$4,$5)',[wardrobe.id,wardrobe.userId,wardrobe.name,wardrobe.createdAt,wardrobe]);
      for(const gateway of data.gateways)await client.query('insert into gateways (gateway_id,wardrobe_id,name,state,last_seen,channel,firmware_version,created_at,payload) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)',[gateway.gatewayId,gateway.wardrobeId,gateway.name||'새 옷봉',gateway.state||null,gateway.lastSeen||null,gateway.channel||null,gateway.firmwareVersion||null,gateway.createdAt||new Date().toISOString(),gateway]);
      for(const hanger of data.hangers)await client.query('insert into hangers (hanger_id,wardrobe_id,gateway_id,alias,state,reported_state,tag_uid,last_seen,last_sequence,boot_id,channel,rssi,error_flags,firmware_version,created_at,payload) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)',[hanger.hangerId,hanger.wardrobeId,hanger.gatewayId||null,hanger.alias||'',hanger.state||null,hanger.reportedState||null,hanger.tagUid||null,hanger.lastSeen||null,hanger.lastSequence??-1,hanger.bootId||null,hanger.channel||null,hanger.rssi||null,hanger.errorFlags||null,hanger.firmwareVersion||null,hanger.createdAt||new Date().toISOString(),hanger]);
      for(const garment of data.garments)await client.query('insert into garments (id,wardrobe_id,created_by,tag_uid,name,category,color,season,brand,memo,image_url,current_state,current_hanger,last_seen,created_at,payload) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)',[garment.id,garment.wardrobeId,garment.createdBy||null,garment.tagUid,garment.name,garment.category||'',garment.color||'',garment.season||'',garment.brand||'',garment.memo||'',garment.imageUrl||'',garment.currentState||'OUT',garment.currentHanger||null,garment.lastSeen||null,garment.createdAt||new Date().toISOString(),garment]);
      for(const command of data.commands)await client.query('insert into device_commands (id,numeric_id,wardrobe_id,requested_by,command,targets,duration_ms,status,acknowledgements,created_at,expires_at,sent_at,payload) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)',[command.id,command.numericId,command.wardrobeId,command.requestedBy||null,command.command,command.targets||[],command.durationMs||0,command.status,command.acknowledgements||{},command.createdAt,command.expiresAt||null,command.sentAt||null,command]);
      for(const event of data.events)await client.query('insert into wardrobe_events (id,wardrobe_id,type,severity,payload,at) values ($1,$2,$3,$4,$5,$6)',[event.id,event.wardrobeId||null,event.type,event.severity||'info',event,event.at]);
      await client.query('commit');
    }catch(error){
      await client.query('rollback').catch(()=>{});
      throw error;
    }finally{client.release();}
  }
  return {mode:'postgres',load,save,close:()=>pool.end()};
}

function createStorage({file,initial}){
  return process.env.DATABASE_URL?postgresStorage(process.env.DATABASE_URL,initial):jsonStorage(file,initial);
}

module.exports={createStorage};
