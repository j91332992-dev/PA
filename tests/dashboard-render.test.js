'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),path=require('path');
const root=path.resolve(__dirname,'..');
test('production dashboard does not render controls removed with the simulation view',()=>{
  const app=fs.readFileSync(path.join(root,'web/public/app.js'),'utf8');
  const index=fs.readFileSync(path.join(root,'web/public/index.html'),'utf8');
  const render=app.slice(app.indexOf('function render()'),app.indexOf('async function refresh()'));
  assert.doesNotMatch(index,/id="navSim"/);
  assert.doesNotMatch(render,/outfitCards|simCards/);
  assert.match(app,/\$\('#simulation'\)\?\.remove\(\)/);
});
