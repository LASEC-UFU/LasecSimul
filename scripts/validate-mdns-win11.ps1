<#
.SYNOPSIS
  Valida, no Windows 11 do usuário, se o responder mDNS host-side do LasecSimul
  (modo de rede "isolated") consegue fazer o resolvedor do Windows resolver
  `<host>.local` -> 127.0.0.1 na MESMA máquina.

.DESCRIPTION
  Este é o ÚNICO passo do recurso de mDNS transparente que não pôde ser validado
  na máquina de build (Windows Server 2025 não faz resolução mDNS). Todo o resto
  já foi validado ponta a ponta:
    - o QEMU aprende `<host>.local` do firmware e alimenta a extensão (OK);
    - a extensão responde a consultas mDNS com A -> 127.0.0.1 (OK, unicast+multicast).
  Falta só confirmar que o Cliente DNS do Windows 11 ACEITA essas respostas.

  O script sobe o MESMO responder que a extensão usa (embutido aqui como Node.js),
  registra um nome de teste, e então pede ao Windows para resolvê-lo via
  Resolve-DnsName e ping. Não instala nada e não exige o QEMU nem a extensão.

.NOTES
  Requisito: Node.js disponível (o script tenta `node` no PATH e, se não achar,
  o node que vem com o VS Code). Rode numa janela normal (não precisa admin).
  A resolução de `.local` pelo Windows usa o serviço "Cliente DNS" (Dnscache),
  que já vem ligado por padrão no Windows 10/11.
#>
[CmdletBinding()]
param(
  [string]$HostName = "lasecsimul-esp32.local",
  [int]$FeedPort = 42353,
  [int]$TimeoutSeconds = 15
)

$ErrorActionPreference = "Stop"

function Find-Node {
  $c = Get-Command node -ErrorAction SilentlyContinue
  if ($c) { return $c.Source }
  foreach ($p in @(
      "$env:LOCALAPPDATA\Programs\Microsoft VS Code\resources\app\node_modules.asar.unpacked",
      "$env:ProgramFiles\Microsoft VS Code")) {
    $found = Get-ChildItem -Path $p -Filter node.exe -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($found) { return $found.FullName }
  }
  return $null
}

$node = Find-Node
if (-not $node) {
  Write-Host "ERRO: Node.js nao encontrado. Instale o Node ou rode a partir de um terminal com 'node' no PATH." -ForegroundColor Red
  exit 2
}
Write-Host "Node: $node"

# Responder mDNS embutido -- igual a extension/src/network/mdnsResponder.ts.
$responderJs = @'
"use strict";
const dgram = require("dgram");
const GROUP = "224.0.0.251", PORT = 5353;
const FEED_PORT = Number(process.argv[2] || 42353);
const known = new Set();
function buildResponse(name){
  const nameBuf = Buffer.concat(name.split(".").map(p=>Buffer.concat([Buffer.from([p.length]),Buffer.from(p,"latin1")])).concat([Buffer.from([0])]));
  const header = Buffer.from([0,0,0x84,0x00,0,0,0,1,0,0,0,0]);
  const rr = Buffer.concat([nameBuf,Buffer.from([0,1]),Buffer.from([0x80,1]),Buffer.from([0,0,0,120]),Buffer.from([0,4]),Buffer.from([127,0,0,1])]);
  return Buffer.concat([header,rr]);
}
function readName(buf,off){
  const labels=[]; let o=off,jumped=false,after=-1,guard=0;
  while(o>=0&&o<buf.length){const len=buf[o];
    if((len&0xc0)===0xc0){if(!jumped)after=o+2;o=((len&0x3f)<<8)|buf[o+1];jumped=true;if(++guard>128)return null;continue;}
    if(len===0){if(!jumped)after=o+1;break;} o++; labels.push(buf.slice(o,o+len).toString("latin1")); o+=len; if(++guard>128)return null;}
  return {name:labels.join(".").toLowerCase(),after};
}
const responder=dgram.createSocket({type:"udp4",reuseAddr:true});
const feed=dgram.createSocket({type:"udp4",reuseAddr:true});
responder.on("error",e=>console.error("responder",e.message));
feed.on("error",e=>console.error("feed",e.message));
responder.on("message",(msg,rinfo)=>{
  if(msg.length<12||(msg[2]&0x80))return;
  const qd=(msg[4]<<8)|msg[5]; let off=12;
  for(let i=0;i<qd;i++){const r=readName(msg,off);if(!r)return;
    const qt=(msg[r.after]<<8)|msg[r.after+1]; off=r.after+4;
    if((qt===1||qt===255)&&known.has(r.name)){const resp=buildResponse(r.name);
      try{responder.send(resp,PORT,GROUP);}catch{} try{responder.send(resp,rinfo.port,rinfo.address);}catch{}
      console.error("answered "+r.name+" -> 127.0.0.1 (from "+rinfo.address+":"+rinfo.port+")");}}
});
feed.on("message",m=>{const n=m.toString("utf8").trim().toLowerCase();
  if(!n.endsWith(".local"))return; if(!known.has(n)){known.add(n);console.error("learned "+n);}
  try{responder.send(buildResponse(n),PORT,GROUP);}catch{}});
responder.bind(PORT,()=>{try{responder.addMembership(GROUP);}catch{} try{responder.setMulticastLoopback(true);}catch{}
  console.error("responder up on "+GROUP+":"+PORT); console.log("READY");});
feed.bind(FEED_PORT,"127.0.0.1",()=>console.error("feed on 127.0.0.1:"+FEED_PORT));
setInterval(()=>{for(const n of known)try{responder.send(buildResponse(n),PORT,GROUP);}catch{}},2000);
'@

$tmpJs = Join-Path $env:TEMP "lasecsimul-mdns-validate.js"
Set-Content -Path $tmpJs -Value $responderJs -Encoding utf8

Write-Host "Iniciando responder para '$HostName'..." -ForegroundColor Cyan
$out = Join-Path $env:TEMP "lasecsimul-mdns-validate.out"
$err = Join-Path $env:TEMP "lasecsimul-mdns-validate.err"
Remove-Item $out,$err -ErrorAction SilentlyContinue
$proc = Start-Process -FilePath $node -ArgumentList "`"$tmpJs`"", "$FeedPort" -PassThru -NoNewWindow -RedirectStandardOutput $out -RedirectStandardError $err

try {
  # Espera o responder subir (imprime READY em stdout).
  $deadline = (Get-Date).AddSeconds(5)
  while ((Get-Date) -lt $deadline -and -not (Select-String -Path $out -Pattern "READY" -Quiet -ErrorAction SilentlyContinue)) {
    Start-Sleep -Milliseconds 200
  }

  # Alimenta o hostname (simula o que o QEMU faz em modo isolado).
  $udp = New-Object System.Net.Sockets.UdpClient
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($HostName)
  [void]$udp.Send($bytes, $bytes.Length, "127.0.0.1", $FeedPort)
  $udp.Close()
  Write-Host "Hostname '$HostName' registrado no responder." -ForegroundColor Cyan
  Start-Sleep -Milliseconds 500

  $pass = $false

  Write-Host "`n--- Resolve-DnsName $HostName -Type A (LlmnrNetbiosOnly) ---" -ForegroundColor Yellow
  try {
    $r = Resolve-DnsName -Name $HostName -Type A -LlmnrNetbiosOnly -ErrorAction Stop
    $r | Format-Table Name, Type, IPAddress -AutoSize | Out-String | Write-Host
    if ($r.IPAddress -contains "127.0.0.1") { $pass = $true }
  } catch {
    Write-Host "Resolve-DnsName (LlmnrNetbiosOnly) falhou: $($_.Exception.Message)"
  }

  if (-not $pass) {
    Write-Host "`n--- Resolve-DnsName $HostName -Type A (padrao) ---" -ForegroundColor Yellow
    try {
      $r2 = Resolve-DnsName -Name $HostName -Type A -ErrorAction Stop
      $r2 | Format-Table Name, Type, IPAddress -AutoSize | Out-String | Write-Host
      if ($r2.IPAddress -contains "127.0.0.1") { $pass = $true }
    } catch {
      Write-Host "Resolve-DnsName (padrao) falhou: $($_.Exception.Message)"
    }
  }

  Write-Host "`n--- ping -n 1 $HostName ---" -ForegroundColor Yellow
  $ping = ping -n 1 $HostName 2>&1 | Out-String
  Write-Host $ping
  if ($ping -match "127\.0\.0\.1") { $pass = $true }

  Write-Host "`n--- log do responder ---" -ForegroundColor DarkGray
  if (Test-Path $err) { Get-Content $err | ForEach-Object { Write-Host "  $_" -ForegroundColor DarkGray } }

  Write-Host ""
  if ($pass) {
    Write-Host "RESULTADO: PASS -- o Windows resolveu $HostName para 127.0.0.1." -ForegroundColor Green
    Write-Host "O mDNS transparente vai funcionar no modo isolado. Pode gerar a v0.0.45." -ForegroundColor Green
    $code = 0
  } else {
    Write-Host "RESULTADO: FAIL -- o Windows NAO resolveu $HostName para 127.0.0.1." -ForegroundColor Red
    Write-Host "Copie a saida acima (incluindo o 'log do responder') e me envie." -ForegroundColor Red
    $code = 1
  }
}
finally {
  if ($proc -and -not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
  Remove-Item $tmpJs, $out, $err -ErrorAction SilentlyContinue
}
exit $code
