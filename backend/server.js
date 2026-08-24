'use strict';
// The public entrypoint uses the account-isolated wardrobe implementation.
const implementation=require('./server-v3');
module.exports=implementation;
// Render discovers web services through an IPv4 listener. Bind explicitly
// instead of relying on Node's platform-dependent omitted-host default.
if(require.main===module){
  const port=Number(process.env.PORT||8787);
  const bootStart=Date.now();
  implementation.server.listen(port,'0.0.0.0',()=>{
    console.log(`[BOOT] HTTP listening on 0.0.0.0:${port} (process started in ${Date.now()-bootStart}ms)`);
  });
}
