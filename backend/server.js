'use strict';
// The public entrypoint uses the account-isolated wardrobe implementation.
const implementation=require('./server-v3');
module.exports=implementation;
if(require.main===module){const port=Number(process.env.PORT||8787);implementation.server.listen(port,()=>console.log(`[BOOT] Smart Wardrobe http://localhost:${port}`));}
