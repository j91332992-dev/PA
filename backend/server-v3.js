'use strict';
const http=require('http'),fs=require('fs'),path=require('path'),crypto=require('crypto');
const {createStorage}=require('./storage');
const {WebSocketServer}=require('ws');
const garmentImageService=require('./garment-image-service');
const cloudImageService=require('./cloud-image-service');
const ROOT=path.resolve(__dirname,'..');
function loadEnv(file){if(!fs.existsSync(file))return;for(const line of fs.readFileSync(file,'utf8').split(/\r?\n/)){const i=line.indexOf('=');if(i>0&&line[0]!=='#'&&!(line.slice(0,i).trim() in process.env))process.env[line.slice(0,i).trim()]=line.slice(i+1).trim();}}
loadEnv(path.join(ROOT,'.env'));
const PORT=Number(process.env.PORT||8787),DATA=path.resolve(ROOT,process.env.DATA_PATH||'data/wardrobe.json'),PUBLIC=path.join(ROOT,'web','public');
const SECRET=process.env.JWT_SECRET||'development-secret',DEVICE=process.env.DEVICE_TOKEN||'development-device-token';
// Hanger presence is physical and must transition quickly. Gateway cloud
// heartbeats use a separate, more tolerant lease: an S3 heartbeat runs every
// 8 seconds and an occasional TLS/network delay must not make the whole rod
// flap offline. This never changes the 10-second hanger/garment OUT rule.
const OFFLINE=Number(process.env.OFFLINE_TIMEOUT_MS||10000),GATEWAY_OFFLINE=Number(process.env.GATEWAY_OFFLINE_TIMEOUT_MS||30000),DISCOVERY_RETENTION=Number(process.env.DISCOVERY_RETENTION_MS||120000),CMD_TIMEOUT=Number(process.env.COMMAND_TIMEOUT_MS||60000),SIM=process.env.SIMULATION_ENABLED==='true';
// Set ADMIN_EMAIL in Render (or .env locally) to the sole administrator.
// Both the role and the second-factor proof are verified only by this server.
const ADMIN_EMAIL=String(process.env.ADMIN_EMAIL||'').trim().toLowerCase();
const ADMIN_SECONDARY_PASSWORD=String(process.env.ADMIN_SECONDARY_PASSWORD||'');
const ADMIN_SESSION_TTL_MS=Math.max(60_000,Number(process.env.ADMIN_SESSION_TTL_MS||900_000));
const adminSessions=new Map();
const now=()=>new Date().toISOString(),id=p=>`${p}_${crypto.randomUUID()}`,uid=x=>String(x||'').replace(/[^0-9a-f]/gi,'').toUpperCase();
const initial=()=>({schemaVersion:5,users:[],wardrobes:[],gateways:[],hangers:[],garments:[],events:[],commands:[]});
let db=initial();const storage=createStorage({file:DATA,initial});function save(){return storage.save(db)}
const safe=(a,b)=>{const x=Buffer.from(String(a)),y=Buffer.from(String(b));return x.length===y.length&&crypto.timingSafeEqual(x,y)};
function hash(p,s=crypto.randomBytes(16).toString('hex')){return `${s}:${crypto.pbkdf2Sync(p,s,210000,32,'sha256').toString('hex')}`}
function error(status,message){const e=new Error(message);e.status=status;return e}
function wardrobeFor(user){return db.wardrobes.find(w=>w.userId===user.id)}
function makeWardrobe(user){const w={id:id('wd'),userId:user.id,name:`${user.name||'나'}의 스마트 옷장`,createdAt:now()};db.wardrobes.push(w);return w}
function simulated(x){return /^GW-SIM/i.test(x.gatewayId||'')||/^HC-00000[1-5]$/i.test(x.hangerId||'')}
function ownerForWardrobe(wardrobeId){const wardrobe=db.wardrobes.find(w=>w.id===wardrobeId);return db.users.find(u=>u.id===wardrobe?.userId)||null}
function ownerName(wardrobeId){return ownerForWardrobe(wardrobeId)?.name||'내'}
function shortHardwareCode(hardwareId){const match=String(hardwareId||'').toUpperCase().match(/([0-9A-F]{6})$/);return match?match[1]:'UNKNOWN'}
function neutralGatewayName(gateway){return `스마트 옷봉 · ${shortHardwareCode(gateway?.gatewayId)}`}
function neutralHangerName(hanger){return `스마트 옷걸이 · ${shortHardwareCode(hanger?.hangerId)}`}
function gatewayDefaultName(gateway){return `${ownerName(gateway.wardrobeId)}의 ${Number(gateway.gatewayNumber)||1}번 옷봉`}
function hangerDefaultName(hanger){return hanger.gatewayId?`${Number(hanger.hangerNumber)||1}번 옷걸이`:`미연결 옷걸이 · ${shortHardwareCode(hanger.hangerId)}`}
function nextGatewayNumber(wardrobeId){return Math.max(0,...db.gateways.filter(g=>g.wardrobeId===wardrobeId&&!simulated(g)).map(g=>Number(g.gatewayNumber)||0))+1}
function nextHangerNumber(gatewayId){return Math.max(0,...db.hangers.filter(h=>h.gatewayId===gatewayId&&!simulated(h)).map(h=>Number(h.hangerNumber)||0))+1}
function syncGatewayName(gateway){gateway.name=String(gateway.customName||'').trim()||(gateway.wardrobeId?gatewayDefaultName(gateway):neutralGatewayName(gateway));return gateway}
function syncHangerName(hanger){hanger.alias=String(hanger.customName||'').trim()||(hanger.wardrobeId?hangerDefaultName(hanger):neutralHangerName(hanger));return hanger}
function assignGateway(gateway,wardrobeId){
  if(gateway.wardrobeId!==wardrobeId||!Number.isInteger(Number(gateway.gatewayNumber))||Number(gateway.gatewayNumber)<1)gateway.gatewayNumber=nextGatewayNumber(wardrobeId);
  gateway.wardrobeId=wardrobeId;return syncGatewayName(gateway);
}
function assignHanger(hanger,wardrobeId,gatewayId,{moved=false}={}){
  if(moved||hanger.gatewayId!==gatewayId||!Number.isInteger(Number(hanger.hangerNumber))||Number(hanger.hangerNumber)<1)hanger.hangerNumber=nextHangerNumber(gatewayId);
  hanger.wardrobeId=wardrobeId;hanger.gatewayId=gatewayId;return syncHangerName(hanger);
}
function maskOwnerName(name){const chars=[...String(name||'').trim()];if(!chars.length)return '알 수 없는 사용자';return chars.length===1?`${chars[0]}*`:`${chars[0]}${'*'.repeat(Math.min(chars.length-1,3))}`}
function pairingLabel(kind,item,user){
  const isGateway=kind==='gateways',hardwareId=isGateway?item?.gatewayId:item?.hangerId;
  const neutral=isGateway?neutralGatewayName({gatewayId:hardwareId}):neutralHangerName({hangerId:hardwareId});
  if(!item||!item.wardrobeId)return {ownership:'UNCLAIMED',displayName:neutral,hardwareId:hardwareId||null};
  const wardrobe=wardrobeFor(user);
  if(item.wardrobeId!==wardrobe?.id){const owner=ownerForWardrobe(item.wardrobeId);return {ownership:'OTHER_ACCOUNT',displayName:`다른 계정에 등록된 ${isGateway?'옷봉':'옷걸이'}`,hardwareId:hardwareId||null,ownerLabel:maskOwnerName(owner?.name)};}
  return {ownership:'OWNED',displayName:isGateway?(item.name||neutral):(item.alias||neutral),hardwareId:hardwareId||null};
}
function isConfiguredAdmin(user){return !!ADMIN_EMAIL&&String(user.email||'').trim().toLowerCase()===ADMIN_EMAIL}
function userPublic(user){return {id:user.id,email:user.email,name:user.name,role:user.role||'user',createdAt:user.createdAt,lastLoginAt:user.lastLoginAt||null}}
function migrate(){
  let changed=false;
  db.wardrobes=Array.isArray(db.wardrobes)?db.wardrobes:[];
  for(const u of db.users)if(!wardrobeFor(u))makeWardrobe(u);
  const byUser=new Map(db.users.map(u=>[u.id,wardrobeFor(u)?.id]));
  for(const g of db.garments)if(!g.wardrobeId)g.wardrobeId=byUser.get(g.createdBy)||db.wardrobes[0]?.id||null;
  // Ownership inference was needed only when importing pre-v5 data. Running
  // it on every boot silently resurrected devices that a user had released.
  if(Number(db.schemaVersion||0)<5){
    const ownerByTag=new Map(db.garments.map(g=>[g.tagUid,g.wardrobeId]));
    const ownershipCount=new Map();for(const garment of db.garments)ownershipCount.set(garment.wardrobeId,(ownershipCount.get(garment.wardrobeId)||0)+1);
    const legacyOwner=[...ownershipCount.entries()].sort((a,b)=>b[1]-a[1])[0]?.[0]||null;
    for(const h of db.hangers)if(!h.wardrobeId)h.wardrobeId=ownerByTag.get(h.tagUid)||null;
    for(const g of db.gateways)if(!g.wardrobeId){const hs=db.hangers.filter(h=>h.gatewayId===g.gatewayId&&h.wardrobeId);g.wardrobeId=hs[0]?.wardrobeId||null;}
    for(const h of db.hangers)if(!h.wardrobeId)h.wardrobeId=db.gateways.find(g=>g.gatewayId===h.gatewayId)?.wardrobeId||null;
    for(const g of db.gateways)if(!g.wardrobeId&&!simulated(g))g.wardrobeId=legacyOwner;
    for(const h of db.hangers)if(!h.wardrobeId&&!simulated(h))h.wardrobeId=db.gateways.find(g=>g.gatewayId===h.gatewayId)?.wardrobeId||legacyOwner;
  }
  // Migrate visible names without changing immutable hardware IDs. Numbers
  // are assigned only when absent, so deletion never compacts/reuses them.
  for(const user of db.users){const role=isConfiguredAdmin(user)?'admin':'user';if(user.role!==role){user.role=role;changed=true;}}
  // Version 5 fixes the historical single-wardrobe bootstrap behavior. A
  // configured service administrator must not silently own real hardware:
  // that would block every normal user while remaining hidden from the
  // administrator's regular-user overview.
  if(Number(db.schemaVersion||0)<5){
    const adminWardrobeIds=new Set(db.wardrobes.filter(wardrobe=>ownerForWardrobe(wardrobe.id)?.role==='admin').map(wardrobe=>wardrobe.id));
    for(const gateway of db.gateways)if(!simulated(gateway)&&adminWardrobeIds.has(gateway.wardrobeId))releaseGatewayOwnership(gateway);
    changed=true;
  }
  for(const w of db.wardrobes){
    const gateways=db.gateways.filter(g=>g.wardrobeId===w.id&&!simulated(g)).sort((a,b)=>String(a.createdAt||a.gatewayId).localeCompare(String(b.createdAt||b.gatewayId)));
    gateways.forEach((g,index)=>{
      const previousNumber=g.gatewayNumber,previousCustomName=g.customName,previousName=g.name;
      if(!Number.isInteger(Number(g.gatewayNumber))||Number(g.gatewayNumber)<1)g.gatewayNumber=index+1;
      if(typeof g.customName!=='string'){const old=String(g.name||'');g.customName=old&&old!=='새 옷봉'&&old!=='Gateway'&&!/의(?: \d+번)? 옷봉$/.test(old)?old:'';}
      syncGatewayName(g);
      if(previousNumber!==g.gatewayNumber||previousCustomName!==g.customName||previousName!==g.name)changed=true;
    });
    for(const g of gateways){
      const hangers=db.hangers.filter(h=>h.gatewayId===g.gatewayId&&!simulated(h)).sort((a,b)=>String(a.createdAt||a.hangerId).localeCompare(String(b.createdAt||b.hangerId)));
      const usedNumbers=new Set(), nextNumber=()=>{let n=1;while(usedNumbers.has(n))n++;return n;};
      hangers.forEach(h=>{
        const previousNumber=h.hangerNumber, explicit=Number(h.hangerNumber);
        if(!Number.isInteger(explicit)||explicit<1||usedNumbers.has(explicit))h.hangerNumber=nextNumber();
        usedNumbers.add(Number(h.hangerNumber));
        if(previousNumber!==h.hangerNumber)changed=true;
        if(typeof h.customName!=='string'){const old=String(h.alias||''),previous=h.customName;h.customName=old&&!/^HC-/i.test(old)&&!/^\d+번 옷걸이$/.test(old)&&!/의 옷걸이 \d+번$/.test(old)?old:'';if(previous!==h.customName)changed=true;}
        if(h.wardrobeId===w.id){const previousName=h.alias;syncHangerName(h);if(previousName!==h.alias)changed=true;}
      });
    }
  }
  for(const g of db.gateways)if(!g.wardrobeId){g.customName='';syncGatewayName(g);}
  for(const h of db.hangers)if(!h.wardrobeId){h.customName='';syncHangerName(h);}
  for(const c of db.commands)if(!c.wardrobeId){const h=db.hangers.find(h=>c.targets?.includes(h.hangerId));c.wardrobeId=h?.wardrobeId||byUser.get(c.requestedBy)||null;}
  changed = changed || db.schemaVersion !== 5;
  db.schemaVersion = 5;
  return changed;
}
let isReady = false;
let storageInitError = null;
let ready = null;
let storageRetryTimer = null;
function initializeStorage() {
  if (isReady || ready) return ready;
  const loadStartTime = Date.now();
  storageInitError = null;
  ready = storage.load().then(loaded => {
    db = loaded;
    const dirty = migrate();
    if (dirty) return save();
  }).then(() => {
    isReady = true;
    console.log(`[STORAGE] ${storage.mode} ready in ${Date.now() - loadStartTime}ms`);
  }).catch(error => {
    // A serverless instance can lose its first pooled-Postgres connection
    // briefly. Keep the service recoverable instead of permanently poisoning
    // every request handled by that warm instance.
    storageInitError = error.message;
    console.error(`[STORAGE] ${storage.mode} init failed: ${error.message}`);
    clearTimeout(storageRetryTimer);
    storageRetryTimer = setTimeout(() => {
      ready = null;
      initializeStorage();
    }, 1000);
    storageRetryTimer.unref?.();
  });
  return ready;
}
initializeStorage();
// Serverless requests can hit different warm instances, but reloading every
// table (and running ownership DDL) for every poll turns a healthy database
// into a login/504 bottleneck. Keep a very short authoritative cache: device
// claim operations remain transaction-protected in PostgreSQL and nearby BLE
// status never waits for this cloud refresh.
let authoritativeReloadAt=0,authoritativeReloadPromise=null;
async function reloadAuthoritativeState(force=false){
  if(!(process.env.VERCEL&&storage.mode==='postgres'))return;
  if(!force&&Date.now()-authoritativeReloadAt<1500)return;
  if(!authoritativeReloadPromise)authoritativeReloadPromise=storage.reload().then(loaded=>{
    db=loaded;reconcile();authoritativeReloadAt=Date.now();
  }).finally(()=>{authoritativeReloadPromise=null;});
  await authoritativeReloadPromise;
}
let ownershipSyncAt=0,ownershipSyncPromise=null;
async function syncDeviceOwnershipState(force=false){
  if(storage.mode!=='postgres')return;
  if(!force&&Date.now()-ownershipSyncAt<500)return;
  if(!ownershipSyncPromise)ownershipSyncPromise=storage.syncDeviceOwnership(db).then(async()=>{
    let namesChanged=false;
    for(const gateway of db.gateways){const previousName=gateway.name;syncGatewayName(gateway);if(previousName!==gateway.name)namesChanged=true;}
    for(const hanger of db.hangers){const previousName=hanger.alias;syncHangerName(hanger);if(previousName!==hanger.alias)namesChanged=true;}
    reconcile();ownershipSyncAt=Date.now();
    if(namesChanged)await save();
  }).finally(()=>{ownershipSyncPromise=null;});
  await ownershipSyncPromise;
}
function token(user){const p=Buffer.from(JSON.stringify({sub:user.id,exp:Date.now()+604800000})).toString('base64url');return `${p}.${crypto.createHmac('sha256',SECRET).update(p).digest('base64url')}`}
function issueDeviceClaimIntent(user,kind,key){const payload=Buffer.from(JSON.stringify({sub:user.id,kind,key:String(key).toUpperCase(),exp:Date.now()+15000,nonce:crypto.randomBytes(12).toString('base64url')})).toString('base64url'),signature=crypto.createHmac('sha256',SECRET).update(`claim:${payload}`).digest('base64url');return `${payload}.${signature}`}
function verifyDeviceClaimIntent(proof,user,kind,key){const [payload,signature]=String(proof||'').split('.');if(!payload||!signature||!safe(signature,crypto.createHmac('sha256',SECRET).update(`claim:${payload}`).digest('base64url')))return false;try{const value=JSON.parse(Buffer.from(payload,'base64url'));return value.exp>Date.now()&&value.sub===user.id&&value.kind===kind&&value.key===String(key).toUpperCase()}catch{return false}}
function getUser(req){const [p,s]=String(req.headers.authorization||'').replace(/^Bearer /,'').split('.');if(!p||!s||!safe(s,crypto.createHmac('sha256',SECRET).update(p).digest('base64url')))return null;try{const x=JSON.parse(Buffer.from(p,'base64url'));return x.exp>Date.now()?db.users.find(u=>u.id===x.sub):null}catch{return null}}
function needUser(req){const u=getUser(req);if(!u)throw error(401,'로그인이 필요합니다.');return u}
function adminSessionKey(value){return crypto.createHash('sha256').update(String(value||'')).digest('hex')}
function adminVerified(req,user){
  const key=adminSessionKey(req.headers['x-admin-session']);
  const session=adminSessions.get(key);
  if(!session)return false;
  if(session.expiresAt<=Date.now()){adminSessions.delete(key);return false;}
  return session.userId===user.id;
}
function issueAdminSession(user){
  const proof=crypto.randomBytes(32).toString('base64url');
  const expiresAt=Date.now()+ADMIN_SESSION_TTL_MS;
  adminSessions.set(adminSessionKey(proof),{userId:user.id,expiresAt});
  return {proof,expiresAt};
}
function revokeAdminSessions(userId){
  for(const [key,session] of adminSessions)if(session.userId===userId)adminSessions.delete(key);
}
function requireAdmin(req){const u=needUser(req);if(u.role!=='admin'||!adminVerified(req,u))throw error(403,'관리자 2차 인증이 필요합니다.');return u}
function needDevice(req){if(!safe(req.headers.authorization||'',`Bearer ${DEVICE}`))throw error(401,'옷봉 인증에 실패했습니다.')}
const sockets=new Set();
function emit(type,payload,severity='info',wardrobeId=payload?.wardrobeId){
  const e={id:id('evt'),type,severity,payload:structuredClone(payload),wardrobeId:wardrobeId||null,at:now()};
  db.events.unshift(e);
  db.events=db.events.slice(0,1000);
  const msg=JSON.stringify({type,payload,at:e.at});
  for(const ws of sockets)if(ws.readyState===1&&(!e.wardrobeId||ws.wardrobeId===e.wardrobeId))ws.send(msg);
}
function reconcile(){
  const seen=new Map();for(const h of db.hangers)if(h.reportedState==='PRESENT'&&h.tagUid){const k=`${h.wardrobeId}:${h.tagUid}`,a=seen.get(k)||[];a.push(h);seen.set(k,a)}
  for(const h of db.hangers){const same=seen.get(`${h.wardrobeId}:${h.tagUid}`)||[];if(h.reportedState==='OFFLINE')h.state='OFFLINE';else if(h.reportedState==='PRESENT'&&same.length>1)h.state='CONFLICT';else if(h.reportedState==='PRESENT'&&!db.garments.some(g=>g.wardrobeId===h.wardrobeId&&g.tagUid===h.tagUid))h.state='UNKNOWN_TAG';else h.state=h.reportedState;}
  for(const g of db.garments){const h=db.hangers.find(h=>h.wardrobeId===g.wardrobeId&&h.tagUid===g.tagUid&&h.state==='PRESENT');g.currentState=h?'IN_WARDROBE':'OUT';g.currentHanger=h?.hangerId||null;if(h)g.lastSeen=h.lastSeen;}
}
// Vercel functions do not keep the background interval alive.  Expire stale
// hangers on the request path instead, so an open app still gets a durable
// OFFLINE transition even when no new device packet arrives.  reconcile() then
// immediately projects any garment on that hanger to OUT.
let offlineExpiryPromise=null;
async function expireOfflineHangers(){
  if(offlineExpiryPromise)return offlineExpiryPromise;
  offlineExpiryPromise=(async()=>{
    const cutoff=Date.now()-OFFLINE,expired=[];
    for(const hanger of db.hangers){
      const seenAt=Date.parse(hanger.lastSeen||0);
      if(hanger.state!=='OFFLINE'&&(!Number.isFinite(seenAt)||seenAt<cutoff)){
        hanger.reportedState='OFFLINE';
        hanger.state='OFFLINE';
        expired.push(hanger);
      }
    }
    if(!expired.length)return false;
    for(const hanger of expired)emit('hanger.offline',hanger,'warning',hanger.wardrobeId);
    reconcile();
    try{await save();}
    catch(error){console.error('[OFFLINE] state save failed',error.message)}
    return true;
  })().finally(()=>{offlineExpiryPromise=null});
  return offlineExpiryPromise;
}
function gatewayOwner(gatewayId){return db.gateways.find(g=>g.gatewayId===gatewayId)?.wardrobeId||null}
function defaultWardrobeForNewGateway(){
  if(db.wardrobes.length!==1)return null;
  const only=db.wardrobes[0],owner=ownerForWardrobe(only.id);
  // A service administrator is not a default hardware owner. Otherwise the
  // first heartbeat creates a hidden cross-account ownership lock.
  return owner?.role==='admin'?null:only.id;
}
function attachGateway(gatewayId){
  let g=db.gateways.find(x=>x.gatewayId===gatewayId);
  // A heartbeat proves that hardware exists, not who owns it.  Registration
  // must always follow an explicit user claim, including single-user installs.
  if(!g){g={gatewayId,name:neutralGatewayName({gatewayId}),customName:'',createdAt:now(),wardrobeId:null};db.gateways.push(g)}
  return g;
}
function cancelActiveCommands(targets,wardrobeId,reason){
  const targetSet=new Set((targets||[]).map(value=>String(value).toUpperCase()));
  const cancelledAt=now(),cancelled=[];
  for(const pending of db.commands)if(pending.wardrobeId===wardrobeId&&['QUEUED','SENT','PARTIAL','ACKED'].includes(pending.status)&&pending.targets.some(target=>targetSet.has(target))){
    pending.status='CANCELLED';
    pending.cancelledAt=cancelledAt;
    pending.cancelReason=reason;
    cancelled.push(pending);
  }
  return cancelled;
}
function status(x){
  const hangerId=String(x.hangerId||'').toUpperCase(),state=String(x.state||'').toUpperCase(),sequence=Number(x.sequence),bootId=String(x.bootId||'legacy'),gatewayId=String(x.gatewayId||'GW-UNKNOWN').toUpperCase();
  if(!/^HC-[0-9A-F]{6,12}$/.test(hangerId))throw error(400,'hangerId 형식 오류');
  if(!['PRESENT','EMPTY','UNKNOWN_TAG','UNSTABLE'].includes(state)||!Number.isSafeInteger(sequence)||sequence<0)throw error(400,'옷걸이 상태 형식 오류');
  const gateway=attachGateway(gatewayId);
  let h=db.hangers.find(v=>v.hangerId===hangerId);
  // A physical hanger is only discovered at this point. It must be explicitly
  // claimed from the user's discovered-device list before it joins an account.
  if(!h){h={hangerId,alias:neutralHangerName({hangerId}),customName:'',createdAt:now(),lastSequence:-1,bootHistory:[],wardrobeId:null};db.hangers.push(h)}
  // A paired hanger may later report through a different *owned* gateway.
  // Keep its immutable hardware ID, but allocate its next number in the
  // destination gateway. Cross-account packets are never allowed to move it.
  if(h.wardrobeId&&gateway.wardrobeId===h.wardrobeId&&h.gatewayId!==gatewayId)assignHanger(h,h.wardrobeId,gatewayId,{moved:true});
  const currentBoot=String(h.bootId||''),history=Array.isArray(h.bootHistory)?h.bootHistory.map(String):[];
  if(currentBoot&&!history.includes(currentBoot))history.push(currentBoot);
  // A bootId is a session identifier. Once a hanger has moved to a new
  // session, packets from any retired session are delayed stale packets, not
  // a legitimate reboot. A never-seen bootId is accepted as the next reboot.
  if(currentBoot===bootId&&sequence<=Number(h.lastSequence??-1))return{hanger:h,duplicate:true,stale:true};
  if(currentBoot!==bootId&&history.includes(bootId))return{hanger:h,duplicate:true,stale:true};
  if(currentBoot!==bootId)h.lastSequence=-1;
  h.bootHistory=[...new Set([...history,bootId])];
  Object.assign(h,{reportedState:state,state,tagUid:uid(x.tagUid)||null,lastSeen:now(),lastSequence:sequence,bootId,channel:Number(x.channel||0),rssi:Number(x.rssi||0),errorFlags:Number(x.errorFlags||0),firmwareVersion:String(x.firmwareVersion||'unknown'),gatewayId});
  Object.assign(gateway,{state:'ONLINE',lastSeen:h.lastSeen,channel:h.channel,firmwareVersion:String(x.gatewayFirmwareVersion||'unknown')});
  // An EMPTY report is the physical source of truth: stop any outstanding
  // FIND for this hanger so stale retries cannot revive the LED or UI badge.
  const cancelled=state==='EMPTY'&&h.wardrobeId?cancelActiveCommands([hangerId],h.wardrobeId,'NFC_TAG_REMOVED'):[];
  reconcile();
  // Unclaimed hardware belongs to no wardrobe yet; do not broadcast its NFC
  // UID or state to every connected account.
  if(h.wardrobeId)emit('hanger.state',h,'info',h.wardrobeId);
  if(cancelled.length)emit('command.cancelled',{hangerId,targets:[hangerId],reason:'NFC_TAG_REMOVED',commandCount:cancelled.length},'info',h.wardrobeId);
  return{hanger:h,duplicate:false};
}
function statusBatch(items){
  if(!Array.isArray(items)||items.length<1||items.length>16)throw error(400,'상태 묶음은 1~16개여야 합니다.');
  const results=[];
  for(const item of items)results.push(status(item));
  return results;
}
function heartbeat(x){const gatewayId=String(x.gatewayId||'').toUpperCase();if(!/^GW-[0-9A-F]{6,12}$/.test(gatewayId))throw error(400,'gatewayId 형식 오류');const g=attachGateway(gatewayId);Object.assign(g,{state:'ONLINE',lastSeen:now(),channel:Number(x.channel||0),firmwareVersion:String(x.firmwareVersion||'unknown'),ssid:String(x.ssid||g.ssid||''),rssi:Number(x.rssi||g.rssi||0),ip:String(x.ip||g.ip||''),provisioning:{status:'CONNECTED',wifiStatus:'CONNECTED',cloudStatus:'CONNECTED',at:now()}});emit('gateway.heartbeat',g,'info',g.wardrobeId);return g}
function command(targets,user,duration=0,kind='LED_BLINK'){const w=wardrobeFor(user);targets=[...new Set((targets||[]).map(x=>String(x).toUpperCase()))];if(!targets.length||targets.length>16)throw error(400,'대상은 1~16개여야 합니다.');for(const t of targets)if(!db.hangers.some(h=>h.hangerId===t&&h.wardrobeId===w.id))throw error(404,`내 옷장에 없는 옷걸이: ${t}`);cancelActiveCommands(targets,w.id,'SUPERSEDED');const c={id:id('cmd'),numericId:crypto.randomInt(1,2147483647),command:String(kind).toUpperCase()==='LED_OFF'?'LED_OFF':'LED_BLINK',targets,durationMs:Math.max(0,Math.min(120000,Number(duration)||0)),status:'QUEUED',requestedBy:user.id,wardrobeId:w.id,createdAt:now(),expiresAt:new Date(Date.now()+CMD_TIMEOUT).toISOString(),acknowledgements:{}};db.commands.unshift(c);console.log(`[COMMAND] QUEUED id=${c.numericId} type=${c.command} targets=${targets.join(',')}`);emit('command.queued',c,'info',w.id);return c}
function pairingCommand(targets,user){const w=wardrobeFor(user);const c={id:id('cmd'),numericId:crypto.randomInt(1,2147483647),command:'PAIR',targets,status:'QUEUED',requestedBy:user.id,wardrobeId:w.id,createdAt:now(),expiresAt:new Date(Date.now()+CMD_TIMEOUT).toISOString(),acknowledgements:{}};db.commands.unshift(c);emit('hanger.pair_queued',c,'info',w.id);return c}
function visible(list,wid){return list.filter(x=>x.wardrobeId===wid&&(SIM||!simulated(x)))}
function discoveredHangers(wid){const ownedGatewayIds=new Set(db.gateways.filter(g=>g.wardrobeId===wid).map(g=>g.gatewayId)),cutoff=Date.now()-DISCOVERY_RETENTION;return db.hangers.filter(h=>!h.wardrobeId&&ownedGatewayIds.has(h.gatewayId)&&Date.parse(h.lastSeen||0)>=cutoff&&(SIM||!simulated(h))).map(h=>({hangerId:h.hangerId,alias:h.alias||'',gatewayId:h.gatewayId,createdAt:h.createdAt||null,reportedState:h.reportedState||h.state||'UNKNOWN',state:h.state||'UNKNOWN',tagUid:h.tagUid||null,lastSeen:h.lastSeen||null,channel:h.channel||0,errorFlags:h.errorFlags||0,firmwareVersion:h.firmwareVersion||'unknown'}))}
function eventReferencesOwnedHardware(event,wid){const p=event.payload||{};if(p.gatewayId&&!db.gateways.some(g=>g.gatewayId===p.gatewayId&&g.wardrobeId===wid))return false;if(p.hangerId&&!db.hangers.some(h=>h.hangerId===p.hangerId&&h.wardrobeId===wid))return false;if(Array.isArray(p.targets)&&p.targets.length&&!p.targets.some(target=>db.hangers.some(h=>h.hangerId===target&&h.wardrobeId===wid)))return false;return true}
function snapshot(user){const w=wardrobeFor(user),ownedHangerIds=new Set(db.hangers.filter(h=>h.wardrobeId===w.id).map(h=>h.hangerId));return{wardrobe:w,gateways:visible(db.gateways,w.id),hangers:visible(db.hangers,w.id),discoveredHangers:discoveredHangers(w.id),garments:visible(db.garments,w.id),events:visible(db.events,w.id).filter(e=>eventReferencesOwnedHardware(e,w.id)).slice(0,100),commands:visible(db.commands,w.id).filter(c=>!c.targets?.length||c.targets.some(target=>ownedHangerIds.has(target))).slice(0,100),serverTime:now()}}
function gatewayOperational(gateway){
  const online=Date.now()-Date.parse(gateway.lastSeen||0)<GATEWAY_OFFLINE;
  const provision=gateway.provisioning&&typeof gateway.provisioning==='object'?gateway.provisioning:{};
  const wifiStatus=provision.wifiStatus==='FAILED'?'FAILED':online&&gateway.ssid?'CONNECTED':'UNKNOWN';
  const cloudStatus=provision.cloudStatus==='FAILED'?'FAILED':online?'CONNECTED':'UNKNOWN';
  const reasons=[];
  if(!online)reasons.push('최근 heartbeat가 없습니다.');
  if(wifiStatus==='FAILED')reasons.push('BLE 설정 후 Wi-Fi 연결 실패가 기록되었습니다.');
  if(cloudStatus==='FAILED')reasons.push('BLE 설정 후 Cloud 통신 실패가 기록되었습니다.');
  if(provision.status==='TIMEOUT'&&wifiStatus!=='FAILED'&&cloudStatus!=='FAILED')reasons.push('BLE 설정 후 heartbeat 확인 시간이 초과되었습니다. Wi-Fi/Cloud 원인은 현재 알 수 없습니다.');
  return {state:online?'ONLINE':'OFFLINE',wifiStatus,cloudStatus,reasons,problem:reasons.length>0,provisioningStatus:provision.status||'UNKNOWN',provisioningAt:provision.at||null,provisioningDetail:provision.detail||''};
}
function releaseGatewayOwnership(gateway){
  const previousWardrobeId=gateway.wardrobeId;
  const releasedHangers=[];
  for(const hanger of db.hangers)if(hanger.gatewayId===gateway.gatewayId&&hanger.wardrobeId===previousWardrobeId){
    hanger.wardrobeId=null;hanger.customName='';syncHangerName(hanger);releasedHangers.push(hanger.hangerId);
  }
  gateway.wardrobeId=null;gateway.customName='';gateway.gatewayNumber=null;syncGatewayName(gateway);
  return {gatewayId:gateway.gatewayId,releasedHangers};
}
function adminOverview(){
  const online=item=>Date.now()-Date.parse(item.lastSeen||0)<OFFLINE;
  const gatewayOnline=item=>Date.now()-Date.parse(item.lastSeen||0)<GATEWAY_OFFLINE;
  const managedUsers=db.users.filter(user=>(user.role||'user')==='user');
  const managedWardrobeIds=new Set(managedUsers.map(user=>wardrobeFor(user)?.id).filter(Boolean));
  const gateways=db.gateways.filter(g=>!simulated(g)&&managedWardrobeIds.has(g.wardrobeId)),hangers=db.hangers.filter(h=>!simulated(h)&&managedWardrobeIds.has(h.wardrobeId)),garments=db.garments.filter(g=>managedWardrobeIds.has(g.wardrobeId)),problems=[];
  const onlineAge=item=>online(item)?'ONLINE':'OFFLINE';
  const users=managedUsers.map(user=>{
    const wardrobe=wardrobeFor(user),ownedGateways=wardrobe?visible(db.gateways,wardrobe.id):[],ownedHangers=wardrobe?visible(db.hangers,wardrobe.id):[],ownedGarments=wardrobe?visible(db.garments,wardrobe.id):[],gatewayIds=new Set(ownedGateways.map(gateway=>gateway.gatewayId));
    const problemDeviceIds=new Set();
    const serializeHanger=(hanger,gateway)=>{
      const garment=ownedGarments.find(item=>item.tagUid===hanger.tagUid&&hanger.state==='PRESENT');
      const hangerState=onlineAge(hanger),nfcStatus=Number(hanger.errorFlags||0)>0?'점검 필요':hanger.firmwareVersion&&hanger.firmwareVersion!=='unknown'?'정상':'알 수 없음';
      const reasons=[];
      if(hangerState==='OFFLINE')reasons.push(`마지막 통신 ${hanger.lastSeen||'알 수 없음'}`);
      if(nfcStatus==='점검 필요')reasons.push('PN532/NFC 점검 필요');
      if(reasons.length){problemDeviceIds.add(`hanger:${hanger.hangerId}`);problems.push({level:hangerState==='OFFLINE'?'problem':'warning',kind:'hanger',userId:user.id,userName:user.name,gatewayId:gateway?.gatewayId||'',hangerId:hanger.hangerId,title:hanger.alias||hanger.hangerId,message:reasons.join(' · ')});}
      return {hangerId:hanger.hangerId,hangerNumber:hanger.hangerNumber||null,name:hanger.alias,customName:hanger.customName||'',gatewayId:gateway?.gatewayId||null,lastGatewayId:hanger.gatewayId||null,state:hangerState,reportedState:hanger.reportedState||hanger.state||'UNKNOWN',nfcStatus,tagDetected:!!hanger.tagUid,garmentName:garment?.name||'',lastSeen:hanger.lastSeen||null,channel:Number.isFinite(Number(hanger.channel))?Number(hanger.channel):null,errorFlags:Number(hanger.errorFlags||0),problem:reasons.length>0,problemReasons:reasons};
    };
    const unassignedRaw=ownedHangers.filter(hanger=>!hanger.gatewayId||!gatewayIds.has(hanger.gatewayId));
    const unassignedHangers=unassignedRaw.map(hanger=>serializeHanger(hanger,null));
    const userGateways=ownedGateways.map(gateway=>{
      const gatewayHangers=ownedHangers.filter(hanger=>hanger.gatewayId===gateway.gatewayId);
      const operational=gatewayOperational(gateway);
      if(operational.problem){problemDeviceIds.add(`gateway:${gateway.gatewayId}`);problems.push({level:'problem',kind:'gateway',userId:user.id,userName:user.name,gatewayId:gateway.gatewayId,title:gateway.name||gateway.gatewayId,message:operational.reasons.join(' · ')});}
      return {gatewayId:gateway.gatewayId,gatewayNumber:gateway.gatewayNumber||null,name:gateway.name,customName:gateway.customName||'',lastSeen:gateway.lastSeen||null,ssid:gateway.ssid||'',rssi:Number.isFinite(Number(gateway.rssi))?Number(gateway.rssi):null,channel:Number.isFinite(Number(gateway.channel))?Number(gateway.channel):null,hangerCount:gatewayHangers.length,hangers:gatewayHangers.map(hanger=>serializeHanger(hanger,gateway)),...operational};
    });
    const recentActivity=[user.lastLoginAt,...ownedGateways.map(g=>g.lastSeen),...ownedHangers.map(h=>h.lastSeen)].reduce((latest,value)=>Math.max(latest,Date.parse(value||0)||0),0);
    return {...userPublic(user),gatewayCount:ownedGateways.length,hangerCount:ownedHangers.length,connectedHangerCount:ownedHangers.length-unassignedHangers.length,unassignedHangerCount:unassignedHangers.length,garmentCount:ownedGarments.length,problemDeviceCount:problemDeviceIds.size,lastActivityAt:recentActivity?new Date(recentActivity).toISOString():null,unassignedHangers,gateways:userGateways};
  });
  users.sort((a,b)=>Number(b.problemDeviceCount)-Number(a.problemDeviceCount)||Number(b.gatewayCount+b.hangerCount)-Number(a.gatewayCount+a.hangerCount)||Date.parse(b.lastActivityAt||0)-Date.parse(a.lastActivityAt||0));
  const adminWardrobeIds=new Set(db.wardrobes.filter(wardrobe=>ownerForWardrobe(wardrobe.id)?.role==='admin').map(wardrobe=>wardrobe.id));
  const adminOwnedGateways=db.gateways.filter(gateway=>!simulated(gateway)&&adminWardrobeIds.has(gateway.wardrobeId)).map(gateway=>({gatewayId:gateway.gatewayId,name:gateway.name||neutralGatewayName(gateway),hangerIds:db.hangers.filter(hanger=>hanger.gatewayId===gateway.gatewayId&&hanger.wardrobeId===gateway.wardrobeId).map(hanger=>hanger.hangerId)}));
  const onlineGateways=gateways.filter(gatewayOnline).length,onlineHangers=hangers.filter(online).length;
  const gatewayIssues=gateways.map(gatewayOperational);
  const wifiFailures=gatewayIssues.filter(item=>item.wifiStatus==='FAILED').length,cloudFailures=gatewayIssues.filter(item=>item.cloudStatus==='FAILED').length,provisioningTimeouts=gatewayIssues.filter(item=>item.provisioningStatus==='TIMEOUT').length;
  const imageStates=garments.reduce((all,garment)=>{const state=String(garment.imageProcessingStatus||'ready');all[state]=(all[state]||0)+1;return all},{});
  const commandFailures=db.commands.filter(command=>managedWardrobeIds.has(command.wardrobeId)&&['TIMEOUT','PARTIAL'].includes(command.status)).slice(0,10);
  for(const command of commandFailures){const owner=ownerForWardrobe(command.wardrobeId);problems.push({level:'warning',kind:'command',userId:owner?.id||'',userName:owner?.name||'알 수 없음',title:'장비 명령 ACK 확인 필요',message:`${command.command||'명령'} 상태: ${command.status}`});}
  if(!cloudImageService.configured())problems.push({level:'warning',kind:'image',title:'Image Worker 미설정',message:'사진 Cloud 처리 환경변수가 완성되지 않았습니다.'});
  const recentDeviceEvents=db.events.filter(event=>managedWardrobeIds.has(event.wardrobeId)&&/^(hanger\.|gateway\.)/.test(String(event.type||''))).slice(0,20).map(event=>({id:event.id,type:event.type,severity:event.severity,at:event.at,wardrobeId:event.wardrobeId||null,deviceId:event.payload?.hangerId||event.payload?.gatewayId||'',state:event.payload?.state||event.payload?.reportedState||''}));
  const nfcReady=hangers.filter(h=>online(h)&&Number(h.errorFlags||0)===0&&h.firmwareVersion&&h.firmwareVersion!=='unknown').length,nfcAttention=hangers.filter(h=>Number(h.errorFlags||0)>0).length;
  return {totals:{users:users.length,gateways:gateways.length,hangers:hangers.length,garments:garments.length,onlineGateways,offlineGateways:gateways.length-onlineGateways,onlineHangers,offlineHangers:hangers.length-onlineHangers,problemUsers:users.filter(user=>user.problemDeviceCount>0).length,problemGateways:gatewayIssues.filter(item=>item.problem).length,problemHangers:hangers.filter(hanger=>onlineAge(hanger)==='OFFLINE'||Number(hanger.errorFlags||0)>0).length,wifiFailures,cloudFailures,provisioningTimeouts},users,problems,system:{backend:{ready:isReady,storage:storage.mode},websocket:{status:sockets.size?'CONNECTED':'UNKNOWN',connectionCount:sockets.size},storage:{status:cloudImageService.configured()?'CONFIGURED':'UNKNOWN'},gateways:{total:gateways.length,online:onlineGateways,offline:gateways.length-onlineGateways,wifiFailures,cloudFailures,provisioningTimeouts},hangers:{total:hangers.length,online:onlineHangers,offline:hangers.length-onlineHangers,nfcReady,nfcAttention},ownershipRecovery:{adminOwnedGateways},imageProcessing:{configured:cloudImageService.configured(),ready:imageStates.ready||0,processing:imageStates.processing||0,pending:imageStates.pending||0,failed:imageStates.failed||0},recentDeviceEvents}};
}
function removeAdminUser(admin,targetUserId){
  const target=db.users.find(user=>user.id===targetUserId);
  if(!target)throw error(404,'사용자를 찾을 수 없습니다.');
  if(target.id===admin.id)throw error(409,'현재 로그인한 관리자 계정은 삭제할 수 없습니다.');
  const wardrobeIds=new Set(db.wardrobes.filter(wardrobe=>wardrobe.userId===target.id).map(wardrobe=>wardrobe.id));
  for(const gateway of db.gateways)if(wardrobeIds.has(gateway.wardrobeId)){gateway.wardrobeId=null;gateway.customName='';syncGatewayName(gateway);}
  for(const hanger of db.hangers)if(wardrobeIds.has(hanger.wardrobeId)){hanger.wardrobeId=null;hanger.gatewayId=null;hanger.customName='';syncHangerName(hanger);}
  const garmentCount=db.garments.filter(garment=>wardrobeIds.has(garment.wardrobeId)).length;
  db.garments=db.garments.filter(garment=>!wardrobeIds.has(garment.wardrobeId));
  db.commands=db.commands.filter(command=>!wardrobeIds.has(command.wardrobeId));
  db.events=db.events.filter(event=>!wardrobeIds.has(event.wardrobeId));
  db.wardrobes=db.wardrobes.filter(wardrobe=>wardrobe.userId!==target.id);
  db.users=db.users.filter(user=>user.id!==target.id);
  revokeAdminSessions(target.id);
  return {deletedUserId:target.id,garmentCount};
}
function json(res,status,data){const payload=status===204?'':JSON.stringify(data);res.writeHead(status,{'content-type':'application/json; charset=utf-8','content-length':Buffer.byteLength(payload),'cache-control':'no-store','access-control-allow-origin':process.env.PUBLIC_ORIGIN||'*','access-control-allow-headers':'authorization,content-type,x-gateway-id,x-admin-session','access-control-allow-methods':'GET,POST,PATCH,DELETE,OPTIONS'});res.end(payload)}
function body(req){return new Promise((ok,no)=>{let s='';req.on('data',x=>{s+=x;if(s.length>1e6)req.destroy()});req.on('end',()=>{try{ok(s?JSON.parse(s):{})}catch{no(error(400,'JSON 형식 오류'))}});req.on('error',no)})}
const match=(url,re)=>new URL(url,'http://x').pathname.match(re);
function staticFile(req,res){const p=decodeURIComponent(new URL(req.url,'http://x').pathname),c=path.resolve(PUBLIC,p==='/'?'index.html':p.slice(1)),f=c.startsWith(PUBLIC+path.sep)&&fs.existsSync(c)&&fs.statSync(c).isFile()?c:path.join(PUBLIC,'index.html'),type={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.svg':'image/svg+xml'}[path.extname(f)]||'application/octet-stream';res.writeHead(200,{'content-type':type});fs.createReadStream(f).pipe(res)}
const server=http.createServer(async(req,res)=>{try{
  const p=new URL(req.url,'http://x').pathname;
  if(req.method==='OPTIONS')return json(res,204);
  // The PWA shell is static. Keep it available even while a newly started
  // function retries its database connection, rather than returning raw JSON
  // for the app's root URL.
  if(!p.startsWith('/api/'))return staticFile(req,res);
  if(p==='/api/health'){
    if(storageInitError)return json(res,200,{ok:false,status:'retrying',storage:storage.mode,ready:false,error:'storage_initializing_retry',serverTime:now()});
    if(!isReady)return json(res,200,{ok:true,status:'initializing',storage:storage.mode,ready:false,serverTime:now()});
    return json(res,200,{ok:true,status:'ready',storage:storage.mode,ready:true,setupRequired:!db.users.length,gatewayOnline:db.gateways.some(g=>Date.now()-Date.parse(g.lastSeen||0)<GATEWAY_OFFLINE),simulationEnabled:SIM,serverTime:now()});
  }
  if(!isReady){
    await initializeStorage();
    if(!isReady)throw error(503,'데이터 연결을 다시 시도 중입니다. 잠시 후 자동으로 다시 연결됩니다.');
  }
  // Vercel may route consecutive requests to different warm instances. PostgreSQL is authoritative.
  await reloadAuthoritativeState();
  // Device ownership is authoritative in PostgreSQL, not in a warm Vercel
  // instance's memory. Refreshing it prevents a stale instance from showing
  // or saving a device that another request has already released.
  await syncDeviceOwnershipState();
  await expireOfflineHangers();
  if(await cloudImageService.handle(req,res,{needUser,wardrobeFor,findGarment:garmentId=>db.garments.find(g=>g.id===garmentId),persist:save,emit}))return;
  if(await garmentImageService.handle(req,res,{needUser}))return;
  if(p==='/api/auth/status'){const u=getUser(req);return json(res,200,{setupRequired:!db.users.length,user:u&&userPublic(u)})}
if(p==='/api/auth/signup'&&req.method==='POST'){const x=await body(req),email=String(x.email||'').trim().toLowerCase(),name=String(x.name||'').trim().slice(0,40),nameKey=name.toLocaleLowerCase('ko-KR');if(!/^\S+@\S+\.\S+$/.test(email)||String(x.password||'').length<10||!name)throw error(400,'이름, 이메일과 10자 이상 비밀번호가 필요합니다.');if(db.users.some(u=>u.email===email))throw error(409,'이미 등록된 이메일입니다.');if(db.users.some(u=>String(u.name||'').trim().toLocaleLowerCase('ko-KR')===nameKey))throw error(409,'이미 사용 중인 사용자명입니다.');const u={id:id('usr'),email,name,passwordHash:hash(x.password),role:isConfiguredAdmin({email})?'admin':'user',createdAt:now(),lastLoginAt:now()};db.users.push(u);makeWardrobe(u);await save();return json(res,201,{token:token(u),user:userPublic(u)})}
if(p==='/api/auth/login'&&req.method==='POST'){const x=await body(req),loginId=String(x.email||'').trim(),email=loginId.toLowerCase(),nameKey=loginId.toLocaleLowerCase('ko-KR'),u=db.users.find(v=>v.email===email||String(v.name||'').trim().toLocaleLowerCase('ko-KR')===nameKey);if(!u||!safe(hash(x.password,u.passwordHash.split(':')[0]),u.passwordHash))throw error(401,'가입 아이디(또는 이메일)나 비밀번호가 맞지 않습니다.');u.lastLoginAt=now();u.role=isConfiguredAdmin(u)?'admin':'user';revokeAdminSessions(u.id);await save();return json(res,200,{token:token(u),user:userPublic(u)})}
if(p==='/api/admin/status'&&req.method==='GET'){const u=needUser(req);if(u.role!=='admin')throw error(403,'관리자 권한이 필요합니다.');return json(res,200,{admin:true,verified:adminVerified(req,u),expiresAt:null})}
if(p==='/api/admin/verify'&&req.method==='POST'){const u=needUser(req);if(u.role!=='admin')throw error(403,'관리자 권한이 필요합니다.');if(!ADMIN_SECONDARY_PASSWORD)throw error(503,'관리자 2차 인증이 아직 설정되지 않았습니다.');const x=await body(req);if(!safe(String(x.password||''),ADMIN_SECONDARY_PASSWORD))throw error(403,'관리자 인증에 실패했습니다.');const session=issueAdminSession(u);return json(res,200,{ok:true,adminSession:session.proof,expiresAt:new Date(session.expiresAt).toISOString()})}
if(p==='/api/admin/logout'&&req.method==='POST'){const u=needUser(req);if(u.role!=='admin')throw error(403,'관리자 권한이 필요합니다.');const key=adminSessionKey(req.headers['x-admin-session']);const session=adminSessions.get(key);if(session?.userId===u.id)adminSessions.delete(key);return json(res,200,{ok:true})}
if(p==='/api/admin/overview'){requireAdmin(req);return json(res,200,adminOverview())}
if(p==='/api/admin/system'){requireAdmin(req);return json(res,200,{system:adminOverview().system})}
const adminGatewayRelease=match(req.url,/^\/api\/admin\/gateways\/([^/]+)\/release$/);if(adminGatewayRelease&&req.method==='POST'){const admin=requireAdmin(req),gatewayId=decodeURIComponent(adminGatewayRelease[1]).toUpperCase(),gateway=db.gateways.find(item=>item.gatewayId===gatewayId);if(!gateway)throw error(404,'옷봉을 찾을 수 없습니다.');const owner=ownerForWardrobe(gateway.wardrobeId);if(!owner||owner.role!=='admin'||owner.id!==admin.id)throw error(409,'관리자 계정에 잘못 귀속된 옷봉만 등록 해제할 수 있습니다.');await storage.releaseGatewayOwnership(gatewayId,gateway.wardrobeId);const result=releaseGatewayOwnership(gateway);emit('gateway.admin_released',{gatewayId:result.gatewayId,releasedHangers:result.releasedHangers},'warning');await save();return json(res,200,{ok:true,...result})}
const adminUserDelete=match(req.url,/^\/api\/admin\/users\/([^/]+)$/);if(adminUserDelete&&req.method==='DELETE'){const admin=requireAdmin(req),result=removeAdminUser(admin,decodeURIComponent(adminUserDelete[1]));await save();return json(res,200,{ok:true,...result})}
if(p==='/api/snapshot'){const u=needUser(req);return json(res,200,snapshot(u))}
const pairingStatus=match(req.url,/^\/api\/(gateways|hangers)\/([^/]+)\/pairing-status$/);if(pairingStatus&&req.method==='GET'){const u=needUser(req),kind=pairingStatus[1],key=decodeURIComponent(pairingStatus[2]).toUpperCase(),list=kind==='gateways'?db.gateways:db.hangers,field=kind==='gateways'?'gatewayId':'hangerId',item=list.find(value=>value[field]===key);return json(res,200,pairingLabel(kind,item,u))}
if(p==='/api/garments'&&req.method==='POST'){const u=needUser(req),w=wardrobeFor(u),x=await body(req),tagUid=uid(x.tagUid);if(!String(x.name||'').trim()||tagUid.length<8)throw error(400,'옷 이름과 NFC UID가 필요합니다.');if(db.garments.some(g=>g.wardrobeId===w.id&&g.tagUid===tagUid))throw error(409,'이 NFC 태그는 이미 내 옷장에 등록되어 있습니다.');const g={id:id('garment'),name:String(x.name).slice(0,80),tagUid,category:String(x.category||''),color:String(x.color||''),season:String(x.season||''),brand:String(x.brand||''),memo:String(x.memo||''),imageUrl:String(x.imageUrl||''),originalImagePath:'',processedImagePath:'',imageProcessingStatus:'ready',classification:{},classificationConfidence:{},processingError:'',currentState:'OUT',currentHanger:null,createdBy:u.id,wardrobeId:w.id,createdAt:now()};db.garments.push(g);reconcile();emit('garment.created',g,'info',w.id);await save();return json(res,201,g)}
const gd=match(req.url,/^\/api\/garments\/([^/]+)$/);if(gd&&req.method==='DELETE'){const u=needUser(req),w=wardrobeFor(u),i=db.garments.findIndex(g=>g.id===gd[1]&&g.wardrobeId===w.id);if(i<0)throw error(404,'내 옷장에서 옷을 찾을 수 없습니다.');const g=db.garments.splice(i,1)[0];reconcile();emit('garment.deleted',{id:g.id,tagUid:g.tagUid},'info',w.id);await save();return json(res,200,{ok:true,deletedId:g.id})}
const find=match(req.url,/^\/api\/garments\/([^/]+)\/find$/);if(find&&req.method==='POST'){const u=needUser(req),w=wardrobeFor(u),g=db.garments.find(g=>g.id===find[1]&&g.wardrobeId===w.id);if(!g?.currentHanger)throw error(409,'이 옷은 현재 옷장에 없습니다.');const c=command([g.currentHanger],u);await save();return json(res,202,c)}
if(p==='/api/commands'&&req.method==='POST'){const u=needUser(req),x=await body(req),c=command(x.targets,u,x.durationMs,x.command);await save();return json(res,202,c)}
const claimIntent=match(req.url,/^\/api\/(gateways|hangers)\/([^/]+)\/claim-intent$/);if(claimIntent&&req.method==='POST'){const u=needUser(req),kind=claimIntent[1],key=decodeURIComponent(claimIntent[2]);return json(res,200,{claimToken:issueDeviceClaimIntent(u,kind,key),expiresInMs:15000})}
const claim=match(req.url,/^\/api\/(gateways|hangers)\/([^/]+)\/claim$/);if(claim&&req.method==='POST'){const u=needUser(req),w=wardrobeFor(u),confirmation=await body(req),kind=claim[1],key=decodeURIComponent(claim[2]).toUpperCase();if(!verifyDeviceClaimIntent(confirmation.claimToken,u,kind,key))throw error(400,'화면에서 장비 등록을 다시 눌러 확인해 주세요.');const list=kind==='gateways'?db.gateways:db.hangers,field=kind==='gateways'?'gatewayId':'hangerId',item=list.find(v=>v[field]===key);if(!item)throw error(404,'장비 신호를 아직 받지 못했습니다. 전원을 확인한 뒤 다시 시도하세요.');if(item.wardrobeId&&item.wardrobeId!==w.id){const owner=ownerForWardrobe(item.wardrobeId);throw error(409,`이미 다른 계정에 등록된 장비입니다. (소유자: ${maskOwnerName(owner?.name)})`);}const needsInitialPair=kind==='hangers'&&!item.wardrobeId;let gatewayId=null;if(kind==='hangers'){const gateway=db.gateways.find(g=>g.gatewayId===item.gatewayId&&g.wardrobeId===w.id);if(!gateway)throw error(409,'먼저 같은 계정의 옷봉과 연결하세요.');gatewayId=gateway.gatewayId;}const claimed=await storage.claimDeviceOwnership(kind==='gateways'?'gateway':'hanger',key,w.id,gatewayId);if(!claimed.ok){const owner=ownerForWardrobe(claimed.wardrobeId);throw error(409,`이미 다른 계정에 등록된 장비입니다. (소유자: ${maskOwnerName(owner?.name)})`);}if(kind==='gateways')assignGateway(item,w.id);else{assignHanger(item,w.id,gatewayId);if(needsInitialPair)pairingCommand([key],u)}reconcile();emit(`${kind}.claimed`,item,'info',w.id);await save();return json(res,200,item)}
const provision=match(req.url,/^\/api\/gateways\/([^/]+)\/provisioning-status$/);if(provision&&req.method==='POST'){const u=needUser(req),w=wardrobeFor(u),gatewayId=decodeURIComponent(provision[1]).toUpperCase(),gateway=db.gateways.find(item=>item.gatewayId===gatewayId&&item.wardrobeId===w.id);if(!gateway)throw error(404,'내 옷봉을 찾을 수 없습니다.');const x=await body(req);gateway.provisioning={status:'TIMEOUT',wifiStatus:'UNKNOWN',cloudStatus:'UNKNOWN',detail:String(x.detail||'BLE 설정 후 heartbeat 확인 시간이 초과되었습니다.').slice(0,240),at:now()};emit('gateway.provisioning.timeout',{gatewayId,provisioning:gateway.provisioning},'warning',w.id);await save();return json(res,200,gateway)}
const device=match(req.url,/^\/api\/(gateways|hangers)\/([^/]+)$/);if(device&&req.method==='PATCH'){const u=needUser(req),w=wardrobeFor(u),x=await body(req),kind=device[1],key=decodeURIComponent(device[2]),list=kind==='gateways'?db.gateways:db.hangers,field=kind==='gateways'?'gatewayId':'hangerId',item=list.find(v=>v[field]===key&&v.wardrobeId===w.id);if(!item)throw error(404,kind==='gateways'?'내 옷봉을 찾을 수 없습니다.':'내 옷걸이를 찾을 수 없습니다.');const name=String(x.name??x.alias??'').trim().slice(0,40);if(name){if(kind==='gateways'){item.customName=name;syncGatewayName(item)}else{item.customName=name;syncHangerName(item)}}else if(x.resetName===true){if(kind==='gateways'){item.customName='';syncGatewayName(item)}else{item.customName='';syncHangerName(item)}}else throw error(400,'이름을 입력하세요.');if(kind==='hangers'&&x.gatewayId&&x.gatewayId!==item.gatewayId){const target=db.gateways.find(g=>g.gatewayId===String(x.gatewayId).toUpperCase()&&g.wardrobeId===w.id);if(!target)throw error(404,'대상 옷봉을 찾을 수 없습니다.');assignHanger(item,w.id,target.gatewayId,{moved:true});}emit(`${kind}.updated`,item,'info',w.id);await save();return json(res,200,item)}
if(device&&req.method==='DELETE'){
  const u=needUser(req),w=wardrobeFor(u),kind=device[1],key=decodeURIComponent(device[2]),list=kind==='gateways'?db.gateways:db.hangers,field=kind==='gateways'?'gatewayId':'hangerId',i=list.findIndex(v=>v[field]===key&&v.wardrobeId===w.id);
  if(i<0)throw error(404,'내 장비를 찾을 수 없습니다.');
  const item=list[i],releasedHangerIds=new Set();
  if(kind==='gateways'){
    const released=await storage.releaseGatewayOwnership(item.gatewayId,w.id);
    for(const hangerId of released.releasedHangerIds||[])releasedHangerIds.add(hangerId);
    item.resetPending='FACTORY_RESET';
    for(const h of db.hangers)if(h.gatewayId===item.gatewayId&&h.wardrobeId===w.id){releasedHangerIds.add(h.hangerId);h.wardrobeId=null;h.gatewayId=null;h.hangerNumber=null;h.tagUid=null;h.reportedState='EMPTY';h.state='EMPTY';h.customName='';syncHangerName(h)}
    item.gatewayNumber=null;
  }else{
    await storage.releaseHangerOwnership(item.hangerId,w.id);
    const upstream=db.gateways.find(g=>g.gatewayId===item.gatewayId);
    if(upstream){const pending=new Set(Array.isArray(upstream.pendingHangerResets)?upstream.pendingHangerResets:[]);pending.add(item.hangerId);upstream.pendingHangerResets=[...pending];}
    releasedHangerIds.add(item.hangerId);item.wardrobeId=null;item.gatewayId=null;item.hangerNumber=null;item.tagUid=null;item.reportedState='EMPTY';item.state='EMPTY';item.customName='';syncHangerName(item);
  }
  for(const g of db.garments)if(g.wardrobeId===w.id&&releasedHangerIds.has(g.currentHanger)){g.currentState='OUT';g.currentHanger=null}
  db.commands=db.commands.filter(c=>c.wardrobeId!==w.id||!c.targets?.some(target=>releasedHangerIds.has(target)));
  db.events=db.events.filter(e=>e.wardrobeId!==w.id||!(e.payload?.gatewayId===item.gatewayId||releasedHangerIds.has(e.payload?.hangerId)||e.payload?.targets?.some(target=>releasedHangerIds.has(target))));
  item.wardrobeId=null;item.customName='';if(kind==='gateways')syncGatewayName(item);
  emit(`${kind}.removed`,{[field]:key},'warning',w.id);await save();return json(res,200,{ok:true});
}
if(p==='/api/gateway/status'&&req.method==='POST'){needDevice(req);const x=status(await body(req));await save();return json(res,200,x)}if(p==='/api/gateway/status/batch'&&req.method==='POST'){needDevice(req);const x=statusBatch((await body(req)).items);await save();return json(res,200,{items:x})}if(p==='/api/gateway/heartbeat'&&req.method==='POST'){needDevice(req);const x=heartbeat(await body(req));await save();return json(res,200,x)}
if(p==='/api/gateway/commands'){needDevice(req);const gatewayId=String(req.headers['x-gateway-id']||'').toUpperCase(),gateway=db.gateways.find(g=>g.gatewayId===gatewayId),wid=gatewayOwner(gatewayId),resets=[];if(gateway?.resetPending==='FACTORY_RESET'){resets.push({numericId:0,command:'FACTORY_RESET',targets:[],durationMs:0});gateway.resetPending=null;}for(const hangerId of gateway?.pendingHangerResets||[])resets.push({numericId:0,command:'UNPAIR',targets:[hangerId],durationMs:0});if(gateway)gateway.pendingHangerResets=[];const cs=db.commands.filter(c=>wid&&c.wardrobeId===wid&&['QUEUED','SENT','PARTIAL'].includes(c.status)&&Date.parse(c.expiresAt)>Date.now()&&c.targets.some(t=>db.hangers.some(h=>h.hangerId===t&&h.gatewayId===gatewayId)));for(const c of cs){c.status='SENT';c.sentAt=now();console.log(`[COMMAND] SENT id=${c.numericId} gateway=${gatewayId} targets=${c.targets.join(',')}`)}json(res,200,{commands:[...resets,...cs]});if(resets.length||cs.length)save().catch(e=>console.error('[COMMAND] command status save failed',e.message));return}
if(p==='/api/gateway/ack'&&req.method==='POST'){needDevice(req);const a=await body(req),c=db.commands.find(x=>x.numericId===Number(a.commandId));if(!c)throw error(404,'명령이 없습니다.');const h=String(a.hangerId).toUpperCase();if(!c.targets.includes(h))throw error(400,'명령 대상 오류');if(c.status==='CANCELLED')return json(res,200,{...c,ignored:true});c.acknowledgements[h]={result:a.result||'ERROR',errorCode:Number(a.errorCode||0),at:now()};c.status=c.targets.every(t=>c.acknowledgements[t]?.result==='OK')?'ACKED':'PARTIAL';console.log(`[COMMAND] ACK id=${c.numericId} hanger=${h} result=${c.acknowledgements[h].result}`);emit('command.ack',c,'info',c.wardrobeId);await save();return json(res,200,c)}
if(p.startsWith('/api/'))throw error(404,'API를 찾을 수 없습니다.');return staticFile(req,res)}catch(e){console.error('[ERROR]',e.message);json(res,e.status||500,{error:e.message})}});
const wss=new WebSocketServer({noServer:true});server.on('upgrade',(req,socket,head)=>{ready.then(async()=>{await expireOfflineHangers();const u=new URL(req.url,'http://x');const protocols=String(req.headers['sec-websocket-protocol']||'').split(',').map(value=>value.trim());const credential=protocols.find(value=>value.startsWith('wardrobe-token.'))||'';req.headers.authorization=`Bearer ${credential.slice('wardrobe-token.'.length)}`;const account=getUser(req);if(u.pathname!=='/ws'||!account)return socket.destroy();wss.handleUpgrade(req,socket,head,ws=>wss.emit('connection',ws,account))}).catch(()=>socket.destroy())});wss.on('connection',(ws,account)=>{ws.wardrobeId=wardrobeFor(account).id;sockets.add(ws);ws.send(JSON.stringify({type:'snapshot',payload:snapshot(account)}));ws.on('close',()=>sockets.delete(ws))});
if(process.env.DISABLE_BACKGROUND_TASKS!=='true')setInterval(async()=>{let dirty=false;for(const h of db.hangers)if(h.state!=='OFFLINE'&&Date.parse(h.lastSeen||0)<Date.now()-OFFLINE){h.reportedState=h.state='OFFLINE';emit('hanger.offline',h,'warning',h.wardrobeId);dirty=true}for(const c of db.commands)if(!['ACKED','TIMEOUT','CANCELLED'].includes(c.status)&&Date.parse(c.expiresAt)<Date.now()){c.status='TIMEOUT';emit('command.timeout',c,'warning',c.wardrobeId);dirty=true}if(dirty){reconcile();await save()}},1000).unref();
if(require.main===module)server.listen(PORT,'0.0.0.0',()=>console.log(`[BOOT] Smart Wardrobe http://0.0.0.0:${PORT}`));
module.exports={server,uid,hash,status,reconcile,ready,closeStorage:()=>storage.close()};
