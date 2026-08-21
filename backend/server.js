'use strict';
const http=require('http'),fs=require('fs'),path=require('path'),crypto=require('crypto');
const {WebSocketServer}=require('ws');
const {spawn}=require('child_process');
const ROOT=path.resolve(__dirname,'..');
function env(file){if(!fs.existsSync(file))return;for(const raw of fs.readFileSync(file,'utf8').split(/\r?\n/)){const line=raw.trim(),at=line.indexOf('=');if(line&&line[0]!=='#'&&at>0&&!(line.slice(0,at) in process.env))process.env[line.slice(0,at)]=line.slice(at+1).trim();}}
env(path.join(ROOT,'.env'));
const PORT=Number(process.env.PORT||8787),DATA=path.resolve(ROOT,process.env.DATA_PATH||'data/wardrobe.json'),PUBLIC=path.join(ROOT,'web','public'),GARMENT_IMAGE_ROOT=path.resolve(ROOT,process.env.GARMENT_IMAGE_PATH||'data/garment-images');
const BACKGROUND_DEMO_ROOT=path.resolve(ROOT,process.env.BG_DEMO_ROOT||'tools/background-removal-demo'),BACKGROUND_DEMO_SCRIPT=path.join(BACKGROUND_DEMO_ROOT,'server.py'),BACKGROUND_DEMO_PYTHON=process.env.BG_DEMO_PYTHON||path.join(BACKGROUND_DEMO_ROOT,process.platform==='win32'?'.venv\\Scripts\\python.exe':'.venv/bin/python'),BACKGROUND_DEMO_HOST=process.env.BG_DEMO_HOST||'127.0.0.1',BACKGROUND_DEMO_PORT=Number(process.env.BG_DEMO_PORT||8790);
const SECRET=process.env.JWT_SECRET||'development-secret',DEVICE=process.env.DEVICE_TOKEN||'development-device-token',OFFLINE=Number(process.env.OFFLINE_TIMEOUT_MS||30000),CMD_TIMEOUT=Number(process.env.COMMAND_TIMEOUT_MS||15000),SIMULATION_ENABLED=process.env.SIMULATION_ENABLED!=='false';
if(process.env.NODE_ENV==='production'&&(SECRET==='development-secret'||DEVICE==='development-device-token'))console.warn('[SECURITY WARNING] Production 환경에서 기본 development-secret/token이 사용 중입니다. .env에서 JWT_SECRET 및 DEVICE_TOKEN을 설정하세요.');
let backgroundProcess=null,backgroundStartPromise=null;
const initial=()=>({schemaVersion:2,users:[],wardrobe:{id:'main',name:'내 스마트 옷장'},gateways:[],hangers:[],garments:[],events:[],commands:[]});
fs.mkdirSync(path.dirname(DATA),{recursive:true});let db=initial();if(fs.existsSync(DATA))try{db={...db,...JSON.parse(fs.readFileSync(DATA,'utf8'))}}catch{fs.copyFileSync(DATA,`${DATA}.corrupt-${Date.now()}`)}
let writes=Promise.resolve();function save(){const text=JSON.stringify(db,null,2);return writes=writes.then(()=>{fs.writeFileSync(DATA+'.tmp',text);if(fs.existsSync(DATA))fs.copyFileSync(DATA,DATA+'.bak');fs.renameSync(DATA+'.tmp',DATA)})}
const now=()=>new Date().toISOString(),id=p=>`${p}_${crypto.randomUUID()}`,uid=x=>String(x||'').replace(/[^0-9a-f]/gi,'').toUpperCase();
const safe=(a,b)=>{const x=Buffer.from(String(a)),y=Buffer.from(String(b));return x.length===y.length&&crypto.timingSafeEqual(x,y)};
function hash(p,s=crypto.randomBytes(16).toString('hex')){return `${s}:${crypto.pbkdf2Sync(p,s,210000,32,'sha256').toString('hex')}`}
function token(user){const p=Buffer.from(JSON.stringify({sub:user.id,exp:Date.now()+604800000})).toString('base64url');return `${p}.${crypto.createHmac('sha256',SECRET).update(p).digest('base64url')}`}
function user(req){const [p,s]=String(req.headers.authorization||'').replace(/^Bearer /,'').split('.');if(!p||!s||!safe(s,crypto.createHmac('sha256',SECRET).update(p).digest('base64url')))return null;try{const x=JSON.parse(Buffer.from(p,'base64url'));return x.exp>Date.now()?db.users.find(u=>u.id===x.sub):null}catch{return null}}
function needUser(req){const u=user(req);if(!u)throw error(401,'로그인이 필요합니다.');return u}function needDevice(req){if(!safe(req.headers.authorization||'',`Bearer ${DEVICE}`))throw error(401,'게이트웨이 인증 실패');}
const sockets=new Set();function emit(type,payload,severity='info'){const e={id:id('evt'),type,severity,payload:structuredClone(payload),at:now()};db.events.unshift(e);db.events=db.events.slice(0,1000);const msg=JSON.stringify({type,payload,at:e.at});for(const ws of sockets)if(ws.readyState===1)ws.send(msg)}
function reconcile(){const seen=new Map();for(const h of db.hangers)if(h.reportedState==='PRESENT'&&h.tagUid){const a=seen.get(h.tagUid)||[];a.push(h);seen.set(h.tagUid,a)}for(const h of db.hangers){if(h.reportedState==='OFFLINE')h.state='OFFLINE';else if(h.reportedState==='PRESENT'&&seen.get(h.tagUid)?.length>1)h.state='CONFLICT';else if(h.reportedState==='PRESENT'&&!db.garments.some(g=>g.tagUid===h.tagUid))h.state='UNKNOWN_TAG';else h.state=h.reportedState}for(const g of db.garments){const h=db.hangers.find(x=>x.tagUid===g.tagUid&&x.state==='PRESENT');g.currentState=h?'IN_WARDROBE':'OUT';g.currentHanger=h?.hangerId||null;if(h)g.lastSeen=h.lastSeen}}
function status(x){const hangerId=String(x.hangerId||'').toUpperCase(),state=String(x.state||'').toUpperCase(),sequence=Number(x.sequence),bootId=String(x.bootId||'legacy');if(!/^HC-[0-9A-F]{6,12}$/.test(hangerId))throw error(400,'hangerId 형식 오류');if(!['PRESENT','EMPTY','UNKNOWN_TAG','UNSTABLE'].includes(state))throw error(400,'state 형식 오류');if(!Number.isSafeInteger(sequence)||sequence<0)throw error(400,'sequence 형식 오류');let h=db.hangers.find(v=>v.hangerId===hangerId);if(!h){h={hangerId,alias:hangerId,createdAt:now(),lastSequence:-1};db.hangers.push(h)}if(h.bootId===bootId&&sequence<=h.lastSequence)return{hanger:h,duplicate:true};Object.assign(h,{reportedState:state,state,tagUid:uid(x.tagUid)||null,lastSeen:now(),lastSequence:sequence,bootId,channel:Number(x.channel||0),rssi:Number(x.rssi||0),errorFlags:Number(x.errorFlags||0),firmwareVersion:String(x.firmwareVersion||'unknown'),gatewayId:String(x.gatewayId||'GW-UNKNOWN')});let g=db.gateways.find(v=>v.gatewayId===h.gatewayId);if(!g){g={gatewayId:h.gatewayId,name:'Gateway',createdAt:now()};db.gateways.push(g)}Object.assign(g,{state:'ONLINE',lastSeen:h.lastSeen,channel:h.channel,firmwareVersion:String(x.gatewayFirmwareVersion||'unknown')});reconcile();emit('hanger.state',h);return{hanger:h,duplicate:false}}
function newCommand(targets,by,duration=0,cmdType='LED_BLINK'){targets=[...new Set((targets||[]).map(x=>String(x).toUpperCase()))];if(!targets.length||targets.length>16)throw error(400,'대상은 1~16개여야 합니다.');for(const t of targets)if(!db.hangers.some(h=>h.hangerId===t))throw error(404,`없는 옷걸이 ${t}`);const command=String(cmdType||'LED_BLINK').toUpperCase()==='LED_OFF'?'LED_OFF':'LED_BLINK';let durationMs=0;if(command==='LED_BLINK'){const rawDur=Number(duration);durationMs=isNaN(rawDur)||rawDur<=0?0:Math.max(1000,Math.min(120000,rawDur));}const c={id:id('cmd'),numericId:crypto.randomInt(1,2147483647),command,targets,durationMs,status:'QUEUED',requestedBy:by,createdAt:now(),expiresAt:new Date(Date.now()+CMD_TIMEOUT).toISOString(),acknowledgements:{}};db.commands.unshift(c);emit('command.queued',c);return c}
const snap=()=>({wardrobe:db.wardrobe,gateways:db.gateways,hangers:db.hangers,garments:db.garments,events:db.events.slice(0,100),commands:db.commands.slice(0,100),serverTime:now()});
function error(status,message){const e=new Error(message);e.status=status;return e}function json(res,status,x){res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','access-control-allow-origin':process.env.PUBLIC_ORIGIN||'*','access-control-allow-headers':'authorization,content-type,x-gateway-id','access-control-allow-methods':'GET,POST,PATCH,DELETE,OPTIONS'});res.end(status===204?'':JSON.stringify(x))}
function body(req){return new Promise((ok,no)=>{let s='';req.on('data',x=>{s+=x;if(s.length>1e6)req.destroy()});req.on('end',()=>{try{ok(s?JSON.parse(s):{})}catch{no(error(400,'JSON 오류'))}});req.on('error',no)})}const match=(url,re)=>new URL(url,'http://x').pathname.match(re);
function file(req,res){const p=decodeURIComponent(new URL(req.url,'http://x').pathname),candidate=path.resolve(PUBLIC,p==='/'?'index.html':p.slice(1)),f=candidate.startsWith(PUBLIC+path.sep)&&fs.existsSync(candidate)&&fs.statSync(candidate).isFile()?candidate:path.join(PUBLIC,'index.html'),type={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.svg':'image/svg+xml'}[path.extname(f)]||'application/octet-stream';res.writeHead(200,{'content-type':type});fs.createReadStream(f).pipe(res)}
function rawBody(req,limit=12*1024*1024){return new Promise((resolve,reject)=>{const chunks=[];let total=0,settled=false;const fail=e=>{if(settled)return;settled=true;reject(e)};req.on('data',chunk=>{if(settled)return;total+=chunk.length;if(total>limit){fail(error(413,'파일이 12MB를 초과했습니다.'));req.resume();return}chunks.push(chunk)});req.on('end',()=>{if(!settled){settled=true;resolve(Buffer.concat(chunks))}});req.on('error',fail)})}
function upstreamHeader(headers,name){return headers[name.toLowerCase()]||headers[name]||''}
function writeUpstreamResponse(res,result){const headers={...result.headers};delete headers.connection;res.writeHead(result.statusCode||502,headers);res.end(result.body)}
function backgroundRequestBody(raw,contentType,matting='0',upstreamPath=''){
  return startBackgroundService().then(()=>new Promise((resolve,reject)=>{
    const chunks=[];
    const targetPath=upstreamPath||`/api/remove?model=birefnet-general-lite&matting=${matting==='1'?'1':'0'}`;
    const upstream=http.request({hostname:BACKGROUND_DEMO_HOST,port:BACKGROUND_DEMO_PORT,path:targetPath,method:'POST',headers:{'content-type':contentType,'content-length':raw.length,accept:'*/*'}},response=>{
      response.on('data',chunk=>chunks.push(chunk));
      response.on('end',()=>resolve({statusCode:response.statusCode||502,headers:response.headers,body:Buffer.concat(chunks)}));
    });
    upstream.setTimeout(180000,()=>upstream.destroy(error(504,'BiRefNet 처리 시간이 초과되었습니다.')));
    upstream.once('error',reject);
    upstream.end(raw);
  }));
}
function serveGarmentImage(req,res){
  const prefix='/api/garments/images/',pathname=decodeURIComponent(new URL(req.url,'http://x').pathname),name=pathname.startsWith(prefix)?pathname.slice(prefix.length):'';
  if(!/^[0-9a-f-]{36}\.png$/i.test(name))return json(res,404,{error:'이미지를 찾을 수 없습니다.'});
  const filePath=path.resolve(GARMENT_IMAGE_ROOT,name);
  if(!filePath.startsWith(GARMENT_IMAGE_ROOT+path.sep)||!fs.existsSync(filePath)||!fs.statSync(filePath).isFile())return json(res,404,{error:'이미지를 찾을 수 없습니다.'});
  const stat=fs.statSync(filePath);res.writeHead(200,{'content-type':'image/png','content-length':stat.size,'cache-control':'private, max-age=31536000, immutable'});fs.createReadStream(filePath).pipe(res);
}
function removeGarmentImage(imageUrl){
  const prefix='/api/garments/images/',value=String(imageUrl||'');
  if(!value.startsWith(prefix))return;
  const name=value.slice(prefix.length).split('?')[0];
  if(!/^[0-9a-f-]{36}\.png$/i.test(name))return;
  const filePath=path.resolve(GARMENT_IMAGE_ROOT,name);
  if(filePath.startsWith(GARMENT_IMAGE_ROOT+path.sep))try{fs.rmSync(filePath,{force:true})}catch{}
}
async function uploadGarmentImage(req,res){
  try{
    needUser(req);
    const contentType=String(req.headers['content-type']||'');
    if(!contentType.toLowerCase().startsWith('multipart/form-data'))throw error(415,'multipart/form-data 업로드만 지원합니다.');
    if(Number(req.headers['content-length']||0)>12*1024*1024)throw error(413,'파일이 12MB를 초과했습니다.');
    const raw=await rawBody(req),result=await backgroundRequestBody(raw,contentType,'0');
    if(result.statusCode!==200)return writeUpstreamResponse(res,result);
    if(!String(upstreamHeader(result.headers,'content-type')).toLowerCase().startsWith('image/png'))throw error(502,'BiRefNet 서버가 PNG 결과를 반환하지 않았습니다.');
    fs.mkdirSync(GARMENT_IMAGE_ROOT,{recursive:true});
    const name=`${crypto.randomUUID()}.png`,filePath=path.join(GARMENT_IMAGE_ROOT,name);
    fs.writeFileSync(filePath,result.body);
    return json(res,201,{imageUrl:`/api/garments/images/${name}`,model:upstreamHeader(result.headers,'x-model')||'birefnet-general-lite',processMs:Number(upstreamHeader(result.headers,'x-process-ms')||0),width:Number(upstreamHeader(result.headers,'x-image-width')||0),height:Number(upstreamHeader(result.headers,'x-image-height')||0)});
  }catch(e){return json(res,e.status||500,{error:e.message||'옷 사진 처리 중 오류가 발생했습니다.'})}
}
async function proxyGarmentClassification(req,res){
  try{
    const contentType=String(req.headers['content-type']||'');
    if(!contentType.toLowerCase().startsWith('multipart/form-data'))throw error(415,'multipart/form-data 업로드만 지원합니다.');
    if(Number(req.headers['content-length']||0)>12*1024*1024)throw error(413,'파일이 12MB를 초과했습니다.');
    const raw=await rawBody(req),result=await backgroundRequestBody(raw,contentType,'0','/api/classify');
    return writeUpstreamResponse(res,result);
  }catch(e){return json(res,e.status||500,{error:e.message||'옷 속성 분류 중 오류가 발생했습니다.'})}
}
function backgroundHealth(){return new Promise(resolve=>{const request=http.get({hostname:BACKGROUND_DEMO_HOST,port:BACKGROUND_DEMO_PORT,path:'/api/health',timeout:700},response=>{response.resume();resolve(response.statusCode===200)});request.on('timeout',()=>{request.destroy();resolve(false)});request.on('error',()=>resolve(false))})}
function wait(ms){return new Promise(resolve=>setTimeout(resolve,ms))}
function startBackgroundService(){
  if(process.env.NODE_ENV==='production')return Promise.reject(error(404,'배경 제거 실험은 개발 환경에서만 사용할 수 있습니다.'));
  if(backgroundStartPromise)return backgroundStartPromise;
  backgroundStartPromise=(async()=>{
    if(await backgroundHealth())return;
    if(!fs.existsSync(BACKGROUND_DEMO_PYTHON))throw error(503,`BiRefNet 로컬 실행 환경을 찾을 수 없습니다: ${BACKGROUND_DEMO_PYTHON}`);
    if(!fs.existsSync(BACKGROUND_DEMO_SCRIPT))throw error(503,`BiRefNet 서버 파일을 찾을 수 없습니다: ${BACKGROUND_DEMO_SCRIPT}`);
    backgroundProcess=spawn(BACKGROUND_DEMO_PYTHON,[BACKGROUND_DEMO_SCRIPT],{cwd:BACKGROUND_DEMO_ROOT,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,REMBG_HOME:path.join(BACKGROUND_DEMO_ROOT,'.models'),BG_DEMO_HOST:BACKGROUND_DEMO_HOST,BG_DEMO_PORT:String(BACKGROUND_DEMO_PORT),PYTHONUNBUFFERED:'1'}});
    backgroundProcess.stdout.on('data',chunk=>process.stdout.write(`[BG] ${chunk}`));
    backgroundProcess.stderr.on('data',chunk=>process.stderr.write(`[BG] ${chunk}`));
    backgroundProcess.once('error',childError=>console.error(`[BG] start error: ${childError.message}`));
    backgroundProcess.once('exit',(code,signal)=>{if(backgroundProcess?.pid===undefined)return;console.log(`[BG] stopped code=${code} signal=${signal||'none'}`);backgroundProcess=null});
    for(let attempt=0;attempt<120;attempt+=1){if(await backgroundHealth())return;await wait(250)}
    throw error(503,'BiRefNet 로컬 서버가 준비되지 않았습니다. Python/rembg 환경을 확인하세요.');
  })().finally(()=>{backgroundStartPromise=null});
  return backgroundStartPromise;
}
function backgroundStatus(req,res){
  if(process.env.NODE_ENV==='production')return json(res,404,{error:'배경 제거 실험은 개발 환경에서만 사용할 수 있습니다.'});
  return startBackgroundService().then(()=>json(res,200,{ok:true,engine:'rembg',model:'birefnet-general-lite',provider:'CPUExecutionProvider',processing:'laptop-local-server',storage:'memory-only'})).catch(e=>json(res,e.status||503,{error:e.message}));
}
function proxyBackgroundRemoval(req,res){
  if(process.env.NODE_ENV==='production')return json(res,404,{error:'배경 제거 실험은 개발 환경에서만 사용할 수 있습니다.'});
  const contentLength=Number(req.headers['content-length']||0);
  if(contentLength>12*1024*1024)return json(res,413,{error:'파일이 12MB를 초과했습니다.'});
  return startBackgroundService().then(()=>new Promise((resolve,reject)=>{
    const requested=new URL(req.url,'http://x').searchParams;
    const matting=requested.get('matting')==='1'?'1':'0';
    const upstream=http.request({hostname:BACKGROUND_DEMO_HOST,port:BACKGROUND_DEMO_PORT,path:`/api/remove?model=birefnet-general-lite&matting=${matting}`,method:'POST',headers:{'content-type':req.headers['content-type'],'content-length':req.headers['content-length'],'accept':req.headers.accept||'*/*'}},response=>{
      const headers={...response.headers};
      delete headers.connection;
      res.writeHead(response.statusCode||502,headers);
      response.pipe(res);
      response.once('end',resolve);
    });
    upstream.setTimeout(180000,()=>{upstream.destroy(error(504,'BiRefNet 처리 시간이 초과되었습니다.'))});
    upstream.once('error',errorValue=>{if(!res.headersSent)json(res,errorValue.status||502,{error:'로컬 BiRefNet 서버에 연결하지 못했습니다.'});reject(errorValue)});
    req.pipe(upstream);
  })).catch(e=>{if(!res.headersSent)json(res,e.status||502,{error:e.message||'로컬 BiRefNet 서버에 연결하지 못했습니다.'})});
}
function stopBackgroundService(){if(backgroundProcess&&!backgroundProcess.killed){backgroundProcess.kill();backgroundProcess=null}}
process.once('exit',stopBackgroundService);

let devGateway=null;
function getDevGateway(){
  if(!SIMULATION_ENABLED)return null;
  if(!devGateway){
    const{VirtualGateway}=require('../simulator/virtual-hardware');
    const port=server.address()?.port||PORT;
    devGateway=new VirtualGateway({baseUrl:`http://127.0.0.1:${port}`,deviceToken:DEVICE,pollIntervalMs:800,heartbeatIntervalMs:4000,silent:true});
    devGateway.start();
  }else if(server.address()?.port){
    devGateway.baseUrl=`http://127.0.0.1:${server.address().port}`;
  }
  return devGateway;
}

const server=http.createServer(async(req,res)=>{try{const p=new URL(req.url,'http://x').pathname;if(req.method==='OPTIONS')return json(res,204);if(p==='/api/health')return json(res,200,{ok:true,setupRequired:!db.users.length,gatewayOnline:db.gateways.some(g=>Date.now()-Date.parse(g.lastSeen||0)<OFFLINE),simulationEnabled:SIMULATION_ENABLED,serverTime:now()});if(p==='/api/auth/status')return json(res,200,{setupRequired:!db.users.length,user:user(req)?{id:user(req).id,email:user(req).email,name:user(req).name}:null});if(p==='/api/auth/signup'&&req.method==='POST'){const x=await body(req);if(!/^\S+@\S+\.\S+$/.test(x.email||'')||String(x.password||'').length<10)throw error(400,'이메일과 10자 이상 비밀번호 필요');if(db.users.some(u=>u.email===String(x.email||'').toLowerCase()))throw error(409,'이미 등록된 이메일입니다.');const u={id:id('usr'),email:x.email.toLowerCase(),name:String(x.name||'사용자').slice(0,40),passwordHash:hash(x.password),createdAt:now()};db.users.push(u);await save();return json(res,201,{token:token(u),user:{id:u.id,email:u.email,name:u.name}})}if(p==='/api/auth/login'&&req.method==='POST'){const x=await body(req),u=db.users.find(v=>v.email===String(x.email||'').toLowerCase());if(!u||!safe(hash(x.password,u.passwordHash.split(':')[0]),u.passwordHash))throw error(401,'로그인 실패');return json(res,200,{token:token(u),user:{id:u.id,email:u.email,name:u.name}})}if(p==='/api/snapshot'){needUser(req);return json(res,200,snap())}if(p==='/api/garments'&&req.method==='POST'){const u=needUser(req),x=await body(req),tagUid=uid(x.tagUid);if(!String(x.name||'').trim()||tagUid.length<8)throw error(400,'이름/UID 필요');if(db.garments.some(g=>g.tagUid===tagUid))throw error(409,'UID 중복');const g={id:id('garment'),name:String(x.name).slice(0,80),tagUid,category:String(x.category||''),color:String(x.color||''),season:String(x.season||''),brand:String(x.brand||''),memo:String(x.memo||''),imageUrl:String(x.imageUrl||''),currentState:'OUT',currentHanger:null,createdBy:u.id,createdAt:now()};db.garments.push(g);reconcile();emit('garment.created',g);await save();return json(res,201,g)}const gDel=match(req.url,/^\/api\/garments\/([^/]+)$/);if(gDel&&req.method==='DELETE'){needUser(req);const idx=db.garments.findIndex(x=>x.id===gDel[1]);if(idx===-1)throw error(404,'옷을 찾을 수 없습니다.');const removed=db.garments.splice(idx,1)[0];removeGarmentImage(removed.imageUrl);reconcile();emit('garment.deleted',{id:removed.id,tagUid:removed.tagUid});await save();return json(res,200,{ok:true,deletedId:removed.id})}const find=match(req.url,/^\/api\/garments\/([^/]+)\/find$/);if(find&&req.method==='POST'){const u=needUser(req),g=db.garments.find(x=>x.id===find[1]);if(!g?.currentHanger)throw error(409,'옷장 안에 없는 옷');const c=newCommand([g.currentHanger],u.id);await save();return json(res,202,c)}if(p==='/api/commands'&&req.method==='POST'){const u=needUser(req),x=await body(req),c=newCommand(x.targets,u.id,x.durationMs,x.command);await save();return json(res,202,c)}if(p==='/api/gateway/status'&&req.method==='POST'){needDevice(req);const x=status(await body(req));await save();return json(res,200,x)}if(p==='/api/gateway/commands'){needDevice(req);const cs=db.commands.filter(c=>['QUEUED','SENT','PARTIAL'].includes(c.status)&&Date.parse(c.expiresAt)>Date.now());for(const c of cs){c.status='SENT';c.sentAt=now()}if(cs.length)await save();return json(res,200,{commands:cs})}if(p==='/api/gateway/ack'&&req.method==='POST'){needDevice(req);const a=await body(req),c=db.commands.find(x=>x.numericId===Number(a.commandId));if(!c)throw error(404,'명령 없음');const h=String(a.hangerId).toUpperCase();if(!c.targets.includes(h))throw error(400,'ACK 대상 오류');c.acknowledgements[h]={result:a.result||'ERROR',errorCode:Number(a.errorCode||0),at:now()};c.status=c.targets.every(t=>c.acknowledgements[t]?.result==='OK')?'ACKED':'PARTIAL';emit('command.ack',c);await save();return json(res,200,c)}if(p==='/api/dev/simulation'&&req.method==='GET'){needUser(req);if(!SIMULATION_ENABLED)throw error(404,'Simulation 비활성화');const gw=getDevGateway();return json(res,200,{enabled:true,hangers:gw?gw.getStatusSummary():[]})}if(p==='/api/dev/simulation/action'&&req.method==='POST'){needUser(req);if(!SIMULATION_ENABLED)throw error(404,'Simulation 비활성화');const gw=getDevGateway();if(!gw)throw error(500,'Gateway 초기화 실패');const b=await body(req),action=String(b.action||'').toLowerCase(),hId=String(b.hangerId||'').toUpperCase();if(action==='tag-insert')await gw.tagInsert(hId,b.tagUid);else if(action==='tag-remove')await gw.tagRemove(hId);else if(action==='tag-change')await gw.tagChange(hId,b.tagUid);else if(action==='online')await gw.setOnline(hId,true);else if(action==='offline')await gw.setOnline(hId,false);else if(action==='ack-mode')gw.setAckMode(hId,b.mode);else if(action==='duplicate')await gw.sendDuplicate(hId);else throw error(400,`알 수 없는 action: ${action}`);return json(res,200,{ok:true,hangers:gw.getStatusSummary()})}if(p==='/api/dev/simulation/reset'&&req.method==='POST'){needUser(req);if(!SIMULATION_ENABLED)throw error(404,'Simulation 비활성화');const gw=getDevGateway(),valid=['HC-000001','HC-000002','HC-000003','HC-000004','HC-000005'];db.hangers=db.hangers.filter(h=>valid.includes(h.hangerId)||!h.hangerId.startsWith('HC-'));for(const hid of valid){let h=db.hangers.find(x=>x.hangerId===hid);if(!h){h={hangerId:hid,alias:hid,createdAt:now(),lastSequence:-1};db.hangers.push(h)}Object.assign(h,{reportedState:'EMPTY',state:'EMPTY',tagUid:null,lastSeen:now(),lastSequence:0,bootId:'sim-reset',channel:6,rssi:-45,errorFlags:0,firmwareVersion:'1.0.0',gatewayId:'GW-SIM001'})}db.gateways=db.gateways.filter(g=>g.gatewayId==='GW-SIM001'||(!g.gatewayId.startsWith('GW-TEST')&&!g.gatewayId.startsWith('GW-LOAD')));let simGw=db.gateways.find(g=>g.gatewayId==='GW-SIM001');if(!simGw){simGw={gatewayId:'GW-SIM001',name:'Virtual Gateway',createdAt:now(),state:'ONLINE',lastSeen:now(),channel:6,firmwareVersion:'1.0.0'};db.gateways.push(simGw)}else Object.assign(simGw,{state:'ONLINE',lastSeen:now()});if(gw){gw.reset()}db.events=(db.events||[]).slice(0,50);reconcile();emit('snapshot',snap());await save();return json(res,200,{ok:true,message:'시뮬레이션 데이터가 초기화되었습니다.',snapshot:snap()})}if(p.startsWith('/api/'))throw error(404,'API 없음');return file(req,res)}catch(e){console.error('[ERROR]',e.message);json(res,e.status||500,{error:e.message})}});
const originalRequestHandler=server.listeners('request')[0];server.removeAllListeners('request');server.on('request',(req,res)=>{const p=new URL(req.url,'http://x').pathname;if(req.method==='GET'&&p==='/api/dev/background-removal/status')return backgroundStatus(req,res);if(req.method==='POST'&&p==='/api/dev/background-removal')return proxyBackgroundRemoval(req,res);if(req.method==='POST'&&p==='/api/dev/background-removal/classify')return proxyGarmentClassification(req,res);if(req.method==='POST'&&p==='/api/garments/image')return uploadGarmentImage(req,res);if(req.method==='GET'&&p.startsWith('/api/garments/images/'))return serveGarmentImage(req,res);return originalRequestHandler(req,res)});
const wss=new WebSocketServer({noServer:true});server.on('upgrade',(req,socket,head)=>{const u=new URL(req.url,'http://x');req.headers.authorization='Bearer '+(u.searchParams.get('token')||'');if(u.pathname!=='/ws'||!user(req))return socket.destroy();wss.handleUpgrade(req,socket,head,ws=>wss.emit('connection',ws))});wss.on('connection',ws=>{sockets.add(ws);ws.send(JSON.stringify({type:'snapshot',payload:snap()}));ws.on('close',()=>sockets.delete(ws))});
setInterval(async()=>{let dirty=false;for(const h of db.hangers)if(h.state!=='OFFLINE'&&Date.parse(h.lastSeen)<Date.now()-OFFLINE){h.reportedState=h.state='OFFLINE';emit('hanger.offline',h,'warning');dirty=true}for(const c of db.commands)if(!['ACKED','TIMEOUT'].includes(c.status)&&Date.parse(c.expiresAt)<Date.now()){c.status='TIMEOUT';emit('command.timeout',c,'warning');dirty=true}if(dirty){reconcile();await save()}},1000).unref();
if(require.main===module)server.listen(PORT,()=>console.log(`[BOOT] Smart Wardrobe http://localhost:${PORT}`));module.exports={server,uid,hash,status,reconcile};
