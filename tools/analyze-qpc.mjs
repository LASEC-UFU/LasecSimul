import fs from 'node:fs';
const [coreFile,qemuFile]=process.argv.slice(2); const a=[];
const b=fs.readFileSync(coreFile),s=b.readUInt32LE(12),n=Number(b.readBigUInt64LE(40)),f=b.readBigUInt64LE(24);
for(let i=0,o=64;i<n;i++,o+=s)a.push({tx:b.readBigUInt64LE(o+32).toString(),e:b.readUInt16LE(o+80),q:b.readBigUInt64LE(o+64)*1000000000n/f});
const ql=fs.readFileSync(qemuFile,'utf8').trim().split(/\r?\n/), qf=BigInt(ql[0].split(',')[5]);
for(const l of ql.slice(1)){const p=l.split(',');if(p.length!==9)continue;const x=p.slice(1).map(BigInt);a.push({tx:x[3].toString(),e:Number(x[4]),q:x[6]*1000000000n/qf});}
const g=new Map();for(const r of a){if(!g.has(r.tx))g.set(r.tx,{});g.get(r.tx)[r.e]=r.q;}
const es=[20,21,1,2,22,23], names=['T0>T1','T1>T2','T2>T3','T3>T4','T4>T5'];const out=Object.fromEntries(names.map(x=>[x,[]]));let max=0n;
for(const v of g.values()){for(const q of Object.values(v))if(q>max)max=q;for(let i=1;i<es.length;i++){const x=v[es[i-1]],y=v[es[i]];if(x!==undefined&&y!==undefined&&y<x)out[names[i-1]].push(x-y);}}
for(const [k,v] of Object.entries(out))console.log(k,'count='+v.length,'minTicks='+(v.length?'-'+v.reduce((a,b)=>a>b?a:b):0n),'medianTicks='+(v.length?v.sort((a,b)=>a<b?-1:1)[Math.floor(v.length/2)]:0n));console.log('maxNormalizedQpcNs='+max);
