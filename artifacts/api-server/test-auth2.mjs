import{createHmac}from"crypto";import{readFileSync}from"fs";
const env={};
for(const l of readFileSync(".env","utf8").split("\n")){const i=l.indexOf("=");if(i<0)continue;env[l.slice(0,i).trim()]=l.slice(i+1).trim();}
const key=env.POLYMARKET_API_KEY??"",secret=env.POLYMARKET_API_SECRET??"",pass=env.POLYMARKET_API_PASSPHRASE??"";
console.log("key:",key);console.log("secret raw:",secret);

const strategies=[
  ["url-safe-normalized", Buffer.from(secret.replace(/-/g,"+").replace(/_/g,"/"),"base64")],
  ["base64url",           Buffer.from(secret,"base64url")],
  ["raw-no-decode",       Buffer.from(secret)],
  ["drop-invalid",        Buffer.from(secret.replace(/[^A-Za-z0-9+/=]/g,""),"base64")],
];

for(const[name,buf]of strategies){
  const ts=Math.floor(Date.now()/1000);
  const path="/balance-allowance?asset_type=USDC&signature_type=0";
  const sig=createHmac("sha256",buf).update(`${ts}GET${path}`).digest("base64");
  const r=await fetch("https://clob.polymarket.com"+path,{
    headers:{"POLY-API-KEY":key,"POLY-PASSPHRASE":pass,"POLY-TIMESTAMP":String(ts),"POLY-SIGNATURE":sig},
    signal:AbortSignal.timeout(8000),
  });
  const body=await r.text();
  console.log(`[${name}] status=${r.status} body=${body}`);
  if(r.ok){console.log(`\n*** SUCCESS with strategy: ${name} ***\n`);}
}
