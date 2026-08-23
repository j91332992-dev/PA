'use strict';
const http=require('http'),fs=require('fs'),path=require('path'),crypto=require('crypto');
const {createStorage}=require('./storage');
const {WebSocketServer}=require('ws');
const garmentImageService=require('./garment-image-service');
const ROOT=path.resolve(__dirname,'..');
function loadEnv(file){if(!fs.existsSync(file))return;for(const line of fs.readFileSync(file,'utf8').split(/\r?\n/)){const i=line.indexOf('=');if(i>0&&line[0]!=='#'&&!(line.slice(0,i).trim() in process.env))process.env[line.slice(0,i).trim()]=line.slice(i+1).trim();}}
loadEnv(path.join(ROOT,'.env'));
const PORT=Number(process.env.PORT||8787),DATA=path.resolve(ROOT,process.env.DATA_PATH||'data/wardrobe.json'),PUBLIC=path.join(ROOT,'web','public');
const SECRET=process.env.JWT_SECRET||'development-secret',DEVICE=process.env.DEVICE_TOKEN||'development-device-token';
const OFFLINE=Number(process.env.OFFLINE_TIMEOUT_MS||30000),CMD_TIMEOUT=Number(process.env.COMMAND_TIMEOUT_MS||15000),SIM=process.env.SIMULATION_ENABLED==='true';
const now=()=>new Date().toISOString(),id=p=>`${p}_${crypto.randomUUID()}`,uid=x=>String(x||'').replace(/[^0-9a-f]/gi,'').toUpperCase();
const initial=()=>({schemaVersion:3,users:[],wardrobes:[],gateways:[],hangers:[],garments:[],events:[],commands:[]});
let db=initial();const storage=createStorage({file:DATA,initial});function save(){return storage.save(db)}
const safe=(a,b)=>{const x=Buffer.from(String(a)),y=Buffer.from(String(b));return x.length===y.length&&crypto.timingSafeEqual(x,y)};
function hash(p,s=crypto.randomBytes(16).toString('hex')){return `${s}:${crypto.pbkdf2Sync(p,s,210000,32,'sha256').toString('hex')}`}
function error(status,message){const e=new Error(message);e.status=status;return e}
function wardrobeFor(user){return db.wardrobes.find(w=>w.userId===user.id)}
function makeWardrobe(user){const w={id:id('wd'),userId:user.id,name:`${user.name||'나'}의 스마트 옷장`,createdAt:now()};db.wardrobes.push(w);return w}
function simulated(x){return /^GW-SIM/i.test(x.gatewayId||'')||/^HC-00000[1-5]$/i.test(x.hangerId||'')}
function migrate(){
  db.wardrobes=Array.isArray(db.wardrobes)?db.wardrobes:[];
  for(const u of db.users)if(!wardrobeFor(u))makeWardrobe(u);
  const byUser=new Map(db.users.map(u=>[u.id,wardrobeFor(u)?.id]));
  for(const g of db.garments)if(!g.wardrobeId)g.wardrobeId=byUser.get(g.createdBy)||db.wardrobes[0]?.id||null;
  const ownerByTag=new Map(db.garments.map(g=>[g.tagUid,g.wardrobeId]));
  // Older single-wardrobe data can be EMPTY at the moment of migration, so no
  // NFC UID is available to link the real hanger. In that case retain it for
  // the legacy account that owns the most imported garments (never a simulator).
  const ownershipCount=new Map();for(const garment of db.garments)ownershipCount.set(garment.wardrobeId,(ownershipCount.get(garment.wardrobeId)||0)+1);
  const legacyOwner=[...ownershipCount.entries()].sort((a,b)=>b[1]-a[1])[0]?.[0]||null;
  for(const h of db.hangers)if(!h.wardrobeId)h.wardrobeId=ownerByTag.get(h.tagUid)||null;
  for(const g of db.gateways)if(!g.wardrobeId){const hs=db.hangers.filter(h=>h.gatewayId===g.gatewayId&&h.wardrobeId);g.wardrobeId=hs[0]?.wardrobeId||null;}
  for(const h of db.hangers)if(!h.wardrobeId)h.wardrobeId=db.gateways.find(g=>g.gatewayId===h.gatewayId)?.wardrobeId||null;
  for(const g of db.gateways)if(!g.wardrobeId&&!simulated(g))g.wardrobeId=legacyOwner;
  for(const h of db.hangers)if(!h.wardrobeId&&!simulated(h))h.wardrobeId=db.gateways.find(g=>g.gatewayId===h.gatewayId)?.wardrobeId||legacyOwner;
  // Give newly discovered physical hardware a readable default. Preserve any
  // name the owner has already chosen in the dashboard.
  for(const w of db.wardrobes){const owner=db.users.find(u=>u.id===w.userId),ownerName=owner?.name||'내';const gateways=db.gateways.filter(g=>g.wardrobeId===w.id&&!simulated(g));for(const g of gateways)if(!g.name||g.name==='새 옷봉'||g.name==='Gateway')g.name=`${ownerName}의 옷봉`;const hangers=db.hangers.filter(h=>h.wardrobeId===w.id&&!simulated(h)).sort((a,b)=>String(a.createdAt||a.hangerId).localeCompare(String(b.createdAt||b.hangerId)));hangers.forEach((h,index)=>{if(!h.alias||/^HC-/i.test(h.alias))h.alias=`${ownerName}의 옷걸이 ${index+1}번`})}
  for(const c of db.commands)if(!c.wardrobeId){const h=db.hangers.find(h=>c.targets?.includes(h.hangerId));c.wardrobeId=h?.wardrobeId||byUser.get(c.requestedBy)||null;}
  const changed = db.schemaVersion !== 3;
  db.schemaVersion = 3;
  return changed;
}
let isReady = false;
let storageInitError = null;
const loadStartTime = Date.now();
const ready = storage.load().then(loaded => {
  db = loaded;
  const dirty = migrate();
  if (dirty) return save();
}).then(() => {
  isReady = true;
  console.log(`[STORAGE] ${storage.mode} ready in ${Date.now() - loadStartTime}ms`);
}).catch(error => {
  storageInitError = error.message;
  console.error(`[STORAGE] ${storage.mode} init failed: ${error.message}`);
});
function token(user){const p=Buffer.from(JSON.stringify({sub:user.id,exp:Date.now()+604800000})).toString('base64url');return `${p}.${crypto.createHmac('sha256',SECRET).update(p).digest('base64url')}`}
function getUser(req){const [p,s]=String(req.headers.authorization||'').replace(/^Bearer /,'').split('.');if(!p||!s||!safe(s,crypto.createHmac('sha256',SECRET).update(p).digest('base64url')))return null;try{const x=JSON.parse(Buffer.from(p,'base64url'));return x.exp>Date.now()?db.users.find(u=>u.id===x.sub):null}catch{return null}}
function needUser(req){const u=getUser(req);if(!u)throw error(401,'로그인이 필요합니다.');return u}
function needDevice(req){if(!safe(req.headers.authorization||'',`Bearer ${DEVICE}`))throw error(401,'옷봉 인증에 실패했습니다.')}
const sockets=new Set();
function emit(type,payload,severity='info',wardrobeId=payload?.wardrobeId){const e={id:id('evt'),type,severity,payload:structuredClone(payload),wardrobeId:wardrobeId||null,at:now()};db.events.unshift(e);db.events=db.events.slice(0,1000);const msg=JSON.stringify({type,payload,at:e.at});for(const ws of sockets)if(ws.readyState===1&&ws.wardrobeId===e.wardrobeId)ws.send(msg)}
function reconcile(){
  const seen=new Map();for(const h of db.hangers)if(h.reportedState==='PRESENT'&&h.tagUid){const k=`${h.wardrobeId}:${h.tagUid}`,a=seen.get(k)||[];a.push(h);seen.set(k,a)}
  for(const h of db.hangers){const same=seen.get(`${h.wardrobeId}:${h.tagUid}`)||[];if(h.reportedState==='OFFLINE')h.state='OFFLINE';else if(h.reportedState==='PRESENT'&&same.length>1)h.state='CONFLICT';else if(h.reportedState==='PRESENT'&&!db.garments.some(g=>g.wardrobeId===h.wardrobeId&&g.tagUid===h.tagUid))h.state='UNKNOWN_TAG';else h.state=h.reportedState;}
  for(const g of db.garments){const h=db.hangers.find(h=>h.wardrobeId===g.wardrobeId&&h.tagUid===g.tagUid&&h.state==='PRESENT');g.currentState=h?'IN_WARDROBE':'OUT';g.currentHanger=h?.hangerId||null;if(h)g.lastSeen=h.lastSeen;}
}
function gatewayOwner(gatewayId){return db.gateways.find(g=>g.gatewayId===gatewayId)?.wardrobeId||null}
function attachGateway(gatewayId){let g=db.gateways.find(x=>x.gatewayId===gatewayId);if(!g){g={gatewayId,name:'새 옷봉',createdAt:now(),wardrobeId:db.wardrobes.length===1?db.wardrobes[0].id:null};db.gateways.push(g)}return g}
function status(x){const hangerId=String(x.hangerId||'').toUpperCase(),state=String(x.state||'').toUpperCase(),sequence=Number(x.sequence),bootId=String(x.bootId||'legacy'),gatewayId=String(x.gatewayId||'GW-UNKNOWN').toUpperCase();if(!/^HC-[0-9A-F]{6,12}$/.test(hangerId))throw error(400,'hangerId 형식 오류');if(!['PRESENT','EMPTY','UNKNOWN_TAG','UNSTABLE'].includes(state)||!Number.isSafeInteger(sequence)||sequence<0)throw error(400,'옷걸이 상태 형식 오류');const gateway=attachGateway(gatewayId);let h=db.hangers.find(v=>v.hangerId===hangerId);if(!h){h={hangerId,alias:'',createdAt:now(),lastSequence:-1,wardrobeId:gateway.wardrobeId||null};db.hangers.push(h)}if(!h.wardrobeId&&gateway.wardrobeId)h.wardrobeId=gateway.wardrobeId;if(h.bootId===bootId&&sequence<=h.lastSequence)return{hanger:h,duplicate:true};Object.assign(h,{reportedState:state,state,tagUid:uid(x.tagUid)||null,lastSeen:now(),lastSequence:sequence,bootId,channel:Number(x.channel||0),rssi:Number(x.rssi||0),errorFlags:Number(x.errorFlags||0),firmwareVersion:String(x.firmwareVersion||'unknown'),gatewayId});Object.assign(gateway,{state:'ONLINE',lastSeen:h.lastSeen,channel:h.channel,firmwareVersion:String(x.gatewayFirmwareVersion||'unknown')});reconcile();emit('hanger.state',h,'info',h.wardrobeId);return{hanger:h,duplicate:false}}
function heartbeat(x){const gatewayId=String(x.gatewayId||'').toUpperCase();if(!/^GW-[0-9A-F]{6,12}$/.test(gatewayId))throw error(400,'gatewayId 형식 오류');const g=attachGateway(gatewayId);Object.assign(g,{state:'ONLINE',lastSeen:now(),channel:Number(x.channel||0),firmwareVersion:String(x.firmwareVersion||'unknown'),ssid:String(x.ssid||g.ssid||''),rssi:Number(x.rssi||g.rssi||0),ip:String(x.ip||g.ip||'')});emit('gateway.heartbeat',g,'info',g.wardrobeId);return g}
function command(targets,user,duration=0,kind='LED_BLINK'){const w=wardrobeFor(user);targets=[...new Set((targets||[]).map(x=>String(x).toUpperCase()))];if(!targets.length||targets.length>16)throw error(400,'대상은 1~16개여야 합니다.');for(const t of targets)if(!db.hangers.some(h=>h.hangerId===t&&h.wardrobeId===w.id))throw error(404,`내 옷장에 없는 옷걸이: ${t}`);const c={id:id('cmd'),numericId:crypto.randomInt(1,2147483647),command:String(kind).toUpperCase()==='LED_OFF'?'LED_OFF':'LED_BLINK',targets,durationMs:Math.max(0,Math.min(120000,Number(duration)||0)),status:'QUEUED',requestedBy:user.id,wardrobeId:w.id,createdAt:now(),expiresAt:new Date(Date.now()+CMD_TIMEOUT).toISOString(),acknowledgements:{}};db.commands.unshift(c);emit('command.queued',c,'info',w.id);return c}
function visible(list,wid){return list.filter(x=>x.wardrobeId===wid&&(SIM||!simulated(x)))}
function snapshot(user){const w=wardrobeFor(user);return{wardrobe:w,gateways:visible(db.gateways,w.id),hangers:visible(db.hangers,w.id),garments:visible(db.garments,w.id),events:visible(db.events,w.id).slice(0,100),commands:visible(db.commands,w.id).slice(0,100),serverTime:now()}}
function json(res,status,data){res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','access-control-allow-origin':process.env.PUBLIC_ORIGIN||'*','access-control-allow-headers':'authorization,content-type,x-gateway-id','access-control-allow-methods':'GET,POST,PATCH,DELETE,OPTIONS'});res.end(status===204?'':JSON.stringify(data))}
function body(req){return new Promise((ok,no)=>{let s='';req.on('data',x=>{s+=x;if(s.length>1e6)req.destroy()});req.on('end',()=>{try{ok(s?JSON.parse(s):{})}catch{no(error(400,'JSON 형식 오류'))}});req.on('error',no)})}
const match=(url,re)=>new URL(url,'http://x').pathname.match(re);
function staticFile(req,res){const p=decodeURIComponent(new URL(req.url,'http://x').pathname),c=path.resolve(PUBLIC,p==='/'?'index.html':p.slice(1)),f=c.startsWith(PUBLIC+path.sep)&&fs.existsSync(c)&&fs.statSync(c).isFile()?c:path.join(PUBLIC,'index.html'),type={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.svg':'image/svg+xml'}[path.extname(f)]||'application/octet-stream';res.writeHead(200,{'content-type':type});fs.createReadStream(f).pipe(res)}
const server=http.createServer(async(req,res)=>{try{
  const p=new URL(req.url,'http://x').pathname;
  if(req.method==='OPTIONS')return json(res,204);
  if(p==='/api/health'){
    if(storageInitError)return json(res,503,{ok:false,status:'error',storage:storage.mode,ready:false,error:'storage_init_failed',serverTime:now()});
    if(!isReady)return json(res,200,{ok:true,status:'initializing',storage:storage.mode,ready:false,serverTime:now()});
    return json(res,200,{ok:true,status:'ready',storage:storage.mode,ready:true,setupRequired:!db.users.length,gatewayOnline:db.gateways.some(g=>Date.now()-Date.parse(g.lastSeen||0)<OFFLINE),simulationEnabled:SIM,serverTime:now()});
  }
  if(storageInitError)throw error(503,'스토리지 초기화에 실패했습니다.');
  if(!isReady)await ready;
  if(await garmentImageService.handle(req,res,{needUser}))return;
  if(p==='/api/auth/status'){const u=getUser(req);return json(res,200,{setupRequired:!db.users.length,user:u&&{id:u.id,email:u.email,name:u.name}})}
if(p==='/api/auth/signup'&&req.method==='POST'){const x=await body(req);if(!/^\S+@\S+\.\S+$/.test(x.email||'')||String(x.password||'').length<10)throw error(400,'이메일과 10자 이상 비밀번호가 필요합니다.');if(db.users.some(u=>u.email===String(x.email).toLowerCase()))throw error(409,'이미 등록된 이메일입니다.');const u={id:id('usr'),email:String(x.email).toLowerCase(),name:String(x.name||'사용자').slice(0,40),passwordHash:hash(x.password),createdAt:now()};db.users.push(u);makeWardrobe(u);await save();return json(res,201,{token:token(u),user:{id:u.id,email:u.email,name:u.name}})}
if(p==='/api/auth/login'&&req.method==='POST'){const x=await body(req),u=db.users.find(v=>v.email===String(x.email||'').toLowerCase());if(!u||!safe(hash(x.password,u.passwordHash.split(':')[0]),u.passwordHash))throw error(401,'이메일 또는 비밀번호가 맞지 않습니다.');return json(res,200,{token:token(u),user:{id:u.id,email:u.email,name:u.name}})}
if(p==='/api/snapshot'){const u=needUser(req);return json(res,200,snapshot(u))}
if(p==='/api/garments'&&req.method==='POST'){const u=needUser(req),w=wardrobeFor(u),x=await body(req),tagUid=uid(x.tagUid);if(!String(x.name||'').trim()||tagUid.length<8)throw error(400,'옷 이름과 NFC UID가 필요합니다.');if(db.garments.some(g=>g.wardrobeId===w.id&&g.tagUid===tagUid))throw error(409,'이 NFC 태그는 이미 내 옷장에 등록되어 있습니다.');const g={id:id('garment'),name:String(x.name).slice(0,80),tagUid,category:String(x.category||''),color:String(x.color||''),season:String(x.season||''),brand:String(x.brand||''),memo:String(x.memo||''),imageUrl:String(x.imageUrl||''),currentState:'OUT',currentHanger:null,createdBy:u.id,wardrobeId:w.id,createdAt:now()};db.garments.push(g);reconcile();emit('garment.created',g,'info',w.id);await save();return json(res,201,g)}
const gd=match(req.url,/^\/api\/garments\/([^/]+)$/);if(gd&&req.method==='DELETE'){const u=needUser(req),w=wardrobeFor(u),i=db.garments.findIndex(g=>g.id===gd[1]&&g.wardrobeId===w.id);if(i<0)throw error(404,'내 옷장에서 옷을 찾을 수 없습니다.');const g=db.garments.splice(i,1)[0];reconcile();emit('garment.deleted',{id:g.id,tagUid:g.tagUid},'info',w.id);await save();return json(res,200,{ok:true,deletedId:g.id})}
const find=match(req.url,/^\/api\/garments\/([^/]+)\/find$/);if(find&&req.method==='POST'){const u=needUser(req),w=wardrobeFor(u),g=db.garments.find(g=>g.id===find[1]&&g.wardrobeId===w.id);if(!g?.currentHanger)throw error(409,'이 옷은 현재 옷장에 없습니다.');const c=command([g.currentHanger],u);await save();return json(res,202,c)}
if(p==='/api/commands'&&req.method==='POST'){const u=needUser(req),x=await body(req),c=command(x.targets,u,x.durationMs,x.command);await save();return json(res,202,c)}
const claim=match(req.url,/^\/api\/(gateways|hangers)\/([^/]+)\/claim$/);if(claim&&req.method==='POST'){const u=needUser(req),w=wardrobeFor(u),kind=claim[1],key=decodeURIComponent(claim[2]),list=kind==='gateways'?db.gateways:db.hangers,field=kind==='gateways'?'gatewayId':'hangerId',item=list.find(v=>v[field]===key);if(!item)throw error(404,'장비 신호를 아직 받지 못했습니다. 전원을 확인한 뒤 다시 시도하세요.');if(item.wardrobeId&&item.wardrobeId!==w.id)throw error(409,'이미 다른 계정의 옷장에 등록된 장비입니다.');item.wardrobeId=w.id;if(kind==='gateways'){if(!item.name||item.name==='새 옷봉')item.name=`${u.name||'내'}의 옷봉`;for(const h of db.hangers)if(h.gatewayId===item.gatewayId&&!h.wardrobeId)h.wardrobeId=w.id;}else if(!item.alias||/^HC-/i.test(item.alias)){const count=db.hangers.filter(h=>h.wardrobeId===w.id&&!simulated(h)).sort((a,b)=>String(a.createdAt||a.hangerId).localeCompare(String(b.createdAt||b.hangerId))).indexOf(item)+1;item.alias=`${u.name||'내'}의 옷걸이 ${Math.max(1,count)}번`;}emit(`${kind}.claimed`,item,'info',w.id);await save();return json(res,200,item)}
const device=match(req.url,/^\/api\/(gateways|hangers)\/([^/]+)$/);if(device&&req.method==='PATCH'){const u=needUser(req),w=wardrobeFor(u),x=await body(req),kind=device[1],key=decodeURIComponent(device[2]),list=kind==='gateways'?db.gateways:db.hangers,field=kind==='gateways'?'gatewayId':'hangerId',item=list.find(v=>v[field]===key&&v.wardrobeId===w.id);if(!item)throw error(404,kind==='gateways'?'내 옷봉을 찾을 수 없습니다.':'내 옷걸이를 찾을 수 없습니다.');const name=String(x.name??x.alias??'').trim().slice(0,40);if(!name)throw error(400,'이름을 입력하세요.');if(kind==='gateways')item.name=name;else item.alias=name;emit(`${kind}.updated`,item,'info',w.id);await save();return json(res,200,item)}
if(device&&req.method==='DELETE'){const u=needUser(req),w=wardrobeFor(u),kind=device[1],key=decodeURIComponent(device[2]),list=kind==='gateways'?db.gateways:db.hangers,field=kind==='gateways'?'gatewayId':'hangerId',i=list.findIndex(v=>v[field]===key&&v.wardrobeId===w.id);if(i<0)throw error(404,'내 장비를 찾을 수 없습니다.');const item=list[i];if(kind==='gateways'){for(const h of db.hangers)if(h.gatewayId===item.gatewayId&&h.wardrobeId===w.id)h.wardrobeId=null;}else{item.wardrobeId=null;item.alias='';}item.wardrobeId=null;emit(`${kind}.removed`,{[field]:key},'warning',w.id);await save();return json(res,200,{ok:true})}
if(p==='/api/gateway/status'&&req.method==='POST'){needDevice(req);const x=status(await body(req));await save();return json(res,200,x)}if(p==='/api/gateway/heartbeat'&&req.method==='POST'){needDevice(req);const x=heartbeat(await body(req));await save();return json(res,200,x)}
if(p==='/api/gateway/commands'){needDevice(req);const gatewayId=String(req.headers['x-gateway-id']||'').toUpperCase(),wid=gatewayOwner(gatewayId);const cs=db.commands.filter(c=>wid&&c.wardrobeId===wid&&['QUEUED','SENT','PARTIAL'].includes(c.status)&&Date.parse(c.expiresAt)>Date.now()&&c.targets.some(t=>db.hangers.some(h=>h.hangerId===t&&h.gatewayId===gatewayId)));for(const c of cs){c.status='SENT';c.sentAt=now()}if(cs.length)await save();return json(res,200,{commands:cs})}
if(p==='/api/gateway/ack'&&req.method==='POST'){needDevice(req);const a=await body(req),c=db.commands.find(x=>x.numericId===Number(a.commandId));if(!c)throw error(404,'명령이 없습니다.');const h=String(a.hangerId).toUpperCase();if(!c.targets.includes(h))throw error(400,'명령 대상 오류');c.acknowledgements[h]={result:a.result||'ERROR',errorCode:Number(a.errorCode||0),at:now()};c.status=c.targets.every(t=>c.acknowledgements[t]?.result==='OK')?'ACKED':'PARTIAL';emit('command.ack',c,'info',c.wardrobeId);await save();return json(res,200,c)}
if(p.startsWith('/api/'))throw error(404,'API를 찾을 수 없습니다.');return staticFile(req,res)}catch(e){console.error('[ERROR]',e.message);json(res,e.status||500,{error:e.message})}});
const wss=new WebSocketServer({noServer:true});server.on('upgrade',(req,socket,head)=>{ready.then(()=>{const u=new URL(req.url,'http://x');req.headers.authorization=`Bearer ${u.searchParams.get('token')||''}`;const account=getUser(req);if(u.pathname!=='/ws'||!account)return socket.destroy();wss.handleUpgrade(req,socket,head,ws=>wss.emit('connection',ws,account))}).catch(()=>socket.destroy())});wss.on('connection',(ws,account)=>{ws.wardrobeId=wardrobeFor(account).id;sockets.add(ws);ws.send(JSON.stringify({type:'snapshot',payload:snapshot(account)}));ws.on('close',()=>sockets.delete(ws))});
if(process.env.DISABLE_BACKGROUND_TASKS!=='true')setInterval(async()=>{let dirty=false;for(const h of db.hangers)if(h.state!=='OFFLINE'&&Date.parse(h.lastSeen||0)<Date.now()-OFFLINE){h.reportedState=h.state='OFFLINE';emit('hanger.offline',h,'warning',h.wardrobeId);dirty=true}for(const c of db.commands)if(!['ACKED','TIMEOUT'].includes(c.status)&&Date.parse(c.expiresAt)<Date.now()){c.status='TIMEOUT';emit('command.timeout',c,'warning',c.wardrobeId);dirty=true}if(dirty){reconcile();await save()}},1000).unref();
if(require.main===module)server.listen(PORT,'0.0.0.0',()=>console.log(`[BOOT] Smart Wardrobe http://0.0.0.0:${PORT}`));
module.exports={server,uid,hash,status,reconcile,ready,closeStorage:()=>storage.close()};
