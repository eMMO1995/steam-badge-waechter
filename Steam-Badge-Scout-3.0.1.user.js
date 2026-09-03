// ==UserScript==
// @name         Steam Badge Scout – Preis, Optik & Themen-Suche
// @namespace    emre-steam-badge-scout
// @version      3.0.1
// @description  Vollständiger, API-schonender Steam Badge Scout: lokaler Vollkatalogscan statt 577er-Auswahl, paginierte Treffer, globaler Billigmarkt-Snapshot, gezielte Exaktprüfungen, adaptive 429-Sperre, Sammlungsradar/Fresh Hunt, Effizienzsortierung und manuelle Low-Bid-Deepchecks. Keine Käufe oder Gebote.
// @match        https://steamcommunity.com/id/*/badges*
// @match        https://steamcommunity.com/profiles/*/badges*
// @match        https://steamcommunity.com/id/*/gamecards/*
// @match        https://steamcommunity.com/profiles/*/gamecards/*
// @grant        GM_xmlhttpRequest
// @connect      www.steamcardexchange.net
// @connect      steamcardexchange.net
// @connect      store.steampowered.com
// @connect      gist.githubusercontent.com
// @run-at       document-idle
// ==/UserScript==
(() => {'use strict';

const CFG={
marketAppId:753,
language:'english',
currency:3,

marketPageSize:100,

// 3.0.1: Steam wird gebündelt und defensiv angesprochen. Ein HTTP 429 öffnet
// sofort einen zeitlich begrenzten Circuit-Breaker, statt jeden Kandidaten
// erneut 15/30/45 Sekunden warten zu lassen.
marketSearchGapMs:1400,
steamGapMs:450,

maxMarketPagesPerGame:3,
maxAttempts:2,
cooldown429Ms:120000,
maxCooldown429Ms:15*60*1000,

// ECHTER Nonstop-Scan: kein 100er-Stopp, kein Scrollzwang.
continuousScan:true,

// Marktampel für unsere geizige Langzeitstrategie.
marketSuperMaxCostCents:60,
marketSuperMinSellListings:100,
marketSuperAvgSellListings:150,
marketGoodMaxCostCents:80,
marketGoodMinSellListings:40,
marketGoodAvgSellListings:75,
marketOkayMinSellListings:20,
marketOkayAvgSellListings:40,
marketThinMinSellListings:5,
marketThinAvgSellListings:15,

// Zweistufige Billigsuche: wenige globale Marktseiten liefern viele Karten
// auf einmal. Der gesamte SCE-Badge-Katalog wird danach lokal ausgewertet;
// nur die besten noch unvollständigen Sets werden einzeln exakt validiert.
// So bleibt der Vollscan unter Steam-Limits nutzbar.
globalCheapMarketPages:24,
globalMarketSnapshotFreshMs:20*60*1000,
globalMarketSnapshotFallbackMs:24*60*60*1000,
globalMarketSnapshotKey:'steamBadgeScout:globalNormalMarket:v1',
autoExactValidationGames:16,
manualExactValidationGames:20,
efficiencyCardPenaltyCents:2,

// Alle Ergebnisse bleiben im Speicher und werden filter-/sortierbar gehalten.
// In den DOM kommt immer nur eine Seite, damit auch 13.000+ Treffer weder
// Violentmonkey noch den Steam-Tab durch zehntausende Kartenkacheln blockieren.
resultPageSize:100,
fastScanYieldEvery:100,
fastScanInitialUiEvery:20,

// Buy/Sell-Konkurrenz wird nur auf ausdrücklichen Wunsch und nur für bereits
// marktgeprüfte Topsets vertieft. Zwei repräsentative Karten reichen als
// Konkurrenzindikator; es bleibt ausdrücklich keine Fill-Garantie.
deepCheckEnabled:true,
deepCheckMaxGames:15,
deepCheckCardsPerGame:2,
deepCheckManualBatchSize:5,
deepCheckDuringScanEvery:0,
deepCheckDuringScanMax:0,
deepCheckMaxExactCostCents:60,
lowBidTopMaxBuySellRatio:0.50,
lowBidGoodMaxBuySellRatio:1.00,

// Foil-OPTIK im Normal-Scout wird lazy für tatsächlich angesehene Treffer geladen.
// Foil-MARKTPREISE bleiben Sache der separaten Glanz-Suche.
foilVisualLazy:true,
foilVisualRootMarginPx:1200,
foilVisualGapMs:250,

// Normal-/Themen-Suche lädt Foil-Marktpreise bewusst nicht pro Treffer.
// Für vollständige Foilpreise die separate Glanz-Suche verwenden.
loadFoilMarketInNormalMode:false,

// Popularitäts-API blockiert den schnellen Hauptscan nicht.
loadPopularityInFastScan:false,

themeMarketTerms:3,

normalModesHideMaxed:true,
foilModeKeepMaxedNormal:true,
hideCompletedFoil:true,

sharedIntelKey:'emreSteamBadgeIntel:v1',

sharedIntelMaxAgeMs:
6*60*60*1000,

// Fresh Hunt: aktive Steam-Kaufaufträge werden pro Hauptsuche frisch geladen.
// Der Filterzustand bleibt zwischen Seitenaufrufen erhalten, bis er bewusst
// ausgeschaltet oder über "Filter zurücksetzen" gelöscht wird.
activeBuyOrdersFreshMs:
5*60*1000,

activeBuyOrdersFallbackMs:
24*60*60*1000,

activeBuyOrdersCacheKey:
'steamBadgeScout:activeBuyOrders:v1',

badgeCollectionFreshMs:
15*60*1000,

badgeCollectionFallbackMs:
24*60*60*1000,

badgeCollectionMaxPages:20,

badgeCollectionCacheKey:
'steamBadgeScout:badgeCollection:v1',

freshHuntFilterKey:
'steamBadgeScout:freshHuntFilter:v1',

startedSetsFilterKey:
'steamBadgeScout:startedSetsFilter:v1',

fewSellListingsPerCard:20,
veryFewSellListingsPerCard:5,

favoriteKey:
'steamBadgeScout:favorites:v2',

sceCatalogCacheKey:
'steamBadgeScout:sceCatalog:v2',

sceCatalogCacheMs:
6*60*60*1000,

sceBadgePricesUrl:
'https://www.steamcardexchange.net/api/request.php?GetBadgePrices_Guest',

sceInventoryUrl:
'https://www.steamcardexchange.net/api/request.php?GetInventory',

sceGameBase:
'https://www.steamcardexchange.net/index.php?gamepage-appid-',

badgeNameDbUrl:
'https://gist.githubusercontent.com/abdonkov/b0c97a1e8b75997e0976c0c7c9610895/raw/SteamGameBadges.html',

badgeNameDbTimeoutMs:
60000
};

const THEMES=[
{
aliases:[
'shenlong',
'shenron',
'shenloing',
'shen loong',
'eternal dragon',
'dragonball',
'dragon ball'
],
terms:[
'dragon ball',
'shenron',
'dragon',
'eternal dragon',
'saiyan',
'goku',
'vegeta',
'wyvern',
'wyrm',
'serpent'
]
},
{
aliases:[
'dragon',
'drache',
'drachen',
'wyrm',
'wyvern'
],
terms:[
'dragon',
'wyvern',
'wyrm',
'serpent',
'drake',
'dragon king',
'dragon lord'
]
},
{
aliases:[
'anime',
'manga',
'japan',
'japanese'
],
terms:[
'anime',
'manga',
'sakura',
'samurai',
'ninja',
'kawaii',
'otaku'
]
},
{
aliases:[
'cyberpunk',
'neon',
'synthwave',
'retrowave'
],
terms:[
'cyberpunk',
'neon',
'synthwave',
'retrowave',
'android',
'hacker',
'future'
]
},
{
aliases:[
'demon',
'dämon',
'devil',
'hell',
'hölle'
],
terms:[
'demon',
'devil',
'hell',
'inferno',
'satan',
'demonic',
'underworld'
]
},
{
aliases:[
'skull',
'totenkopf',
'skeleton',
'death'
],
terms:[
'skull',
'skeleton',
'death',
'reaper',
'bones',
'undead'
]
},
{
aliases:[
'cat',
'katze',
'kawaii',
'cute',
'süß'
],
terms:[
'cat',
'kitten',
'kawaii',
'cute',
'neko',
'kitty'
]
},
{
aliases:[
'space',
'weltraum',
'galaxy',
'galaxie',
'cosmic'
],
terms:[
'space',
'galaxy',
'cosmic',
'star',
'nebula',
'planet'
]
}
];

const S={
running:false,
stop:false,
pauseRequested:false,

modal:null,
profile:null,

results:[],
candidates:[],
nextCandidateIndex:0,

mode:'cheap',
terms:[],
query:'',

scanBusy:false,
paused:false,
scanStartedAt:null,
scanStartIndex:0,
cardNodes:new Map(),
uiSyncTimer:null,
resultPage:0,
resultPageSize:CFG.resultPageSize,

marketRowsCache:new Map(),
globalMarketRowsByApp:new Map(),
globalMarketSnapshot:null,
fastDiscoveryMode:false,
badgeCache:new Map(),
foilBadgeCache:new Map(),

badgeCollectionByApp:new Map(),
badgeCollectionLoadedAt:0,
badgeCollectionStatus:'idle',
badgeCollectionError:null,
badgeCollectionPromise:null,
badgeCollectionComplete:false,

deepCheckQueue:[],
deepCheckQueued:new Set(),
deepChecked:new Set(),
deepCheckBusy:false,
deepCheckCompleted:0,
deepCheckCache:new Map(),
deepResultsByApp:new Map(),

marketValidationBusy:false,
marketValidatedApps:new Set(),

foilVisualQueue:[],
foilVisualQueued:new Set(),
foilVisualBusy:false,
foilObserver:null,

badgeNameDb:null,
badgeNameDbPromise:null,
badgeNameMap:new Map(),

lastSteamAt:0,
lastMarketAt:0,
steamQueue:Promise.resolve(),
rateLimitUntil:{market:0,profile:0},
lastRateLimit:null,

scxCache:new Map(),
popularityCache:new Map(),

activeBuyOrders:[],
activeBuyOrdersByApp:new Map(),
activeBuyOrdersLoadedAt:0,
activeBuyOrdersStatus:'idle',
activeBuyOrdersError:null,
activeBuyOrdersPromise:null,

stats:{
steam:0,
market:0,
external:0,
retries:0,
rateLimits:0,
deepChecks:0,
foilVisuals:0,
buyOrderLoads:0
,
globalMarketPages:0,
marketValidations:0,
badgeCollectionPages:0
}
};

const sleep=
ms=>
new Promise(
resolve=>
setTimeout(
resolve,
ms
)
);

const clean=
value=>
String(
value??
''
)
.replace(
/\s+/g,
' '
)
.trim();

const norm=
value=>
String(
value??
''
)
.normalize(
'NFKD'
)
.toLowerCase()
.replace(
/[^a-z0-9]+/g,
''
);

const round2=
value=>
Number.isFinite(
Number(
value
)
)
?Math.round(
Number(
value
)*
100
)/
100
:null;

function parseCountDigits(value){
const digits=String(value??'').replace(/[^0-9]/g,'');
return digits?Number(digits):0;
}

function getCookie(name){
const prefix=encodeURIComponent(name)+'=';
const found=document.cookie.split('; ').find(value=>value.startsWith(prefix));
return found?decodeURIComponent(found.slice(prefix.length)):null;
}

function setCookie(name,value,domain=null){
document.cookie=`${encodeURIComponent(name)}=${encodeURIComponent(value)}; path=/; max-age=31536000; ${domain?`domain=${domain}; `:''}SameSite=Lax; Secure`;
}

function deleteCookie(name,domain=null){
document.cookie=`${encodeURIComponent(name)}=; path=/; max-age=0; ${domain?`domain=${domain}; `:''}SameSite=Lax; Secure`;
}

function restoreCookie(name,previous){
if(previous===null||previous===undefined){
deleteCookie(name);
deleteCookie(name,'steamcommunity.com');
}else{
setCookie(name,previous);
setCookie(name,previous,'steamcommunity.com');
}
}

function formatDuration(minutes){
if(!Number.isFinite(minutes)||minutes<0)return'—';
if(minutes<1)return'<1 Min';
if(minutes<60)return`${Math.ceil(minutes)} Min`;
const hours=Math.floor(minutes/60);
const mins=Math.ceil(minutes-hours*60);
return`${hours} h${mins?` ${mins} Min`:''}`;
}

function loadSharedIntel(){
try{
const raw=
JSON.parse(
localStorage.getItem(
CFG.sharedIntelKey
)||
'{}'
);

return raw&&
typeof raw===
'object'
?raw
:{};

}catch{
return{};
}
}

function saveSharedIntel(
data
){
try{
localStorage.setItem(
CFG.sharedIntelKey,
JSON.stringify(
data
)
);
}catch{}
}

function rememberBadgeState(
appid,
kind,
state
){
if(
!appid||
!state||
state.accessible!==
true
){
return;
}

const all=
loadSharedIntel();

const key=
String(
appid
);

const old=
all[key]&&
typeof all[key]===
'object'
?all[key]
:{};

all[key]={
...old,

appid:
key,

updatedAt:
Date.now(),

lastSource:
'badge-scout',

[kind]:{
...(old[kind]||{}),

level:
Number(
state.badgeLevel||
0
),

maxLevel:
Number(
state.maxLevel||
(
kind===
'foilBadge'
?1
:5
)
),

maxed:
Boolean(
state.badgeMaxed
),

checkedAt:
Date.now(),

checkedBy:
'badge-scout'
}
};

saveSharedIntel(
all
);
}

function sharedEntry(
appid
){
return(
loadSharedIntel()[
String(
appid
)
]||
null
);
}

function isFreshTimestamp(
value
){
const ts=
Number(
value||
0
);

return(
ts>0&&
Date.now()-
ts<=
CFG.sharedIntelMaxAgeMs
);
}

function sharedNormalMaxed(
appid
){
const entry=
sharedEntry(
appid
);

const badge=
entry
?.normalBadge;

return Boolean(
badge?.maxed===
true&&
isFreshTimestamp(
badge.checkedAt
)
);
}

function sharedFoilMaxed(
appid
){
const entry=
sharedEntry(
appid
);

const badge=
entry
?.foilBadge;

return Boolean(
badge?.maxed===
true&&
isFreshTimestamp(
badge.checkedAt
)
);
}

function sharedIntelContext(
appid
){
const entry=
sharedEntry(
appid
);

if(
!entry
){
return null;
}

const decision=
entry
.lastSetDecision||
null;

const watcher=
entry
.lastWatcher||
null;

const analyzer=
entry
.lastAnalyzer||
null;

return{
decision:
decision&&
isFreshTimestamp(
decision.at
)
?decision
:null,

watcher:
watcher&&
isFreshTimestamp(
Date.parse(
watcher.generated||
''
)
)
?watcher
:null,

analyzer:
analyzer&&
isFreshTimestamp(
Date.parse(
analyzer.generated||
''
)
)
?analyzer
:null
};
}

function loadFreshHuntPreference(){
try{
return localStorage.getItem(CFG.freshHuntFilterKey)==='1';
}catch{
return false;
}
}

function saveFreshHuntPreference(enabled){
try{
localStorage.setItem(
CFG.freshHuntFilterKey,
enabled?'1':'0'
);
}catch{}
}

function loadStartedSetsPreference(){
try{
return localStorage.getItem(CFG.startedSetsFilterKey)==='1';
}catch{
return false;
}
}

function saveStartedSetsPreference(enabled){
try{
localStorage.setItem(
CFG.startedSetsFilterKey,
enabled?'1':'0'
);
}catch{}
}

function readTimedCache(key,maxAgeMs){
try{
const value=JSON.parse(localStorage.getItem(key)||'null');
const age=Date.now()-Number(value?.ts||0);
if(!value||!Number.isFinite(age)||age<0||age>maxAgeMs)return null;
return value;
}catch{
return null;
}
}

function writeTimedCache(key,value){
try{
localStorage.setItem(
key,
JSON.stringify({ts:Date.now(),...value})
);
}catch{}
}

function marketHashFromListingUrl(value){
const match=String(value||'').match(
/\/market\/listings\/753\/([^?#]+)/i
);

if(!match?.[1])return null;

try{
return decodeURIComponent(match[1]);
}catch{
return match[1];
}
}

function marketHashKey(value){
return clean(value).toLocaleLowerCase('en-US');
}

function tradingCardKind(hash){
const value=clean(hash);
if(/\(Foil Trading Card\)$/i.test(value))return'foil';
if(/\(Trading Card\)$/i.test(value))return'normal';
return null;
}

function indexActiveBuyOrders(orders){
const byApp=new Map();

for(const order of orders||[]){
const appid=String(order?.gameAppId||'');
const kind=order?.kind;
if(!appid||!['normal','foil'].includes(kind))continue;

if(!byApp.has(appid)){
byApp.set(appid,{
all:[],
normal:[],
foil:[],
normalHashes:new Set(),
foilHashes:new Set()
});
}

const entry=byApp.get(appid);
entry.all.push(order);
entry[kind].push(order);
entry[`${kind}Hashes`].add(
marketHashKey(order.marketHashName)
);
}

return byApp;
}

async function fetchActiveBuyOrdersFresh(){
const previous=getCookie('bMarketOptOut');
setCookie('bMarketOptOut','1');
await sleep(120);

try{
const response=await steamFetch(
`https://steamcommunity.com/market/?l=english&_scout_orders=${Date.now()}`,
{headers:{Accept:'text/html,application/xhtml+xml'}},
'Aktive Kaufaufträge'
);

const html=await response.text();
const doc=new DOMParser().parseFromString(html,'text/html');
const rows=[...doc.querySelectorAll('div[id^="mybuyorder_"]')];
const orders=[];

for(const row of rows){
const link=row.querySelector('a[href*="/market/listings/753/"]');
if(!link)continue;

const hash=marketHashFromListingUrl(
link.getAttribute('href')||link.href
);
const gameAppId=appidFromHash(hash);
const kind=tradingCardKind(hash);
if(!hash||!gameAppId||!kind)continue;

const priceText=clean(
row.querySelector('.market_listing_price')?.textContent||''
);
const quantityMatch=priceText.match(/^\s*(\d+)\s*@/);

orders.push({
orderId:clean(row.id).replace('mybuyorder_',''),
gameAppId:String(gameAppId),
marketHashName:hash,
kind,
quantity:quantityMatch?Number(quantityMatch[1]):1,
itemName:clean(
row.querySelector('.market_listing_item_name_link')?.textContent||
row.querySelector('.market_listing_item_name')?.textContent||
nameFromHash(hash,gameAppId)
)
});
}

return orders;
}finally{
restoreCookie('bMarketOptOut',previous);
await sleep(120);
}
}

async function ensureActiveBuyOrders(force=false){
if(S.activeBuyOrdersPromise)return S.activeBuyOrdersPromise;

const stillFresh=
S.activeBuyOrdersStatus==='ready'&&
Date.now()-S.activeBuyOrdersLoadedAt<=CFG.activeBuyOrdersFreshMs;

if(!force&&stillFresh)return S.activeBuyOrders;

if(!force&&S.activeBuyOrdersStatus==='idle'){
const cached=readTimedCache(
CFG.activeBuyOrdersCacheKey,
CFG.activeBuyOrdersFreshMs
);

if(Array.isArray(cached?.orders)){
S.activeBuyOrders=cached.orders;
S.activeBuyOrdersByApp=indexActiveBuyOrders(cached.orders);
S.activeBuyOrdersLoadedAt=Number(cached.ts||Date.now());
S.activeBuyOrdersStatus='ready';
return S.activeBuyOrders;
}
}

S.activeBuyOrdersStatus='loading';
S.activeBuyOrdersError=null;
updateMoreUi();

S.activeBuyOrdersPromise=(async()=>{
try{
const orders=await fetchActiveBuyOrdersFresh();
S.activeBuyOrders=orders;
S.activeBuyOrdersByApp=indexActiveBuyOrders(orders);
S.activeBuyOrdersLoadedAt=Date.now();
S.activeBuyOrdersStatus='ready';
S.stats.buyOrderLoads++;
writeTimedCache(
CFG.activeBuyOrdersCacheKey,
{orders}
);
return orders;
}catch(error){
const cached=readTimedCache(
CFG.activeBuyOrdersCacheKey,
CFG.activeBuyOrdersFallbackMs
);

if(Array.isArray(cached?.orders)){
S.activeBuyOrders=cached.orders;
S.activeBuyOrdersByApp=indexActiveBuyOrders(cached.orders);
S.activeBuyOrdersLoadedAt=Number(cached.ts||0);
S.activeBuyOrdersStatus='stale';
}else{
S.activeBuyOrders=[];
S.activeBuyOrdersByApp=new Map();
S.activeBuyOrdersLoadedAt=0;
S.activeBuyOrdersStatus='error';
}
S.activeBuyOrdersError=String(error?.message||error);
console.warn('[Badge Scout] Aktive Kaufaufträge konnten nicht geladen werden',error);
return S.activeBuyOrders;
}finally{
S.activeBuyOrdersPromise=null;
if(S.modal){
clearRenderedResultCards();
syncVisibleResults(true);
}
}
})();

return S.activeBuyOrdersPromise;
}

function targetCardsForOrderCoverage(result){
if(S.mode!=='foil'){
return(result?.cost?.cards||[]).filter(card=>card?.missing===true);
}

const ownedByName=new Map(
(result?.foilBadgeState?.cards||[]).map(card=>[
norm(card?.name||''),
Number(card?.owned||0)
])
);

return(result?.foilCost?.cards||[]).filter(card=>
Number(ownedByName.get(norm(card?.name||''))||0)<1
);
}

function activeOrderCoverage(result){
const appOrders=S.activeBuyOrdersByApp.get(String(result?.appid||''));
const kind=S.mode==='foil'?'foil':'normal';
const orders=appOrders?.[kind]||[];
const hashes=appOrders?.[`${kind}Hashes`]||new Set();
const targets=targetCardsForOrderCoverage(result);
const resolvable=targets.filter(card=>clean(card?.marketHashName));
const covered=resolvable.filter(card=>
hashes.has(marketHashKey(card.marketHashName))
);
const unresolvedCount=Math.max(0,targets.length-resolvable.length);
const fullyCovered=
targets.length>0&&
unresolvedCount===0&&
covered.length===targets.length;

const orderSnapshotUsable=
S.activeBuyOrdersLoadedAt>0&&
S.activeBuyOrdersStatus==='ready'&&
Date.now()-S.activeBuyOrdersLoadedAt<=CFG.activeBuyOrdersFreshMs;
const hasActiveOrders=orderSnapshotUsable&&orders.length>0;

const ownedCards=S.mode==='foil'
?(result?.foilBadgeState?.cards||[])
:(result?.cost?.cards||[]);
const collection=
S.badgeCollectionByApp.get(String(result?.appid||''))||null;

const collectionSnapshotUsable=
S.badgeCollectionLoadedAt>0&&
['ready','cached','partial'].includes(S.badgeCollectionStatus)&&
Date.now()-S.badgeCollectionLoadedAt<=CFG.badgeCollectionFreshMs;

const ownedCardKinds=Math.max(
ownedCards.filter(card=>Number(card?.owned||0)>0).length,
collectionSnapshotUsable?Number(collection?.ownedUnique||0):0
);
const ownedCopies=Math.max(
ownedCards.reduce(
(sum,card)=>sum+Math.max(0,Number(card?.owned||0)),
0
),
collectionSnapshotUsable?Number(collection?.ownedUnique||0):0
);
const badgeLevel=S.mode==='foil'
?Number(result?.foilBadgeState?.badgeLevel||0)
:Math.max(
Number(result?.badge?.badgeLevel||0),
Number(collection?.badgeLevel||0)
);
const hasBadgeProgress=badgeLevel>0;
const hasCollectionProgress=Boolean(collectionSnapshotUsable&&collection?.started);

// Fresh Hunt bedeutet: nur wirklich neue, noch nicht begonnene Sets.
// Schon EIN laufender Auftrag, EINE vorhandene Karte oder Badge-Fortschritt
// reicht aus. Abdeckung und Wächter-Urteil bleiben reine Zusatzinformation
// und blockieren den Filter nicht mehr.
const freshHuntMatch=
hasActiveOrders||
ownedCardKinds>0||
hasBadgeProgress||
hasCollectionProgress;

const decisionAction=String(
result?.sharedIntel?.decision?.action||''
).toUpperCase();
const watcherStatus=String(
result?.sharedIntel?.watcher?.technicalSetStatus||''
).toLowerCase();
const watcherAttention=
['SETSTOP','SETWAIT'].includes(decisionAction)||
watcherStatus==='red';

const reasons=[];
if(hasActiveOrders){
reasons.push(`${orders.length} laufende${kind==='foil'?' Glanz-':''} Kaufaufträge`);
}
if(ownedCardKinds>0){
reasons.push(`${ownedCardKinds} Kartensorte(n) mit ${ownedCopies} Kopie(n) vorhanden`);
}
if(hasBadgeProgress){
reasons.push(`${kind==='foil'?'Glanz-':''}Badge-Level ${badgeLevel}`);
}

let reason=freshHuntMatch
?`Bereits begonnene Sammlung: ${reasons.join(' · ')}.`
:'Noch keine laufende Sammlung für dieses Set erkannt.';

if(hasActiveOrders&&targets.length){
reason+=` Auftragsabdeckung aktuell ${covered.length}/${targets.length} fehlende Karten.`;
}

if(watcherAttention){
reason+=' Der Wächter meldet zusätzlichen Prüfbedarf; Fresh Hunt behandelt das Set trotzdem als bereits begonnen.';
}

return{
kind,
activeOrderCount:orders.length,
activeQuantity:orders.reduce((sum,order)=>sum+Math.max(1,Number(order.quantity||1)),0),
targetCount:targets.length,
resolvableCount:resolvable.length,
coveredCount:covered.length,
unresolvedCount,
fullyCovered,
ownedCardKinds,
ownedCopies,
badgeLevel,
hasActiveOrders,
hasBadgeProgress,
hasCollectionProgress,
orderSnapshotUsable,
collectionSnapshotUsable,
freshHuntMatch,
watcherAttention,
reason
};
}

function resultHiddenByFreshHunt(result){
return activeOrderCoverage(result).freshHuntMatch;
}

function announceFreshHuntState(enabled){
if(!S.modal)return;
const filters=filterState();
const withoutFresh={...filters,hideActiveOrderSets:false};
const hidden=S.results.reduce((count,result)=>count+(
resultPassesFilters(result,withoutFresh)&&resultHiddenByFreshHunt(result)?1:0
),0);
const shown=S.results.reduce((count,result)=>count+(
resultPassesFilters(result,filters)?1:0
),0);
status(enabled
?`🆕 Fresh Hunt aktiv: ${hidden} bereits begonnene Sammlung(en) werden sofort ausgeblendet · ${shown} Treffer bleiben in der aktuellen Filterkombination sichtbar.`
:`🗂 Fresh Hunt aus: zuvor ausgeblendete Sammlungen sind wieder da · ${shown} Treffer passen zur aktuellen Filterkombination.`
);
}

function activeOrderCoverageText(result){
const coverage=activeOrderCoverage(result);
if(!coverage.freshHuntMatch)return'';

return(
`🧭 Fresh Hunt: bereits begonnen – ${coverage.reason} `+
'Bei aktivem Filter wird dieses Set ausgeblendet.'
);
}

function esc(
value
){
const div=
document.createElement(
'div'
);

div.textContent=
String(
value??
''
);

return div.innerHTML;
}

function moneyNumber(
value
){
const match=
clean(
value
)
.match(
/(\d+(?:[.,]\d{1,2})?)/
);

if(
!match
){
return null;
}

const number=
Number(
match[1]
.replace(
',',
'.'
)
);

return Number.isFinite(
number
)
?number
:null;
}

function moneyCents(
value
){
const number=
moneyNumber(
value
);

return number===
null
?null
:Math.round(
number*
100
);
}

function euro(
cents
){
return Number.isFinite(
Number(
cents
)
)
?`${(Number(cents)/100).toFixed(2).replace('.',',')} €`
:'—';
}

function levenshtein(
a,
b
){
if(
a===
b
){
return 0;
}

if(
!a.length
){
return b.length;
}

if(
!b.length
){
return a.length;
}

const previous=
Array.from(
{
length:
b.length+
1
},
(
_,
i
)=>
i
);

const current=
new Array(
b.length+
1
);

for(
let i=1;
i<=
a.length;
i++
){
current[0]=
i;

for(
let j=1;
j<=
b.length;
j++
){
current[j]=
Math.min(
current[j-1]+
1,

previous[j]+
1,

previous[j-1]+
(
a[i-1]===
b[j-1]
?0
:1
)
);
}

for(
let j=0;
j<=
b.length;
j++
){
previous[j]=
current[j];
}
}

return previous[
b.length
];
}

function sim(
a,
b
){
const x=
norm(
a
);

const y=
norm(
b
);

if(
!x||
!y
){
return 0;
}

if(
x===
y
){
return 1;
}

if(
x.includes(
y
)||
y.includes(
x
)
){
return(
0.82+
0.18*
(
Math.min(
x.length,
y.length
)/
Math.max(
x.length,
y.length
)
)
);
}

return(
1-
levenshtein(
x,
y
)/
Math.max(
x.length,
y.length
)
);
}

function profileBase(){
const fromLocation=
location.href
.match(
/^(https:\/\/steamcommunity\.com\/(?:id\/[^/]+|profiles\/\d+))/i
)
?.[1];

if(
fromLocation
){
return fromLocation;
}

try{
const fromGlobal=
String(
window
.g_rgProfileData
?.url||
''
)
.match(
/^(https:\/\/steamcommunity\.com\/(?:id\/[^/]+|profiles\/\d+))/i
)
?.[1];

if(
fromGlobal
){
return fromGlobal;
}

}catch{}

return null;
}

function loadFavs(){
try{
return new Set(
JSON.parse(
localStorage.getItem(
CFG.favoriteKey
)||
'[]'
)
.map(
String
)
);

}catch{
return new Set();
}
}

function saveFavs(
set
){
try{
localStorage.setItem(
CFG.favoriteKey,

JSON.stringify([
...set
])
);

}catch{}
}

function isFav(
appid
){
return loadFavs()
.has(
String(
appid
)
);
}

function toggleFav(
appid
){
const favorites=
loadFavs();

const key=
String(
appid
);

if(
favorites.has(
key
)
){
favorites.delete(
key
);

}else{
favorites.add(
key
);
}

saveFavs(
favorites
);
}

function gm(
url,
responseType='text',
timeout=25000
){
S.stats.external++;

return new Promise(
(
resolve,
reject
)=>{
GM_xmlhttpRequest({
method:
'GET',

url,

responseType,

timeout,

onload:
response=>{
if(
response.status>=
200&&
response.status<
300
){
resolve(
response
);

}else{
reject(
new Error(
`Extern HTTP ${response.status}`
)
);
}
},

onerror:
()=>
reject(
new Error(
'Externe Anfrage fehlgeschlagen'
)
),

ontimeout:
()=>
reject(
new Error(
'Externe Anfrage Timeout'
)
)
});
}
);
}

function extractAssignedJsonArray(
source,
variableName='games'
){
const text=
String(
source||
''
);

const variableIndex=
text.indexOf(
variableName
);

if(
variableIndex<
0
){
throw new Error(
'Badge-Namen-Katalog: games-Variable nicht gefunden'
);
}

const equalIndex=
text.indexOf(
'=',
variableIndex
);

const arrayStart=
text.indexOf(
'[',
equalIndex
);

if(
equalIndex<
0||
arrayStart<
0
){
throw new Error(
'Badge-Namen-Katalog: JSON-Array nicht gefunden'
);
}

let depth=0;
let inString=false;
let escaped=false;

for(
let index=arrayStart;
index<
text.length;
index++
){
const char=
text[index];

if(
inString
){
if(
escaped
){
escaped=false;

continue;
}

if(
char===
'\\'
){
escaped=true;

continue;
}

if(
char===
'"'
){
inString=false;
}

continue;
}

if(
char===
'"'
){
inString=true;

continue;
}

if(
char===
'['
){
depth++;

continue;
}

if(
char===
']'
){
depth--;

if(
depth===
0
){
return JSON.parse(
text.slice(
arrayStart,
index+
1
)
);
}
}
}

throw new Error(
'Badge-Namen-Katalog: JSON-Array unvollständig'
);
}

function normalizeBadgeNameDb(
rawGames
){
if(
!Array.isArray(
rawGames
)
){
return[];
}

return rawGames
.map(
game=>{
const appid=
String(
game?.AppId||
''
);

const title=
clean(
game?.Name||
''
);

const levels=
(
Array.isArray(
game?.Badges
)
?game.Badges
:[]
)
.map(
(
badge,
index
)=>{
const level=
Number(
clean(
badge?.LevelText||
''
)
.match(
/(?:Level|Stufe)\s*(\d+)/i
)
?.[1]||
index+
1
);

return{
level:
Number.isFinite(
level
)
?level
:index+
1,

name:
clean(
badge?.Name||
''
),

image:
clean(
badge?.ImageUrl||
''
)
};
}
)
.filter(
badge=>
badge.name&&
badge.level>=
1&&
badge.level<=
5
);

if(
!/^\d+$/
.test(
appid
)||
!levels.length
){
return null;
}

return{
appid,
title,
levels
};
}
)
.filter(
Boolean
);
}

async function loadBadgeNameDb(){
if(
Array.isArray(
S.badgeNameDb
)
){
return S.badgeNameDb;
}

if(
S.badgeNameDbPromise
){
return S.badgeNameDbPromise;
}

S.badgeNameDbPromise=
(
async()=>{
status(
'🎖 Lade globalen Badge-Level-Namen-Katalog …'
);

const response=
await gm(
CFG.badgeNameDbUrl,
'text',
CFG.badgeNameDbTimeoutMs
);

const html=
response.responseText||
String(
response.response||
''
);

const games=
extractAssignedJsonArray(
html,
'games'
);

const normalized=
normalizeBadgeNameDb(
games
);

if(
!normalized.length
){
throw new Error(
'Badge-Namen-Katalog enthielt keine verwertbaren Spiele'
);
}

S.badgeNameDb=
normalized;

S.badgeNameMap=
new Map(
normalized.map(
game=>[
String(
game.appid
),
game
]
)
);

return normalized;
}
)();

try{
return await S.badgeNameDbPromise;

}finally{
S.badgeNameDbPromise=
null;
}
}

function badgeLevelMatches(
levels,
terms
){
const needles=
(
terms||
[]
)
.map(
(
term,
index
)=>({
term:
clean(
term
),

needle:
norm(
term
),

primary:
index===
0
})
)
.filter(
item=>
item.needle
);

const matches=[];

for(const badge of
levels||
[]
){
const badgeName=
clean(
badge?.name||
badge?.Name||
''
);

const haystack=
norm(
badgeName
);

if(
!haystack
){
continue;
}

for(const term of needles){
if(
!haystack.includes(
term.needle
)
){
continue;
}

matches.push({
level:
Number(
badge?.level||
clean(
badge?.LevelText||
''
)
.match(
/(?:Level|Stufe)\s*(\d+)/i
)
?.[1]||
0
)||
null,

name:
badgeName,

image:
clean(
badge?.image||
badge?.ImageUrl||
''
),

term:
term.term,

primary:
term.primary,

exact:
haystack===
term.needle
});

break;
}
}

return matches;
}

function badgeMatchScore(
matches
){
return(
matches||
[]
)
.reduce(
(
score,
match
)=>{
if(
match.primary&&
match.exact
){
return score+
70;
}

if(
match.primary
){
return score+
50;
}

if(
match.exact
){
return score+
22;
}

return score+
14;
},
0
);
}

function mergeBadgeMatches(
...groups
){
const output=[];
const seen=
new Set();

for(const match of
groups.flat()
){
if(
!match
){
continue;
}

const key=
`${match.level ?? ''}`+
`||${norm(match.name)}`+
`||${norm(match.term)}`;

if(
seen.has(
key
)
){
continue;
}

seen.add(
key
);

output.push(
match
);
}

return output;
}

async function reserveSteamSlot(
marketSearch=false
){
const slot=
S.steamQueue
.then(
async()=>{
const now=
Date.now();

const baseWait=
Math.max(
0,
CFG.steamGapMs-
(
now-
S.lastSteamAt
)
);

const marketWait=
marketSearch
?Math.max(
0,
CFG.marketSearchGapMs-
(
now-
S.lastMarketAt
)
)
:0;

const wait=
Math.max(
baseWait,
marketWait
);

if(
wait>0
){
await sleep(
wait
);
}

const startedAt=
Date.now();

S.lastSteamAt=
startedAt;

if(
marketSearch
){
S.lastMarketAt=
startedAt;
}
}
);

S.steamQueue=
slot.catch(
()=>{}
);

await slot;
}

function steamRequestChannel(url,marketSearch=false){
if(marketSearch)return'market';
try{
return new URL(url,location.href).pathname.startsWith('/market/')
?'market'
:'profile';
}catch{
return'profile';
}
}

function rateLimitError(label,channel,until){
const seconds=Math.max(1,Math.ceil((until-Date.now())/1000));
const error=new Error(
`${label}: Steam-Limit aktiv (${channel}, noch ca. ${formatDuration(seconds/60)})`
);
error.name='ScoutRateLimitError';
error.channel=channel;
error.until=until;
error.isRateLimit=true;
return error;
}

function isRateLimitError(error){
return Boolean(error?.isRateLimit||error?.name==='ScoutRateLimitError');
}

function retryAfterMilliseconds(response){
const raw=clean(response?.headers?.get?.('retry-after')||'');
if(!raw)return CFG.cooldown429Ms;
const seconds=Number(raw);
if(Number.isFinite(seconds)&&seconds>=0)return seconds*1000;
const absolute=Date.parse(raw);
return Number.isFinite(absolute)
?Math.max(0,absolute-Date.now())
:CFG.cooldown429Ms;
}

function activeRateLimitText(){
const now=Date.now();
const entries=Object.entries(S.rateLimitUntil)
.filter(([,until])=>Number(until)>now)
.map(([channel,until])=>`${channel}: ${formatDuration((until-now)/60000)}`);
return entries.length?`Steam-Pause ${entries.join(' / ')}`:'';
}

async function steamFetch(
url,
options={},
label='Steam',
marketSearch=false
){
let lastError;
const channel=steamRequestChannel(url,marketSearch);

if(Number(S.rateLimitUntil[channel]||0)>Date.now()){
throw rateLimitError(label,channel,S.rateLimitUntil[channel]);
}

for(
let attempt=1;
attempt<=
CFG.maxAttempts;
attempt++
){
if(
S.stop
){
throw new Error(
'Vom Benutzer gestoppt'
);
}

try{
await reserveSteamSlot(
marketSearch
);

if(
marketSearch
){
S.stats.market++;
}

S.stats.steam++;

const response=
await fetch(
url,
{
credentials:
'include',

cache:
'no-store',

redirect:
'follow',

...options
}
);

if(
response.status===
429
){
S.stats.rateLimits++;
const pause=Math.min(
CFG.maxCooldown429Ms,
Math.max(CFG.cooldown429Ms,retryAfterMilliseconds(response))
);
const until=Date.now()+pause;
S.rateLimitUntil[channel]=Math.max(Number(S.rateLimitUntil[channel]||0),until);
S.lastRateLimit={channel,until,label,at:Date.now()};
throw rateLimitError(label,channel,S.rateLimitUntil[channel]);
}

if(
[
502,
503,
504
]
.includes(
response.status
)
){
S.stats.retries++;

lastError=
new Error(
`${label}: HTTP ${response.status}`
);

await sleep(
2000*
attempt
);

continue;
}

if(
!response.ok
){
throw new Error(
`${label}: HTTP ${response.status}`
);
}

return response;

}catch(error){
lastError=
error;

if(isRateLimitError(error)){
break;
}

if(
attempt>=
CFG.maxAttempts
){
break;
}

S.stats.retries++;

await sleep(
1500*
attempt
);
}
}

throw(
lastError||
new Error(
`${label} fehlgeschlagen`
)
);
}

function parseSceEntry(
entry,
inventoryMode=false
){
if(
!Array.isArray(
entry
)
){
return null;
}

let appid=null;
let title='';
let cardsInSet=0;
let priceText='';

if(
Array.isArray(
entry[0]
)
){
appid=
String(
entry[0][0]??
''
);

title=
clean(
entry[0][1]
);

if(
inventoryMode
){
cardsInSet=
Number(
entry?.[3]?.[0]||
0
);

}else{
cardsInSet=
Number(
entry[1]||
0
);

priceText=
clean(
entry[2]
);
}

}else if(
/^\d+$/
.test(
String(
entry[0]??
''
)
)&&
typeof entry[1]===
'string'
){
appid=
String(
entry[0]
);

title=
clean(
entry[1]
);

cardsInSet=
Number(
entry[2]||
0
);

priceText=
clean(
entry[3]
);
}

if(
!/^\d+$/
.test(
appid||
''
)||
!title
){
return null;
}

return{
appid,
title,

cardsInSet:
Number.isFinite(
cardsInSet
)
?cardsInSet
:0,

scePriceText:
priceText||
null,

scePriceCents:
priceText
?moneyCents(
priceText
)
:null
};
}

function parseScePayload(
raw,
inventoryMode=false
){
const output=[];
const seen=
new Set();

const maybePush=
entry=>{
const parsed=
parseSceEntry(
entry,
inventoryMode
);

if(
!parsed||
seen.has(
parsed.appid
)
){
return;
}

seen.add(
parsed.appid
);

output.push(
parsed
);
};

if(
Array.isArray(
raw?.data
)
){
raw.data.forEach(
maybePush
);

}else if(
Array.isArray(
raw
)
){
raw.forEach(
maybePush
);

}else if(
raw&&
typeof raw===
'object'
){
Object.values(
raw
)
.forEach(
maybePush
);
}

return output;
}

async function loadSceCatalog(){
try{
const cached=
JSON.parse(
localStorage.getItem(
CFG.sceCatalogCacheKey
)||
'null'
);

if(
cached?.ts&&
Date.now()-
cached.ts<
CFG.sceCatalogCacheMs&&
Array.isArray(
cached.items
)&&
cached.items.length
){
return cached.items;
}
}catch{}

let items=[];

try{
const response=
await gm(
CFG.sceBadgePricesUrl,
'text'
);

const raw=
JSON.parse(
response.responseText||
String(
response.response||
''
)
);

items=
parseScePayload(
raw,
false
);

}catch(error){
console.warn(
'[Badge Scout] Badge price catalog failed',
error
);
}

if(
!items.length
){
const response=
await gm(
CFG.sceInventoryUrl,
'text'
);

const raw=
JSON.parse(
response.responseText||
String(
response.response||
''
)
);

items=
parseScePayload(
raw,
true
);
}

if(
!items.length
){
throw new Error(
'SteamCardExchange-Katalog konnte nicht gelesen werden.'
);
}

try{
localStorage.setItem(
CFG.sceCatalogCacheKey,
JSON.stringify({
ts:
Date.now(),
items
})
);
}catch{}

return items;
}

function marketSearchUrl({
query='',
start=0,
gameAppId=null,
cardBorder=0
}={}){
const url=
new URL(
'https://steamcommunity.com/market/search/render/'
);

url.searchParams.set(
'query',
query
);

url.searchParams.set(
'start',
String(
start
)
);

url.searchParams.set(
'count',
String(
CFG.marketPageSize
)
);

url.searchParams.set(
'search_descriptions',
'0'
);

url.searchParams.set(
'sort_column',
query
?'popular'
:'price'
);

url.searchParams.set(
'sort_dir',
query
?'desc'
:'asc'
);

url.searchParams.set(
'appid',
String(
CFG.marketAppId
)
);

url.searchParams.set(
'norender',
'1'
);

url.searchParams.set(
'l',
CFG.language
);

url.searchParams.append(
'category_753_item_class[]',
'tag_item_class_2'
);

url.searchParams.append(
'category_753_cardborder[]',
cardBorder===
1
?'tag_cardborder_1'
:'tag_cardborder_0'
);

if(
gameAppId
){
url.searchParams.append(
'category_753_Game[]',
`tag_app_${gameAppId}`
);
}

return url.toString();
}

function appidFromHash(
hash
){
return(
String(
hash||
''
)
.match(
/^(\d+)-/
)
?.[1]||
null
);
}

function nameFromHash(
hash,
appid
){
let value=
String(
hash||
''
);

if(
appid&&
value.startsWith(
`${appid}-`
)
){
value=
value.slice(
String(
appid
)
.length+
1
);
}

return value
.replace(
/\s*\(Trading Card\)\s*$/i,
''
)
.replace(
/\s*\(Foil Trading Card\)\s*$/i,
''
)
.replace(
/\s*\(Foil\)\s*$/i,
''
)
.trim();
}

function parseMarketJsonResults(
data
){
const rows=[];

const results=
Array.isArray(
data?.results
)
?data.results
:[];

for(const item of results){
const hash=
clean(
item.hash_name||
item
.asset_description
?.market_hash_name||
''
);

const appid=
appidFromHash(
hash
);

if(
!hash||
!appid
){
continue;
}

const price=
Number(
item.sell_price
);

rows.push({
appid,

gameName:
clean(
item.app_name||
''
),

itemName:
clean(
item.name||
item
.asset_description
?.market_name||
nameFromHash(
hash,
appid
)
),

marketHashName:
hash,

marketUrl:
`https://steamcommunity.com/market/listings/753/`+
encodeURIComponent(
hash
),

priceCents:
Number.isFinite(
price
)&&
price>0
?price
:null,

priceText:
clean(
item.sell_price_text||
item.sale_price_text||
''
),

sellListings:
Number(
item.sell_listings||
0
)
});
}

return rows;
}

async function marketSearch(
options
){
const response=
await steamFetch(
marketSearchUrl(
options
),
{
headers:{
Accept:
'application/json'
}
},
'Steam-Marktsuche',
true
);

const text=
await response.text();

let data;

try{
data=
JSON.parse(
text
);

}catch{
throw new Error(
'Steam-Marktsuche lieferte kein JSON'
);
}

if(
data.success!==
true&&
data.success!==
1
){
throw new Error(
'Steam-Marktsuche meldete keinen Erfolg'
);
}

return{
rows:
parseMarketJsonResults(
data
),

totalCount:
Number(
data.total_count||
data.searchdata
?.total_count||
0
),

pageSize:
Number(
data.pagesize||
data.searchdata
?.pagesize||
CFG.marketPageSize
)
};
}

function indexGlobalMarketRows(rows){
const byApp=new Map();
for(const row of rows||[]){
const appid=String(row?.appid||'');
if(!appid)continue;
if(!byApp.has(appid))byApp.set(appid,[]);
byApp.get(appid).push(row);
}
for(const appRows of byApp.values()){
appRows.sort((a,b)=>(a.priceCents??999999)-(b.priceCents??999999));
}
return byApp;
}

function installGlobalMarketSnapshot(snapshot,status='ready'){
const rows=Array.isArray(snapshot?.rows)?snapshot.rows:[];
S.globalMarketSnapshot={
rows,
ts:Number(snapshot?.ts||Date.now()),
pages:Number(snapshot?.pages||0),
complete:Boolean(snapshot?.complete),
status
};
S.globalMarketRowsByApp=indexGlobalMarketRows(rows);
return rows;
}

async function loadGlobalNormalMarketSnapshot(force=false){
if(!force&&S.globalMarketSnapshot&&
Date.now()-Number(S.globalMarketSnapshot.ts||0)<=CFG.globalMarketSnapshotFreshMs){
return S.globalMarketSnapshot.rows;
}

if(!force){
const fresh=readTimedCache(
CFG.globalMarketSnapshotKey,
CFG.globalMarketSnapshotFreshMs
);
if(Array.isArray(fresh?.rows)&&fresh.rows.length){
return installGlobalMarketSnapshot(fresh,'cached');
}
}

const stale=readTimedCache(
CFG.globalMarketSnapshotKey,
CFG.globalMarketSnapshotFallbackMs
);
const all=[];
const seen=new Set();
let pages=0;

try{
for(let page=0;page<CFG.globalCheapMarketPages;page++){
if(S.stop)break;
status(
`💶 Schnellmarkt ${page+1}/${CFG.globalCheapMarketPages}: günstige Sammelkarten werden gebündelt geladen …`
);
const data=await marketSearch({
start:page*CFG.marketPageSize,
cardBorder:0
});
pages++;
S.stats.globalMarketPages++;
for(const row of data.rows){
if(seen.has(row.marketHashName))continue;
seen.add(row.marketHashName);
all.push(row);
}
if(!data.rows.length||(page+1)*CFG.marketPageSize>=data.totalCount)break;
}

if(all.length){
const payload={rows:all,pages,complete:pages>=CFG.globalCheapMarketPages};
writeTimedCache(CFG.globalMarketSnapshotKey,payload);
return installGlobalMarketSnapshot({ts:Date.now(),...payload},'ready');
}
}catch(error){
console.warn('[Badge Scout] Globaler Schnellmarkt konnte nicht vollständig geladen werden',error);
if(all.length){
const merged=[...new Map([
...(Array.isArray(stale?.rows)?stale.rows:[]),
...all
].map(row=>[row.marketHashName,row])).values()];
return installGlobalMarketSnapshot(
{ts:Date.now(),rows:merged,pages,complete:false},
'partial'
);
}
if(Array.isArray(stale?.rows)&&stale.rows.length){
return installGlobalMarketSnapshot(stale,'stale');
}
throw error;
}

if(Array.isArray(stale?.rows)&&stale.rows.length){
return installGlobalMarketSnapshot(stale,'stale');
}
return installGlobalMarketSnapshot(
{ts:Date.now(),rows:all,pages,complete:false},
'partial'
);
}

async function marketRowsForGame(
appid,
cardBorder=0,
options={}
){
if(
cardBorder===0&&
S.fastDiscoveryMode&&
options.forceNetwork!==true
){
return S.globalMarketRowsByApp.get(String(appid))||[];
}

const key=
`${appid}|${cardBorder}|network`;

if(
S.marketRowsCache.has(
key
)
){
return S.marketRowsCache.get(
key
);
}

const promise=
(
async()=>{
const all=[];
const seen=
new Set();

let start=0;

for(
let page=0;
page<
CFG.maxMarketPagesPerGame;
page++
){
const data=
await marketSearch({
start,
gameAppId:
appid,
cardBorder
});

for(const row of data.rows){
if(
seen.has(
row.marketHashName
)
){
continue;
}

seen.add(
row.marketHashName
);

all.push(
row
);
}

const pageSize=
Math.max(
1,
data.pageSize||
CFG.marketPageSize
);

start+=
pageSize;

if(
!data.rows.length||
start>=
data.totalCount
){
break;
}
}

return all;
}
)();

S.marketRowsCache.set(
key,
promise
);

try{
return await promise;

}catch(error){
S.marketRowsCache.delete(
key
);

throw error;
}
}

async function fetchBadgeStateFresh(
appid,
fallbackName=''
){
if(
!S.profile
){
return{
accessible:false,
badgeLevel:0,
badgeMaxed:false,
maxLevel:5,
cards:[],
gameName:fallbackName
};
}

try{
const ajaxUrl=
`${S.profile}`+
`/ajaxgetbadgeinfo/${appid}/`;

const response=
await steamFetch(
ajaxUrl,
{
headers:{
Accept:
'application/json'
}
},
`Badge-Info ${fallbackName || appid}`
);

const text=
await response.text();

const data=
JSON.parse(
text
);

const badge=
data?.badgedata;

if(
badge&&
Array.isArray(
badge.rgCards
)&&
badge.rgCards.length
){
const level=
Number(
badge.level||
0
);

const maxLevel=
Number(
badge.maxlevel||
5
);

return{
accessible:true,

badgeUrl:
`${S.profile}/gamecards/${appid}/`,

badgeLevel:
level,

badgeMaxed:
Boolean(
badge.bMaxed
)||
level>=
maxLevel,

maxLevel,

cards:
badge.rgCards.map(
(
card,
index
)=>({
nr:
index+
1,

name:
clean(
card.name||
card.title||
`Karte ${index + 1}`
),

owned:
Number(
card.owned||
0
),

marketHashFromBadge:
clean(
card.markethash||
card.market_hash_name||
''
)||
null
})
),

gameName:
fallbackName
};
}
}catch{}

try{
const url=
`${S.profile}`+
`/gamecards/${appid}/?l=english`;

const response=
await steamFetch(
url,
{
headers:{
Accept:
'text/html'
}
},
`Badge-Seite ${fallbackName || appid}`
);

const doc=
new DOMParser()
.parseFromString(
await response.text(),
'text/html'
);

const nodes=
[
...doc
.querySelectorAll(
'.badge_card_set_card'
)
];

if(
!nodes.length
){
return{
accessible:false,
badgeLevel:0,
badgeMaxed:false,
maxLevel:5,
cards:[],
gameName:fallbackName
};
}

let level=0;

for(const element of
doc.querySelectorAll(
'.badge_info, .badge_info_description, .badge_title'
)
){
const found=
clean(
element.textContent
)
.match(
/(?:Level|Stufe)\s*(\d+)/i
);

if(
found
){
level=
Number(
found[1]
);

break;
}
}

const cards=
nodes.map(
(
element,
index
)=>{
const qty=
Number(
element
.querySelector(
'.badge_card_set_text_qty'
)
?.textContent
?.match(
/\((\d+)\)/
)
?.[1]||
0
);

const directName=
clean(
element
.querySelector(
'.badge_card_set_text_cardname'
)
?.textContent||
''
);

const title=
element
.querySelector(
'.badge_card_set_title'
);

let fallbackCardName=
'';

if(
title
){
const clone=
title.cloneNode(
true
);

clone
.querySelectorAll(
'.badge_card_set_text_qty'
)
.forEach(
element=>
element.remove()
);

fallbackCardName=
clean(
clone.textContent
);
}

const link=
element
.querySelector(
'a[href*="/market/listings/753/"]'
)
?.href||
'';

let hash=
null;

const match=
link.match(
/\/market\/listings\/753\/(.+?)(?:\?|#|$)/
);

if(
match?.[1]
){
try{
hash=
decodeURIComponent(
match[1]
);

}catch{
hash=
match[1];
}
}

return{
nr:
index+
1,

name:
directName||
fallbackCardName||
`Karte ${index + 1}`,

owned:
qty,

marketHashFromBadge:
hash
};
}
);

return{
accessible:true,
badgeUrl:url,
badgeLevel:level,
badgeMaxed:level>=5,
maxLevel:5,
cards,
gameName:fallbackName
};

}catch{
return{
accessible:false,
badgeLevel:0,
badgeMaxed:false,
maxLevel:5,
cards:[],
gameName:fallbackName
};
}
}

async function getBadgeState(
appid,
fallbackName=''
){
const key=
String(
appid
);

if(
S.badgeCache.has(
key
)
){
return S.badgeCache.get(
key
);
}

const promise=
fetchBadgeStateFresh(
appid,
fallbackName
);

S.badgeCache.set(
key,
promise
);

try{
return await promise;

}catch(error){
S.badgeCache.delete(
key
);

throw error;
}
}

function foilHashLooksFoil(
value
){
return/\(Foil(?: Trading Card)?\)/i
.test(
String(
value||
''
)
);
}

async function fetchFoilBadgeStateFresh(
appid,
fallbackName=''
){
if(
!S.profile
){
return{
accessible:false,
badgeLevel:0,
badgeMaxed:false,
maxLevel:1,
cards:[],
gameName:fallbackName,
reason:'Profil nicht erkannt'
};
}

try{
const ajaxUrl=
`${S.profile}`+
`/ajaxgetbadgeinfo/${appid}/?border=1`;

const response=
await steamFetch(
ajaxUrl,
{
headers:{
Accept:
'application/json'
}
},
`Foil-Badge-Info ${fallbackName || appid}`
);

const data=
JSON.parse(
await response.text()
);

const badge=
data?.badgedata;

const rawCards=
Array.isArray(
badge?.rgCards
)
?badge.rgCards
:[];

const foilCards=
rawCards.filter(
card=>
foilHashLooksFoil(
card.markethash||
card.market_hash_name||
''
)
);

if(
badge&&
foilCards.length
){
const level=
Number(
badge.level||
0
);

return{
accessible:true,

badgeUrl:
`${S.profile}/gamecards/${appid}/?border=1`,

badgeLevel:
level,

badgeMaxed:
Boolean(
badge.bMaxed
)||
level>=1,

maxLevel:
1,

cards:
foilCards.map(
(
card,
index
)=>({
nr:
index+
1,

name:
clean(
card.name||
card.title||
`Foil-Karte ${index + 1}`
),

owned:
Number(
card.owned||
0
),

marketHashFromBadge:
clean(
card.markethash||
card.market_hash_name||
''
)||
null
})
),

gameName:
fallbackName,

source:
'ajax-border-1'
};
}
}catch{}

try{
const url=
`${S.profile}`+
`/gamecards/${appid}/?border=1&l=english`;

const response=
await steamFetch(
url,
{
headers:{
Accept:
'text/html'
}
},
`Foil-Badge-Seite ${fallbackName || appid}`
);

const doc=
new DOMParser()
.parseFromString(
await response.text(),
'text/html'
);

const nodes=
[
...doc
.querySelectorAll(
'.badge_card_set_card'
)
];

if(
!nodes.length
){
return{
accessible:false,
badgeLevel:0,
badgeMaxed:false,
maxLevel:1,
cards:[],
gameName:fallbackName,
reason:'Foil-Badge-Seite ohne Karten'
};
}

const cards=
nodes.map(
(
element,
index
)=>{
const qty=
Number(
element
.querySelector(
'.badge_card_set_text_qty'
)
?.textContent
?.match(
/\((\d+)\)/
)
?.[1]||
0
);

const directName=
clean(
element
.querySelector(
'.badge_card_set_text_cardname'
)
?.textContent||
''
);

const title=
element
.querySelector(
'.badge_card_set_title'
);

let fallbackCardName=
'';

if(
title
){
const clone=
title.cloneNode(
true
);

clone
.querySelectorAll(
'.badge_card_set_text_qty'
)
.forEach(
node=>
node.remove()
);

fallbackCardName=
clean(
clone.textContent
);
}

const link=
element
.querySelector(
'a[href*="/market/listings/753/"]'
)
?.href||
'';

let hash=
null;

const match=
link.match(
/\/market\/listings\/753\/(.+?)(?:\?|#|$)/
);

if(
match?.[1]
){
try{
hash=
decodeURIComponent(
match[1]
);

}catch{
hash=
match[1];
}
}

return{
nr:
index+
1,

name:
directName||
fallbackCardName||
`Foil-Karte ${index + 1}`,

owned:
qty,

marketHashFromBadge:
hash
};
}
);

if(
!cards.some(
card=>
foilHashLooksFoil(
card.marketHashFromBadge
)
)
){
return{
accessible:false,
badgeLevel:0,
badgeMaxed:false,
maxLevel:1,
cards:[],
gameName:fallbackName,
reason:'border=1 lieferte keine eindeutig erkennbaren Foil-Marktlinks'
};
}

let level=0;

for(const element of
doc.querySelectorAll(
'.badge_info, .badge_info_description, .badge_title'
)
){
const found=
clean(
element.textContent
)
.match(
/(?:Level|Stufe)\s*(\d+)/i
);

if(
found
){
level=
Number(
found[1]
);

break;
}
}

return{
accessible:true,
badgeUrl:url,
badgeLevel:level,
badgeMaxed:level>=1,
maxLevel:1,
cards,
gameName:fallbackName,
source:'html-border-1'
};

}catch(error){
return{
accessible:false,
badgeLevel:0,
badgeMaxed:false,
maxLevel:1,
cards:[],
gameName:fallbackName,
reason:String(
error?.message||
error
)
};
}
}

async function getFoilBadgeState(
appid,
fallbackName=''
){
const key=
String(
appid
);

if(
S.foilBadgeCache.has(
key
)
){
return S.foilBadgeCache.get(
key
);
}

const promise=
fetchFoilBadgeStateFresh(
appid,
fallbackName
);

S.foilBadgeCache.set(
key,
promise
);

try{
return await promise;

}catch(error){
S.foilBadgeCache.delete(
key
);

throw error;
}
}

function scxImageUrl(
imageElement,
base
){
let image=
imageElement
?.getAttribute(
'src'
)||
imageElement
?.getAttribute(
'data-src'
)||
'';

try{
image=
new URL(
image,
base
)
.toString();

}catch{}

return image;
}

function scxBadgeNameFromImage(
imageElement,
fallback
){
const alt=
clean(
imageElement
?.getAttribute(
'alt'
)||
''
);

return(
clean(
alt.replace(
/^Series\s*1\s*-\s*/i,
''
)
)||
fallback
);
}

function findFoilBadgeImage(
doc,
normalImages
){
const normalSet=
new Set(
normalImages||
[]
);

const possibleHeaders=
[
...doc
.querySelectorAll(
'[id], h1, h2, h3, h4, h5, h6, a'
)
]
.filter(
element=>{
const id=
clean(
element.id||
''
);

const text=
clean(
element.textContent||
''
);

return(
/foil.*badge|badge.*foil/i
.test(
id
)||
(
/^foil badges?$/i
.test(
text
)&&
text.length<
80
)
);
}
);

for(const header of
possibleHeaders
){
const containers=[
header.nextElementSibling,
header.parentElement
?.nextElementSibling,
header.parentElement
?.parentElement
?.nextElementSibling,
header.parentElement,
header.parentElement
?.parentElement
]
.filter(
Boolean
);

for(const container of
containers
){
const image=
[
...container
.querySelectorAll(
'img[alt*="Series 1 -"]'
)
]
.find(
candidate=>
!normalSet.has(
candidate
)
);

if(
image
){
return image;
}
}
}

return[
...doc
.querySelectorAll(
'img[alt*="Series 1 -"]'
)
]
.find(
image=>
!normalSet.has(
image
)
)||
null;
}

function parseScx(
html,
base
){
const doc=
new DOMParser()
.parseFromString(
html,
'text/html'
);

const levels=[];
const normalImagesUsed=[];

const section=
doc.getElementById(
'series-1-badges'
);

const grid=
section
?.parentElement
?.nextElementSibling||
null;

const images=
grid
?[
...grid
.querySelectorAll(
'img'
)
]
:[
...doc
.querySelectorAll(
'img[alt*="Series 1 -"]'
)
];

for(
let i=0;
i<
images.length&&
levels.length<
5;
i++
){
const imageElement=
images[i];

const alt=
clean(
imageElement
.getAttribute(
'alt'
)||
''
);

if(
!/Series\s*1\s*-/i
.test(
alt
)
){
continue;
}

const name=
scxBadgeNameFromImage(
imageElement,
`Level ${levels.length + 1}`
);

const image=
scxImageUrl(
imageElement,
base
);

let level=
null;

let node=
imageElement
.parentElement;

for(
let depth=0;
depth<
5&&
node;
depth++,
node=
node.parentElement
){
const match=
clean(
node.textContent
)
.match(
/Level\s*([1-5])/i
);

if(
match
){
level=
Number(
match[1]
);

break;
}
}

if(
!level||
levels.some(
item=>
item.level===
level
)
){
level=
levels.length+
1;
}

levels.push({
level,
name,
image
});

normalImagesUsed.push(
imageElement
);
}

levels.sort(
(a,b)=>
a.level-
b.level
);

const foilImageElement=
findFoilBadgeImage(
doc,
normalImagesUsed
);

const foilBadge=
foilImageElement
?{
level:1,

name:
scxBadgeNameFromImage(
foilImageElement,
'Glanzabzeichen'
),

image:
scxImageUrl(
foilImageElement,
base
)
}
:null;

const body=
clean(
doc.body
?.textContent||
''
);

return{
levels,
foilBadge,

cardCount:
Number(
body.match(
/Cards:\s*(\d+)/i
)
?.[1]||
0
)
};
}

function fastBadgeVisualData(
candidate
){
const appid=
String(
candidate?.appid||
''
);

const game=
S.badgeNameMap.get(
appid
)||
null;

const levels=
(
game?.levels||
candidate
?.badgeSeedLevels||
[]
)
.map(
item=>({
level:
Number(
item.level||
0
),

name:
clean(
item.name||
''
),

image:
clean(
item.image||
''
)
})
)
.filter(
item=>
item.level>=
1&&
item.level<=
5&&
item.name
);

if(
!levels.length
){
return null;
}

return{
url:
`${CFG.sceGameBase}${encodeURIComponent(appid)}=`,

levels,

foilBadge:
null,

cardCount:
Number(
candidate?.cardsInSet||
0
),

fastVisualOnly:
true
};
}

async function fetchScxFresh(
appid
){
const url=
`${CFG.sceGameBase}`+
`${encodeURIComponent(appid)}=`;

try{
const response=
await gm(
url,
'text'
);

return{
url,
...parseScx(
response.responseText||
'',
url
)
};

}catch(error){
return{
url,
levels:[],
foilBadge:null,
cardCount:0,
error:String(
error?.message||
error
)
};
}
}

async function getScx(
appid
){
const key=
String(
appid
);

if(
S.scxCache.has(
key
)
){
return S.scxCache.get(
key
);
}

const promise=
fetchScxFresh(
appid
);

S.scxCache.set(
key,
promise
);

try{
return await promise;

}catch(error){
S.scxCache.delete(
key
);

throw error;
}
}

async function fetchPopularityFresh(
appid
){
const url=
`https://store.steampowered.com/appreviews/`+
`${encodeURIComponent(appid)}`+
`?json=1&language=all&purchase_type=all&num_per_page=0`;

try{
const response=
await gm(
url,
'text'
);

const data=
JSON.parse(
response.responseText||
String(
response.response||
''
)
);

const summary=
data
?.query_summary;

if(
!summary
){
return null;
}

const total=
Number(
summary.total_reviews||
0
);

const positive=
Number(
summary.total_positive||
0
);

return{
totalReviews:
total,

positivePct:
total
?round2(
positive/
total*
100
)
:null,

reviewScoreDesc:
summary.review_score_desc||
null
};

}catch{
return null;
}
}

async function getPopularity(
appid
){
const key=
String(
appid
);

if(
S.popularityCache.has(
key
)
){
return S.popularityCache.get(
key
);
}

const promise=
fetchPopularityFresh(
appid
);

S.popularityCache.set(
key,
promise
);

try{
return await promise;

}catch(error){
S.popularityCache.delete(
key
);

throw error;
}
}

function exactMarketMatch(
card,
rows,
appid
){
if(
card
.marketHashFromBadge
){
const exact=
rows.find(
row=>
row.marketHashName===
card
.marketHashFromBadge
);

if(
exact
){
return exact;
}
}

const wanted=
norm(
card.name
);

const exactName=
rows.find(
row=>
norm(
row.itemName
)===
wanted||
norm(
nameFromHash(
row.marketHashName,
appid
)
)===
wanted
);

return exactName||
null;
}

function costState(
candidate,
badge,
rows,
scx
){
const unique=
[
...new Map(
rows.map(
row=>[
row.marketHashName,
row
]
)
)
.values()
];

const expected=
Number(
candidate.cardsInSet||
badge.cards.length||
scx.cardCount||
unique.length||
0
);

let cards;

if(
badge.cards.length
){
cards=
badge.cards.map(
card=>{
const market=
exactMarketMatch(
card,
unique,
candidate.appid
);

return{
name:
card.name,

owned:
card.owned,

missing:
card.owned<
1,

priceCents:
market
?.priceCents??
null,

marketHashName:
market
?.marketHashName||
card
.marketHashFromBadge||
null
};
}
);

}else{
cards=
unique.map(
row=>({
name:
row.itemName,

owned:
0,

missing:
true,

priceCents:
row.priceCents,

marketHashName:
row.marketHashName
})
);
}

const missing=
cards.filter(
card=>
card.missing
);

const known=
missing.filter(
card=>
Number.isFinite(
card.priceCents
)
);

const exactSubtotal=
known.reduce(
(
sum,
card
)=>
sum+
card.priceCents,
0
);

const exactComplete=
missing.length===
known.length&&
expected>0&&
cards.length>=
expected;

const missingCount=
badge.cards.length
?missing.length
:(
expected||
missing.length
);

let roughPersonalCents=
null;

if(
Number.isFinite(
candidate.scePriceCents
)&&
candidate.scePriceCents!==
null&&
expected>0
){
roughPersonalCents=
Math.round(
candidate.scePriceCents*
(
missingCount/
expected
)
);
}

return{
cards,
expectedCardCount:expected,
missingCount,
knownMissingCount:known.length,
exactComplete,

exactTotalCents:
exactComplete
?exactSubtotal
:null,

exactTotal:
exactComplete
?euro(
exactSubtotal
)
:null,

roughPersonalCents,

sceFullSetText:
candidate.scePriceText||
null,

sceFullSetCents:
candidate.scePriceCents??
null,

personalPriceNeedsAnalyzer:
Boolean(badge?.summaryOnly&&Number(badge?.ownedUnique||0)>0),

priceScope:
badge?.summaryOnly&&Number(badge?.ownedUnique||0)>0
?'full-set-conservative'
:'missing-cards'
};
}

function normalSupplyState(
cost,
rows
){
const unique=
[
...new Map(
(
rows||
[]
)
.map(
row=>[
row.marketHashName,
row
]
)
)
.values()
];

const byHash=
new Map(
unique.map(
row=>[
row.marketHashName,
row
]
)
);

const listings=[];

for(const card of
cost?.cards||
[]
){
if(
!card.marketHashName
){
continue;
}

const row=
byHash.get(
card.marketHashName
);

if(
!row||
!Number.isFinite(
Number(
row.sellListings
)
)
){
continue;
}

listings.push(
Math.max(
0,
Number(
row.sellListings
)
)
);
}

const total=
listings.reduce(
(
sum,
value
)=>
sum+
value,
0
);

const min=
listings.length
?Math.min(
...listings
)
:null;

const avg=
listings.length
?round2(
total/
listings.length
)
:null;

const veryScarce=
listings.filter(
value=>
value<=
CFG
.veryFewSellListingsPerCard
)
.length;

const scarce=
listings.filter(
value=>
value<=
CFG
.fewSellListingsPerCard
)
.length;

return{
cardsWithSupply:
listings.length,

totalSellListings:
total,

minSellListings:
min,

avgSellListings:
avg,

scarceCardCount:
scarce,

veryScarceCardCount:
veryScarce
};
}

function marketQualityState(cost,supply){
const cents=Number.isFinite(Number(cost?.exactTotalCents))?Number(cost.exactTotalCents):null;
const min=Number.isFinite(Number(supply?.minSellListings))?Number(supply.minSellListings):null;
const avg=Number.isFinite(Number(supply?.avgSellListings))?Number(supply.avgSellListings):null;
const expected=Math.max(0,Number(cost?.expectedCardCount||0));
const covered=Math.max(0,Number(supply?.cardsWithSupply||0));
const coverage=expected>0?covered/expected:(covered>0?1:0);
let key='unknown',score=0,label='⚪ MARKT UNKLAR',className='marketUnknown';
let reason='Zu wenig vollständige Sell-Supply-Daten für eine belastbare Marktampel.';
if(cents!==null&&min!==null&&avg!==null&&coverage>=0.8){
if(cents<=CFG.marketSuperMaxCostCents&&min>=CFG.marketSuperMinSellListings&&avg>=CFG.marketSuperAvgSellListings){
key='super';score=5;label='🟢 MARKT-SUPER';className='marketSuper';reason='Sehr billig und selbst die knappste Karte hat massives Verkaufsangebot – ideal für breite geizige Gebote.';
}else if(cents<=CFG.marketGoodMaxCostCents&&min>=CFG.marketGoodMinSellListings&&avg>=CFG.marketGoodAvgSellListings){
key='good';score=4;label='🟢 MARKT GUT';className='marketGood';reason='Preis günstig und Sell-Seite breit genug für eine robuste Low-Bid-Strategie.';
}else if(min>=CFG.marketOkayMinSellListings&&avg>=CFG.marketOkayAvgSellListings){
key='okay';score=3;label='🟡 MARKT OKAY';className='marketOkay';reason='Markt brauchbar, aber weniger Puffer als bei den Top-Kandidaten.';
}else if(min>=CFG.marketThinMinSellListings&&avg>=CFG.marketThinAvgSellListings){
key='thin';score=2;label='🟠 MARKT DÜNN';className='marketThin';reason='Einzelne Karten sind merklich dünn; wenige Verkäufe können den Setpreis verschieben.';
}else{
key='weak';score=1;label='🔴 MARKT SCHWACH';className='marketWeak';reason='Sell-Seite zu knapp für entspanntes geiziges Massenscouting.';
}
}
return{key,score,label,className,reason,costCents:cents,minSellListings:min,avgSellListings:avg,cardsWithSupply:covered,expectedCardCount:expected,coverage:round2(coverage)};
}

function marketQualityText(result){
const q=result?.marketQuality;
if(!q)return'⚪ Markt nicht bewertet';
const supply=(q.minSellListings===null||q.avgSellListings===null)?'Supply unvollständig':`Minimum ${q.minSellListings} · Ø ${q.avgSellListings} Sell-Angebote`;
return`${q.label} · ${supply} · ${q.reason}`;
}

function foilCostState(
candidate,
badge,
rows,
scx
){
const unique=
[
...new Map(
(
rows||
[]
)
.map(
row=>[
row.marketHashName,
row
]
)
)
.values()
];

const expected=
Number(
candidate.cardsInSet||
badge.cards.length||
scx.cardCount||
unique.length||
0
);

let cards;

if(
badge.cards.length
){
cards=
badge.cards.map(
card=>{
const wanted=
norm(
card.name
);

const market=
unique.find(
row=>
norm(
nameFromHash(
row.marketHashName,
candidate.appid
)
)===
wanted||
norm(
row.itemName
)===
wanted
);

return{
name:
card.name,

priceCents:
market
?.priceCents??
null,

sellListings:
Number(
market
?.sellListings||
0
),

marketHashName:
market
?.marketHashName||
null
};
}
);

}else{
cards=
unique
.slice(
0,
expected||
unique.length
)
.map(
row=>({
name:
nameFromHash(
row.marketHashName,
candidate.appid
)||
row.itemName,

priceCents:
row.priceCents,

sellListings:
Number(
row.sellListings||
0
),

marketHashName:
row.marketHashName
})
);
}

const known=
cards.filter(
card=>
Number.isFinite(
card.priceCents
)
);

const exactSubtotal=
known.reduce(
(
sum,
card
)=>
sum+
card.priceCents,
0
);

const exactComplete=
expected>0&&
cards.length>=
expected&&
known.length>=
expected;

const offeredCards=
cards.filter(
card=>
Number.isFinite(
card.priceCents
)
);

const listings=
offeredCards.map(
card=>
Math.max(
0,
Number(
card.sellListings||
0
)
)
);

const totalSellListings=
listings.reduce(
(
sum,
value
)=>
sum+
value,
0
);

const minSellListings=
listings.length
?Math.min(
...listings
)
:null;

const avgSellListings=
listings.length
?round2(
totalSellListings/
listings.length
)
:null;

const scarceCardCount=
offeredCards.filter(
card=>
Number(
card.sellListings||
0
)<=
5
)
.length;

const veryScarceCardCount=
offeredCards.filter(
card=>
Number(
card.sellListings||
0
)<=
2
)
.length;

return{
cards,
expectedCardCount:expected,
knownCardCount:known.length,
exactComplete,

exactTotalCents:
exactComplete
?exactSubtotal
:null,

exactTotal:
exactComplete
?euro(
exactSubtotal
)
:null,

totalSellListings,
minSellListings,
avgSellListings,
scarceCardCount,
veryScarceCardCount,

note:
'Glanzbewertung nutzt aktuellen Steam-Sofortkauf und Verkaufsangebot. Buy-Order-Nachfrage wird im Scout bewusst nicht pro Foil-Karte zusätzlich abgefragt, damit die Suche nicht mit vielen Extra-Requests überlastet wird.'
};
}

function extractItemNameId(html){
for(const pattern of[/Market_LoadOrderSpread\(\s*(\d+)/i,/item_nameid\s*[:=]\s*["']?(\d+)/i,/ItemActivityTicker\.Start\([^,]+,[^,]+,\s*(\d+)/i]){
const match=String(html||'').match(pattern);
if(match?.[1])return match[1];
}
return null;
}

async function itemNameIdForHash(hash,label='Karte'){
const key=String(hash||'');
if(!key)return null;
const cached=S.deepCheckCache.get(`id:${key}`);
if(cached)return cached;
const previous=getCookie('bMarketOptOut');
setCookie('bMarketOptOut','1');
await sleep(60);
try{
const url=`https://steamcommunity.com/market/listings/${CFG.marketAppId}/${encodeURIComponent(key)}?l=${encodeURIComponent(CFG.language)}&_scout=${Date.now()}`;
const response=await steamFetch(url,{headers:{Accept:'text/html,application/xhtml+xml'}},`Orderbuch-ID ${label}`);
const id=extractItemNameId(await response.text());
if(id)S.deepCheckCache.set(`id:${key}`,String(id));
return id?String(id):null;
}finally{
restoreCookie('bMarketOptOut',previous);
await sleep(60);
}
}

async function orderHistogram(itemNameId,referrer,label='Karte'){
if(!itemNameId)return null;
const cacheKey=`hist:${itemNameId}`;
if(S.deepCheckCache.has(cacheKey))return S.deepCheckCache.get(cacheKey);
const url=new URL('https://steamcommunity.com/market/itemordershistogram');
for(const[key,value]of Object.entries({country:'DE',language:CFG.language,currency:String(CFG.currency),item_nameid:String(itemNameId),two_factor:'0',norender:'1'}))url.searchParams.set(key,value);
const response=await steamFetch(url.toString(),{referrer,headers:{Accept:'application/json'}},`Buy/Sell-Deepcheck ${label}`);
const text=await response.text();
if(text.trimStart().startsWith('<'))throw new Error('Orderbuch lieferte HTML statt JSON');
const data=JSON.parse(text);
if(!data?.success)throw new Error('Orderbuch meldete keinen Erfolg');
const lowestRaw=Number(data.lowest_sell_order);
const highestRaw=Number(data.highest_buy_order);
const value={
sellOrderCount:parseCountDigits(data.sell_order_count),
buyOrderCount:parseCountDigits(data.buy_order_count),
lowestSellCents:Number.isFinite(lowestRaw)&&lowestRaw>0?lowestRaw:null,
highestBuyCents:Number.isFinite(highestRaw)&&highestRaw>0?highestRaw:null
};
S.deepCheckCache.set(cacheKey,value);
return value;
}

function deepCheckEligible(result){
if(!CFG.deepCheckEnabled||S.mode==='foil')return false;
if(!Number.isFinite(Number(result?.cost?.exactTotalCents)))return false;
if(Number(result.cost.exactTotalCents)>CFG.deepCheckMaxExactCostCents)return false;
return Number(result?.marketQuality?.score||0)>=4&&Number(result?.normalSupply?.cardsWithSupply||0)>=3;
}

function deepCheckSampleRows(result){
const rows=[...new Map((result?.normalMarketRows||[]).map(row=>[row.marketHashName,row])).values()]
.filter(row=>row.marketHashName&&Number.isFinite(Number(row.sellListings)));
if(!rows.length)return[];
const bySupply=[...rows].sort((a,b)=>Number(a.sellListings||0)-Number(b.sellListings||0));
const picks=[];
const add=row=>{if(row&&!picks.some(x=>x.marketHashName===row.marketHashName))picks.push(row);};
add(bySupply[0]);
add(bySupply[Math.floor((bySupply.length-1)/2)]);
add([...rows].sort((a,b)=>(Number(a.priceCents)||999999)-(Number(b.priceCents)||999999))[0]);
for(const row of bySupply){if(picks.length>=CFG.deepCheckCardsPerGame)break;add(row);}
return picks.slice(0,CFG.deepCheckCardsPerGame);
}

function competitionState(samples){
const valid=samples.filter(x=>Number.isFinite(x.buySellRatio));
if(!valid.length)return{key:'unknown',score:0,label:'⚪ KAUFKONKURRENZ UNKLAR',className:'marketUnknown',avgRatio:null,worstRatio:null};
const avg=valid.reduce((sum,x)=>sum+x.buySellRatio,0)/valid.length;
const worst=Math.max(...valid.map(x=>x.buySellRatio));
if(avg<=CFG.lowBidTopMaxBuySellRatio&&worst<=Math.max(0.9,CFG.lowBidTopMaxBuySellRatio*2))return{key:'low',score:3,label:'🟢 KAUFKONKURRENZ NIEDRIG',className:'marketSuper',avgRatio:round2(avg),worstRatio:round2(worst)};
if(avg<=CFG.lowBidGoodMaxBuySellRatio&&worst<=Math.max(2,CFG.lowBidGoodMaxBuySellRatio*2))return{key:'medium',score:2,label:'🟡 KAUFKONKURRENZ SPÜRBAR',className:'marketOkay',avgRatio:round2(avg),worstRatio:round2(worst)};
return{key:'high',score:1,label:'🔴 KAUFKONKURRENZ HOCH',className:'marketWeak',avgRatio:round2(avg),worstRatio:round2(worst)};
}

function lowBidState(result){
const q=Number(result?.marketQuality?.score||0);
const c=result?.deepMarket?.competition;
if(!c)return result?._deepCheckQueued?{key:'pending',score:1,label:'🔎 LOW-BID-DEEPCHECK VORGEMERKT',className:'marketOkay'}:{key:'none',score:0,label:'',className:''};
if(q>=5&&c.key==='low')return{key:'top',score:5,label:'💎 LOW-BID-TOP',className:'marketSuper'};
if(q>=4&&['low','medium'].includes(c.key))return{key:'good',score:4,label:'🟢 LOW-BID-SEHR GUT',className:'marketGood'};
if(q>=3&&c.key!=='high')return{key:'okay',score:3,label:'🟡 LOW-BID BRAUCHBAR',className:'marketOkay'};
return{key:'weak',score:1,label:'🟠 LOW-BID NICHT PRIORISIEREN',className:'marketThin'};
}

async function deepCheckResult(result){
const rows=deepCheckSampleRows(result);
const samples=[];
for(const row of rows){
if(S.stop)break;
try{
const id=await itemNameIdForHash(row.marketHashName,row.itemName||result.title);
const ref=row.marketUrl||`https://steamcommunity.com/market/listings/${CFG.marketAppId}/${encodeURIComponent(row.marketHashName)}`;
const hist=await orderHistogram(id,ref,row.itemName||result.title);
if(!hist)continue;
const sell=Math.max(0,Number(hist.sellOrderCount||0));
const buy=Math.max(0,Number(hist.buyOrderCount||0));
samples.push({name:row.itemName||nameFromHash(row.marketHashName,result.appid),marketHashName:row.marketHashName,sellOrderCount:sell,buyOrderCount:buy,buySellRatio:sell>0?round2(buy/sell):null,lowestSellCents:hist.lowestSellCents,highestBuyCents:hist.highestBuyCents,spreadCents:Number.isFinite(hist.lowestSellCents)&&Number.isFinite(hist.highestBuyCents)?hist.lowestSellCents-hist.highestBuyCents:null});
}catch(error){
if(isRateLimitError(error))throw error;
console.warn('[Badge Scout] Deepcheck card failed',row.marketHashName,error);
}
}
const competition=competitionState(samples);
return{checkedAt:Date.now(),sampleCount:samples.length,samples,competition,note:'Buy/Sell-Verhältnis = gesamte aktive Buy-Orders geteilt durch aktive Sell-Orders der Stichprobe. Das ist ein Konkurrenzindikator, KEINE Fill-Wahrscheinlichkeit und kein Ersatz für Volumen/History im Analyzer/Wächter.'};
}

function deepCheckPriority(result){
const marketScore=Number(result?.marketQuality?.score||0);
const cost=Number(result?.cost?.exactTotalCents??9999);
const minSupply=Number(result?.normalSupply?.minSellListings||0);
return marketScore*100000-cost*100+Math.min(9999,minSupply);
}

function queueDeepCheck(result){
if(!deepCheckEligible(result))return;
const key=String(result.appid);
const cached=S.deepResultsByApp.get(key);
if(cached){
result.deepMarket=cached;
S.deepChecked.add(key);
return;
}
if(S.deepChecked.has(key)||S.deepCheckQueued.has(key)||S.deepCheckCompleted>=CFG.deepCheckMaxGames)return;
result._deepCheckPriority=deepCheckPriority(result);
const remainingCapacity=Math.max(0,CFG.deepCheckMaxGames-S.deepCheckCompleted);
if(remainingCapacity<=0)return;
if(S.deepCheckQueue.length<remainingCapacity){
S.deepCheckQueued.add(key);result._deepCheckQueued=true;S.deepCheckQueue.push(result);
}else{
let worstIndex=0;
for(let i=1;i<S.deepCheckQueue.length;i++)if(Number(S.deepCheckQueue[i]._deepCheckPriority||0)<Number(S.deepCheckQueue[worstIndex]._deepCheckPriority||0))worstIndex=i;
const worst=S.deepCheckQueue[worstIndex];
if(Number(result._deepCheckPriority||0)<=Number(worst?._deepCheckPriority||0))return;
S.deepCheckQueued.delete(String(worst.appid));worst._deepCheckQueued=false;
S.deepCheckQueue[worstIndex]=result;S.deepCheckQueued.add(key);result._deepCheckQueued=true;
}
S.deepCheckQueue.sort((a,b)=>Number(b._deepCheckPriority||0)-Number(a._deepCheckPriority||0));
}

async function processDeepChecks(limit=1){
if(S.deepCheckBusy||!CFG.deepCheckEnabled)return;
S.deepCheckBusy=true;
try{
let done=0;
while(S.deepCheckQueue.length&&done<limit&&!S.stop&&S.deepCheckCompleted<CFG.deepCheckMaxGames){
const result=S.deepCheckQueue.shift();
const key=String(result.appid);
S.deepCheckQueued.delete(key);
result._deepCheckQueued=false;
if(S.deepChecked.has(key))continue;
status(`🔬 Low-Bid-Deepcheck ${S.deepCheckCompleted+1}/${CFG.deepCheckMaxGames}: ${result.title} · nur Stichprobe, damit der Großscan schnell bleibt …`);
try{
result.deepMarket=await deepCheckResult(result);
S.deepResultsByApp.set(key,result.deepMarket);
S.stats.deepChecks++;
}catch(error){
result.deepMarket={checkedAt:Date.now(),sampleCount:0,samples:[],competition:{key:'unknown',score:0,label:'⚪ KAUFKONKURRENZ UNKLAR',className:'marketUnknown',avgRatio:null,worstRatio:null},error:String(error?.message||error)};
if(isRateLimitError(error)){
S.deepCheckQueue.unshift(result);
S.deepCheckQueued.add(key);
result._deepCheckQueued=true;
status(`⏸ Low-Bid-Prüfung pausiert: ${activeRateLimitText()}. Bereits geladene Scout-Ergebnisse bleiben nutzbar.`);
break;
}
}
S.deepChecked.add(key);S.deepCheckCompleted++;done++;
refreshResultCard(result);
updateMoreUi();
}
}finally{S.deepCheckBusy=false;}
}

function deepMarketText(result){
const deep=result?.deepMarket;
if(!deep){return result?._deepCheckQueued?'🔎 Low-Bid-Kandidat vorgemerkt – mit „Top 5 Low-Bid prüfen“ gezielt starten.':'';}
const c=deep.competition;
if(!c)return'';
const ratio=c.avgRatio===null?'—':c.avgRatio.toFixed(2).replace('.',',');
const worst=c.worstRatio===null?'—':c.worstRatio.toFixed(2).replace('.',',');
const low=lowBidState(result);
return`${low.label} · ${c.label} · Ø Buy/Sell ${ratio} · schlechteste Stichprobe ${worst} · ${deep.sampleCount} Karte(n) geprüft · Konkurrenzindikator, keine Fill-Garantie.`;
}

function applyExactNormalMarket(result,rows){
const cost=costState(result,result.badge,rows,result.scx);
if(result?.badge?.summaryOnly&&Number(result?.badge?.ownedUnique||0)>0){
cost.personalPriceNeedsAnalyzer=true;
cost.priceScope='full-set-conservative';
}
const supply=normalSupplyState(cost,rows);
result.cost=cost;
result.normalSupply=supply;
result.marketQuality=marketQualityState(cost,supply);
result.normalMarketRows=rows;
result.marketDataSource='exact-game';
result.marketValidatedAt=Date.now();
S.marketValidatedApps.add(String(result.appid));
queueDeepCheck(result);
return result;
}

function marketValidationCandidates(limit){
return [...S.results]
.filter(result=>
!S.marketValidatedApps.has(String(result.appid))&&
!result?.badge?.badgeMaxed&&
(
!result?.cost?.exactComplete||
Number(result?.marketQuality?.coverage||0)<1||
result?.marketQuality?.key==='unknown'
)
)
.sort((a,b)=>
efficiencyScore(a)-efficiencyScore(b)||
Number(b?.normalSupply?.cardsWithSupply||0)-Number(a?.normalSupply?.cardsWithSupply||0)
)
.slice(0,Math.max(0,limit));
}

async function validateTopMarketResults(limit=CFG.manualExactValidationGames,manual=true){
if(S.marketValidationBusy)return;
const candidates=marketValidationCandidates(limit);
if(!candidates.length){
if(manual)status('✅ Die besten geladenen Kandidaten sind bereits marktgenau geprüft.');
return;
}
S.marketValidationBusy=true;
try{
let completed=0;
for(const result of candidates){
if(S.stop)break;
try{
status(`📊 Marktvalidierung ${completed+1}/${candidates.length}: ${result.title} …`);
const rows=await marketRowsForGame(result.appid,0,{forceNetwork:true});
applyExactNormalMarket(result,rows);
S.stats.marketValidations++;
completed++;
refreshResultCard(result);
updateMoreUi();
}catch(error){
console.warn('[Badge Scout] Marktvalidierung pausiert',result.appid,error);
if(isRateLimitError(error)){
status(`⏸ Exaktprüfung pausiert: ${activeRateLimitText()}. Schnellmarkt-Treffer bleiben sichtbar; später erneut prüfen.`);
break;
}
}
}
syncVisibleResults(true);
if(completed&&(!activeRateLimitText()||completed===candidates.length)){
status(`✅ ${completed} Top-Kandidat(en) mit spielbezogenem Steam-Markt exakt nachgeprüft.`);
}
}finally{
S.marketValidationBusy=false;
updateMoreUi();
}
}

async function runBestDeepChecks(){
if(S.deepCheckBusy)return;
for(const result of [...S.results].sort((a,b)=>deepCheckPriority(b)-deepCheckPriority(a))){
queueDeepCheck(result);
}
if(!S.deepCheckQueue.length){
status('ℹ Kein marktbestätigter Low-Bid-Kandidat offen. Erst „Nächste 20 live prüfen“ nutzen oder weitere Treffer laden.');
return;
}
await processDeepChecks(CFG.deepCheckManualBatchSize);
syncVisibleResults(true);
if(!activeRateLimitText()){
status(`✅ Gezielter Low-Bid-Deepcheck abgeschlossen: ${S.deepCheckCompleted} Set(s) in dieser Suche geprüft.`);
}
}

function expandTheme(
query
){
const raw=
clean(
query
);

let best=
null;

let bestScore=
0;

for(const group of THEMES){
for(const alias of
group.aliases
){
const score=
sim(
raw,
alias
);

if(
score>
bestScore
){
bestScore=
score;

best=
group;
}
}
}

const terms=[
raw
];

if(
best&&
bestScore>=
0.66
){
terms.push(
...best.terms
);
}

return[
...new Set(
terms
.map(
clean
)
.filter(
Boolean
)
)
];
}

function textThemeScore(
text,
terms
){
const haystack=
norm(
text
);

let score=
0;

terms.forEach(
(
term,
index
)=>{
const needle=
norm(
term
);

if(
!needle
){
return;
}

if(
haystack.includes(
needle
)
){
score+=
index===
0
?14
:6;

}else{
const similarity=
sim(
haystack,
needle
);

if(
similarity>
0.72
){
score+=
similarity*
2;
}
}
}
);

return score;
}

function parseBadgeCollectionDocument(doc){
const hints=new Map();

for(const row of doc.querySelectorAll('.badge_row')){
const link=
row
.querySelector(
'a[href*="/gamecards/"]'
)
?.href||
'';

const appid=
link.match(
/\/gamecards\/(\d+)/
)
?.[1];

if(
!appid
){
continue;
}

const text=
clean(
row.textContent
);

const cards=
text.match(
/(\d+)\s*(?:of|von)\s*(\d+)\s*(?:cards?|Karten)/i
);

const level=
Number(
text.match(
/(?:Level|Stufe)\s*(\d+)/i
)
?.[1]||
0
);

const ownedUnique=cards?Number(cards[1]):0;
const cardCount=cards?Number(cards[2]):null;
const title=clean(
row.querySelector('.badge_title')?.textContent||
row.querySelector('.badge_title_row')?.textContent||
row.querySelector('a[href*="/gamecards/"]')?.textContent||
''
).replace(/\s+(?:Level|Stufe)\s*\d+.*$/i,'');

hints.set(
appid,
{
appid,
title,
ownedUnique,
cardCount,
badgeLevel:level,
started:level>0||ownedUnique>0
}
);
}

return hints;
}

function mergeBadgeCollection(target,source){
for(const [appid,incoming] of source||[]){
const previous=target.get(String(appid));
target.set(String(appid),previous?{
...previous,
...incoming,
ownedUnique:Math.max(Number(previous.ownedUnique||0),Number(incoming.ownedUnique||0)),
badgeLevel:Math.max(Number(previous.badgeLevel||0),Number(incoming.badgeLevel||0)),
started:Boolean(previous.started||incoming.started)
}:incoming);
}
return target;
}

function badgeCollectionPageCount(doc){
let pages=1;
for(const link of doc.querySelectorAll('a[href*="/badges/"]')){
try{
const page=Number(new URL(link.href,location.href).searchParams.get('p')||0);
if(Number.isFinite(page))pages=Math.max(pages,page);
}catch{}
}
return Math.min(CFG.badgeCollectionMaxPages,Math.max(1,pages));
}

function installBadgeCollection(entries,meta={}){
const map=new Map(
(Array.isArray(entries)?entries:[])
.filter(entry=>entry?.appid)
.map(entry=>[String(entry.appid),entry])
);
S.badgeCollectionByApp=map;
S.badgeCollectionLoadedAt=Number(meta.ts||Date.now());
S.badgeCollectionComplete=Boolean(meta.complete);
S.badgeCollectionStatus=meta.status||'ready';
return map;
}

async function fetchBadgeCollectionFresh(){
if(!S.profile)throw new Error('Steam-Profil konnte nicht erkannt werden');
const combined=new Map();
let pageCount=1;
let pagesLoaded=0;

for(let page=1;page<=pageCount;page++){
if(S.stop)break;
const response=await steamFetch(
`${S.profile}/badges/?p=${page}&l=english&_scout_collection=${Date.now()}`,
{headers:{Accept:'text/html,application/xhtml+xml'}},
'Badge-Sammlung'
);
const doc=new DOMParser().parseFromString(await response.text(),'text/html');
mergeBadgeCollection(combined,parseBadgeCollectionDocument(doc));
if(page===1)pageCount=badgeCollectionPageCount(doc);
pagesLoaded++;
S.stats.badgeCollectionPages++;
status(`🎯 Sammlung ${pagesLoaded}/${pageCount}: begonnene Badge-Sets werden einmalig erfasst …`);
}

return{
entries:[...combined.values()],
complete:pagesLoaded>=pageCount,
pages:pagesLoaded
};
}

async function ensureBadgeCollection(force=false){
if(S.badgeCollectionPromise)return S.badgeCollectionPromise;
if(!force&&S.badgeCollectionLoadedAt&&
Date.now()-S.badgeCollectionLoadedAt<=CFG.badgeCollectionFreshMs){
return S.badgeCollectionByApp;
}

if(!force&&S.badgeCollectionStatus==='idle'){
const cached=readTimedCache(CFG.badgeCollectionCacheKey,CFG.badgeCollectionFreshMs);
if(Array.isArray(cached?.entries)){
return installBadgeCollection(cached.entries,{...cached,status:'cached'});
}
}

S.badgeCollectionStatus='loading';
S.badgeCollectionError=null;
updateMoreUi();
S.badgeCollectionPromise=(async()=>{
try{
const data=await fetchBadgeCollectionFresh();
writeTimedCache(CFG.badgeCollectionCacheKey,data);
return installBadgeCollection(data.entries,{
ts:Date.now(),
complete:data.complete,
status:data.complete?'ready':'partial'
});
}catch(error){
const stale=readTimedCache(CFG.badgeCollectionCacheKey,CFG.badgeCollectionFallbackMs);
S.badgeCollectionError=String(error?.message||error);
if(Array.isArray(stale?.entries)){
return installBadgeCollection(stale.entries,{...stale,status:'stale'});
}
S.badgeCollectionStatus='error';
S.badgeCollectionComplete=false;
console.warn('[Badge Scout] Sammlung konnte nicht vollständig geladen werden',error);
return S.badgeCollectionByApp;
}finally{
S.badgeCollectionPromise=null;
if(S.modal){clearRenderedResultCards();syncVisibleResults(true);}
}
})();
return S.badgeCollectionPromise;
}

function visibleBadgeHints(){
const hints=new Map(S.badgeCollectionByApp);
mergeBadgeCollection(hints,parseBadgeCollectionDocument(document));
return hints;
}

function badgeStateFromCollection(candidate){
const entry=S.badgeCollectionByApp.get(String(candidate?.appid||''))||null;
return{
accessible:Boolean(S.badgeCollectionLoadedAt),
summaryOnly:true,
collectionKnown:Boolean(entry),
badgeUrl:S.profile?`${S.profile}/gamecards/${candidate.appid}/`:null,
badgeLevel:Number(entry?.badgeLevel||0),
badgeMaxed:Number(entry?.badgeLevel||0)>=5,
maxLevel:5,
cards:[],
ownedUnique:Number(entry?.ownedUnique||0),
cardCount:Number(entry?.cardCount||candidate?.cardsInSet||0),
gameName:entry?.title||candidate?.title||''
};
}

function preliminaryPersonalCost(
candidate,
hints
){
if(
!Number.isFinite(
candidate.scePriceCents
)
){
return 999999;
}

const hint=
hints.get(
String(
candidate.appid
)
);

const count=
Number(
candidate.cardsInSet||
hint?.cardCount||
0
);

if(
!hint||
!count||
hint.ownedUnique===
null
){
return candidate.scePriceCents;
}

const missing=
Math.max(
0,
count-
hint.ownedUnique
);

return Math.round(
candidate.scePriceCents*
(
missing/
count
)
);
}

async function themeCandidates(
catalog,
query
){
const terms=
expandTheme(
query
);

setExpanded(
terms
);

const map=
new Map();

const catalogByApp=
new Map(
catalog.map(
candidate=>[
String(
candidate.appid
),
candidate
]
)
);

const ensureCandidate=(
appid,
fallbackTitle=''
)=>{
const key=
String(
appid||
''
);

if(
!key
){
return null;
}

if(
!map.has(
key
)
){
const base=
catalogByApp.get(
key
)||
{
appid:key,

title:
clean(
fallbackTitle
)||
`App ${key}`,

cardsInSet:0,
scePriceText:null,
scePriceCents:null
};

map.set(
key,
{
...base,
themeScore:0,
matchedVia:[],
badgeMatches:[],
badgeSeedLevels:[]
}
);
}

const entry=
map.get(
key
);

if(
fallbackTitle&&
(
!entry.title||
/^App\s+\d+$/i
.test(
entry.title
)
)
){
entry.title=
clean(
fallbackTitle
);
}

return entry;
};

for(const candidate of
catalog
){
const score=
textThemeScore(
candidate.title,
terms
);

if(
score<=0
){
continue;
}

const entry=
ensureCandidate(
candidate.appid,
candidate.title
);

entry.themeScore+=
score;

entry.matchedVia=
[
...new Set([
...entry.matchedVia,
'game-title'
])
];
}

const marketTerms=
terms.slice(
0,
CFG.themeMarketTerms
);

for(
let index=0;
index<
marketTerms.length;
index++
){
const term=
marketTerms[index];

status(
`🔎 Steam-Kartensuche „${term}“ (${index + 1}/${marketTerms.length}) …`
);

try{
const data=
await marketSearch({
query:
term,

start:
0
});

for(const row of
data.rows
){
const entry=
ensureCandidate(
row.appid,
row.gameName
);

if(
!entry
){
continue;
}

entry.themeScore+=
8+
textThemeScore(
`${row.itemName} ${nameFromHash(row.marketHashName,row.appid)}`,
terms
);

entry.matchedVia=
[
...new Set([
...entry.matchedVia,
'card-name'
])
];
}

}catch(error){
console.warn(
'[Badge Scout] Theme market search failed',
term,
error
);
}
}

try{
status(
`🎖 Durchsuche alle Badge-Level 1–5 nach „${query}“ …`
);

const badgeDb=
await loadBadgeNameDb();

let badgeGamesFound=
0;

for(const game of
badgeDb
){
const matches=
badgeLevelMatches(
game.levels,
terms
);

if(
!matches.length
){
continue;
}

badgeGamesFound++;

const entry=
ensureCandidate(
game.appid,
game.title
);

if(
!entry
){
continue;
}

entry.themeScore+=
badgeMatchScore(
matches
);

entry.matchedVia=
[
...new Set([
...entry.matchedVia,
'badge-level-name'
])
];

entry.badgeMatches=
mergeBadgeMatches(
entry.badgeMatches,
matches
);

entry.badgeSeedLevels=
game.levels;
}

status(
`🎖 ${badgeGamesFound} Spiel(e) mit passendem Badge-Level-Namen gefunden. Die besten Kandidaten werden jetzt vollständig geprüft …`
);

}catch(error){
console.warn(
'[Badge Scout] Global badge-name search failed',
error
);

status(
'⚠ Globale Badge-Level-Namensuche gerade nicht erreichbar. Spiel- und Kartensuche laufen trotzdem weiter.'
);
}

return[
...map.values()
]
.sort(
(a,b)=>
b.themeScore-
a.themeScore
);
}

async function enrich(
candidate,
index,
total,
mode,
terms=[],
preloadedBadge=null,
preloadedFoilBadge=null
){
if(
!S.fastDiscoveryMode||
index<CFG.fastScanInitialUiEvery||
(index+1)%CFG.fastScanYieldEvery===0||
index+1===total
){
status(
`🎯 ${index + 1}/${total}: ${candidate.title || candidate.appid} wird geprüft …`
);
}

const badgePromise=
preloadedBadge
?Promise.resolve(
preloadedBadge
)
:mode==='cheap'&&S.fastDiscoveryMode
?Promise.resolve(badgeStateFromCollection(candidate))
:getBadgeState(
candidate.appid,
candidate.title
);

const fastVisual=
mode===
'foil'
?null
:fastBadgeVisualData(
candidate
)||(
S.fastDiscoveryMode
?{
url:`${CFG.sceGameBase}${encodeURIComponent(candidate.appid)}=`,
levels:candidate.badgeSeedLevels||[],
foilBadge:null,
cardCount:Number(candidate.cardsInSet||0),
fastVisualOnly:true
}
:null
);

const scxPromise=
fastVisual
?Promise.resolve(
fastVisual
)
:getScx(
candidate.appid
);

const popularityPromise=
CFG
.loadPopularityInFastScan
?getPopularity(
candidate.appid
)
:Promise.resolve(
null
);

const foilBadgeStatePromise=
mode===
'foil'
?(
preloadedFoilBadge
?Promise.resolve(
preloadedFoilBadge
)
:getFoilBadgeState(
candidate.appid,
candidate.title
)
)
:Promise.resolve(
null
);

let marketRows=[];

try{
marketRows=
await marketRowsForGame(
candidate.appid,
0
);

}catch(error){
console.warn(
'[Badge Scout] Game market failed',
candidate.appid,
error
);
}

const[
badge,
scx,
popularity,
foilBadgeState
]=
await Promise.all([
badgePromise,
scxPromise,
popularityPromise,
foilBadgeStatePromise
]);

let foilMarketRows=[];
let foilMarketError=null;

const shouldLoadFoilMarket=
mode===
'foil'||
CFG
.loadFoilMarketInNormalMode;

if(
scx.foilBadge&&
shouldLoadFoilMarket
){
try{
foilMarketRows=
await marketRowsForGame(
candidate.appid,
1
);

}catch(error){
foilMarketError=
String(
error?.message||
error
);

console.warn(
'[Badge Scout] Foil market failed',
candidate.appid,
error
);
}
}

const cost=
costState(
candidate,
badge,
marketRows,
scx
);

const normalSupply=
normalSupplyState(
cost,
marketRows
);

let marketQuality=
marketQualityState(
cost,
normalSupply
);

if(
S.fastDiscoveryMode&&
['stale','partial'].includes(S.globalMarketSnapshot?.status)
){
marketQuality={
...marketQuality,
key:'unknown',
score:0,
label:'⚪ MARKT NOCH ZU BESTÄTIGEN',
className:'marketUnknown',
reason:'Der Schnellmarkt nutzt wegen Steam-Drosselung einen alten oder nur teilweise frischen Snapshot. Erst die spielbezogene Exaktprüfung darf diesen Kandidaten grün einstufen.'
};
}

const foilCost=
foilCostState(
candidate,
badge,
foilMarketRows,
scx
);

foilCost.marketError=
foilMarketError;

foilCost.fastSkipped=
Boolean(
scx.fastVisualOnly||
(
scx.foilBadge&&
!shouldLoadFoilMarket
)
);

const liveBadgeLevels=
(
scx.levels||
[]
)
.length
?scx.levels
:(
candidate.badgeSeedLevels||
[]
);

const badgeNames=
liveBadgeLevels
.map(
item=>
item.name
)
.join(
' '
);

const liveBadgeMatches=
mode===
'theme'
?badgeLevelMatches(
liveBadgeLevels,
terms
)
:[];

const combinedBadgeMatches=
mergeBadgeMatches(
candidate.badgeMatches||
[],
liveBadgeMatches
);

const visualNameScore=
mode===
'theme'
?textThemeScore(
`${candidate.title} ${badgeNames}`,
terms
)
:0;

const liveBadgeBonus=
mode===
'theme'&&
!(
candidate.matchedVia||
[]
)
.includes(
'badge-level-name'
)
?badgeMatchScore(
liveBadgeMatches
)
:0;

const reviewScore=
popularity
?.totalReviews
?Math.log10(
popularity.totalReviews+
1
)
:0;

const costScore=
mode===
'foil'
?(
Number.isFinite(
foilCost.exactTotalCents
)
?foilCost.exactTotalCents
:500
)
:(
Number.isFinite(
cost.exactTotalCents
)
?cost.exactTotalCents
:Number.isFinite(
cost.roughPersonalCents
)
?cost.roughPersonalCents+
15
:500
);

return{
...candidate,
badge,
scx,
popularity,
foilBadgeState,
cost,
normalSupply,
marketQuality,
normalMarketRows:marketRows,
marketDataSource:S.fastDiscoveryMode
?`global-${S.globalMarketSnapshot?.status||'snapshot'}`
:'exact-game',
foilCost,

sharedIntel:
sharedIntelContext(
candidate.appid
),

matchedVia:[
...new Set([
...(candidate.matchedVia||[]),

...(
liveBadgeMatches.length
?[
'badge-level-name'
]
:[]
)
])
],

badgeMatches:
combinedBadgeMatches,

favorite:
isFav(
candidate.appid
),

themeScore:
round2(
(
candidate.themeScore||
0
)+
visualNameScore+
liveBadgeBonus
),

score:
round2(
100-
costScore+
reviewScore*
2+
(
isFav(
candidate.appid
)
?10
:0
)+
(
mode===
'theme'
?visualNameScore*
2
:0
)
)
};
}

function verdict(
result
){
if(
result.badge.badgeMaxed
){
return[
'red',
'🔴 Normales Badge bereits maximal'
];
}

const supply=
result.normalSupply||
{};

const veryScarce=
Number(
supply.veryScarceCardCount||
0
);

const scarce=
Number(
supply.scarceCardCount||
0
);

const minListings=
Number.isFinite(
supply.minSellListings
)
?supply.minSellListings
:null;

const supplySuffix=
minListings===
null
?''
:` · knappste Karte: ${minListings} Angebot${minListings === 1 ? '' : 'e'}`;

if(
Number.isFinite(
result.cost.exactTotalCents
)
){
const cents=
result.cost.exactTotalCents;

if(result.cost.personalPriceNeedsAnalyzer){
return[
'yellow',
`🟡 Begonnenes Set · Live-Gesamtset ca. ${euro(cents)}; persönlichen Restpreis per Vollanalyse bestimmen${supplySuffix}`
];
}

if(
veryScarce>0
){
return[
'red',
`🔴 Preis ${euro(cents)}, aber mindestens eine Karte hat extrem dünnes Sell-Angebot${supplySuffix}`
];
}

if(
scarce>0&&
cents<=60
){
return[
'yellow',
`🟡 Preis günstig, Sell-Angebot aber dünn${supplySuffix}`
];
}

if(
cents<=30
){
return[
'green',
`🟢 Sehr billig · aktuell ca. ${euro(cents)} bis zum nächsten Craft${supplySuffix}`
];
}

if(
cents<=60
){
return[
'green',
`🟢 Gutes Preisniveau · aktuell ca. ${euro(cents)}${supplySuffix}`
];
}

if(
cents<=100
){
return[
'yellow',
`🟡 Für Billig-Leveln eher teuer · aktuell ca. ${euro(cents)}${supplySuffix}`
];
}

return[
'red',
`🔴 Teuer · aktuell ca. ${euro(cents)}${supplySuffix}`
];
}

if(
Number.isFinite(
result.cost.roughPersonalCents
)
){
return[
'yellow',
`🟡 Katalog-Kandidat · grober externer Set-Richtwert ${result.cost.sceFullSetText || '—'} · aktueller Steam-Preis noch offen`
];
}

return[
'red',
'🔴 Preis nicht sauber bestimmbar · nur als Optik-Kandidat ansehen'
];
}

function foilVerdict(
result
){
const ownFoilState=
result
?.foilBadgeState||
null;

if(
ownFoilState
?.accessible&&
ownFoilState
?.badgeMaxed
){
return[
'red',
'🔴 Glanzabzeichen bereits gefertigt – kein neues Foil-Kaufziel'
];
}

if(
S.mode===
'foil'&&
ownFoilState&&
!ownFoilState.accessible
){
return[
'red',
`🔴 Eigener Glanz-Status konnte nicht sicher geprüft werden: ${ownFoilState.reason || 'unbekannt'}`
];
}

const cost=
result
?.foilCost||
null;

if(
cost?.fastSkipped
){
return[
'yellow',
result?.scx?.foilBadge?'⚪ Foil-Optik lazy geladen; Foil-Marktpreise im schnellen Normal-Scout bewusst nicht geladen – separate Glanz-Suche nutzen':'⚪ Foil-Optik wird beim Sichtbarwerden lazy geladen; Foil-Marktpreise bleiben in der separaten Glanz-Suche'
];
}

const foil=
result
?.scx
?.foilBadge||
null;

if(
!foil
){
return[
'red',
'🔴 Glanzabzeichen nicht sauber geladen'
];
}

if(
!cost||
!cost.expectedCardCount
){
return[
'red',
'🔴 Glanz-Preis/Angebot nicht bestimmbar'
];
}

if(
!cost.exactComplete
){
return[
'red',
`🔴 Glanz-Markt unvollständig · ${cost.knownCardCount || 0}/${cost.expectedCardCount} Karten mit aktuellem Preis`
];
}

const cents=
cost.exactTotalCents;

const minListings=
Number.isFinite(
cost.minSellListings
)
?cost.minSellListings
:null;

const supplyText=
minListings===
null
?''
:(
` · knappste Karte: ${minListings} Angebot`+
`${minListings === 1 ? '' : 'e'}`
);

if(
cost.veryScarceCardCount>
0
){
return[
'red',
`🔴 Glanz-Preis ${euro(cents)}, aber Angebot sehr knapp${supplyText}`
];
}

if(
cents<=30
){
return[
'green',
`🟢 Glanz sehr billig · kompletter Sofortkauf ca. ${euro(cents)}${supplyText}`
];
}

if(
cents<=60
){
return[
'green',
`🟢 Glanz gutes Preisniveau · kompletter Sofortkauf ca. ${euro(cents)}${supplyText}`
];
}

if(
cents<=100
){
return[
'red',
`🔴 Glanz für Billig-Leveln eher teuer · ca. ${euro(cents)}${supplyText}`
];
}

return[
'red',
`🔴 Glanz-Set teuer · ca. ${euro(cents)}${supplyText}`
];
}

function primaryVerdict(
result
){
return S.mode===
'foil'
?foilVerdict(
result
)
:verdict(
result
);
}

function popularityText(
popularity
){
if(
!popularity
?.totalReviews
){
return(
'Spiel-Popularität: keine Daten'
);
}

return(
`🔥 ${popularity.totalReviews.toLocaleString('de-DE')} Steam-Reviews`+
` · `+
(
Number.isFinite(
popularity.positivePct
)
?`${popularity.positivePct.toFixed(0)} % positiv`
:'Quote unbekannt'
)
);
}

function levelsHtml(
result
){
const byLevel=
new Map(
(
result.scx.levels||
[]
)
.map(
item=>[
item.level,
item
]
)
);

const next=
result.badge.badgeLevel<
result.badge.maxLevel
?result.badge.badgeLevel+
1
:null;

return[
1,
2,
3,
4,
5
]
.map(
levelNumber=>{
const level=
byLevel.get(
levelNumber
);

const target=
next===
levelNumber
?' target'
:'';

if(
!level
){
return`
<div class="level${target}">
<div class="placeholder">?</div>
<b>Level ${levelNumber}</b>
<span>nicht geladen</span>
</div>`;
}

return`
<div class="level${target}">
${
level.image
?`<img loading="lazy" decoding="async" src="${esc(level.image)}" alt="${esc(level.name)}">`
:'<div class="placeholder">?</div>'
}
<b>Level ${levelNumber}</b>
<span>${esc(level.name)}</span>
</div>`;
}
)
.join(
''
);
}

function foilBadgeHtml(
result
){
const foil=
result.scx.foilBadge||
null;

const[
foilVerdictClass,
foilVerdictText
]=
foilVerdict(
result
);

const foilCost=
result.foilCost||
null;

const foilMarketMeta=
foilCost
?.fastSkipped
?'Foil-Livepreis im Schnellmodus nicht geladen – separate Glanz-Suche nutzen'
:foilCost
?.exactComplete
?(
`Foil-Markt: ${foilCost.expectedCardCount} Karten · `+
`Ø ${foilCost.avgSellListings ?? '—'} Verkaufsangebote je Karte · `+
`gesamt ${foilCost.totalSellListings ?? 0} Angebote`
)
:(
foilCost
?.expectedCardCount
?`Foil-Markt: ${foilCost.knownCardCount || 0}/${foilCost.expectedCardCount} Karten mit aktuellem Preis`
:'Foil-Markt: keine vollständigen Preisdaten'
);

if(
!foil
){
return`
<div class="foil-section">
<div class="foil-title">✨ Glanzabzeichen</div>
<div class="${foilVerdictClass} foil-verdict">${esc(foilVerdictText)}</div>
<div class="foil-market-meta">${esc(foilMarketMeta)}</div>
<div class="foil-badge missing">
<div class="placeholder">?</div>
<div>
<b>Glanzabzeichen</b>
<span>${result?.scx?.fastVisualOnly ? 'Optik lädt lazy beim Sichtbarwerden' : 'nicht geladen'}</span>
</div>
</div>
</div>`;
}

return`
<div class="foil-section">
<div class="foil-title">✨ Glanzabzeichen</div>
<div class="${foilVerdictClass} foil-verdict">${esc(foilVerdictText)}</div>
<div class="foil-market-meta">${esc(foilMarketMeta)}</div>
<div class="foil-badge">
${
foil.image
?`<img loading="lazy" decoding="async" src="${esc(foil.image)}" alt="${esc(foil.name)}">`
:'<div class="placeholder">?</div>'
}
<div>
<b>${esc(foil.name)}</b>
<span>Foil-Badge · Level 1</span>
</div>
</div>
</div>`;
}

function matchedViaText(
result
){
const via=
new Set(
result.matchedVia||
[]
);

const labels=[];

if(
via.has(
'game-title'
)
){
labels.push(
'🎮 Spielname'
);
}

if(
via.has(
'card-name'
)
){
labels.push(
'🃏 Kartenname'
);
}

if(
via.has(
'badge-level-name'
)
){
labels.push(
'🎖 Badge-Level-Name'
);
}

return labels.join(
' · '
);
}

function badgeMatchesText(
result
){
return(
result.badgeMatches||
[]
)
.slice(
0,
8
)
.map(
match=>
`L${match.level || '?'} „${match.name}“`
)
.join(
' · '
);
}

function resultCostCents(
result
){
if(
S.mode===
'foil'
){
return Number.isFinite(
result?.foilCost
?.exactTotalCents
)
?result.foilCost
.exactTotalCents
:null;
}

if(
Number.isFinite(
result?.cost
?.exactTotalCents
)
){
return result.cost
.exactTotalCents;
}

if(
Number.isFinite(
result?.cost
?.roughPersonalCents
)
){
return result.cost
.roughPersonalCents;
}

if(
Number.isFinite(
result?.cost
?.sceFullSetCents
)
){
return result.cost
.sceFullSetCents;
}

return null;
}

function resultCardCount(result){
return Math.max(
0,
Number(
result?.cost?.expectedCardCount||
result?.foilCost?.expectedCardCount||
result?.cardsInSet||
0
)
);
}

function efficiencyScore(result){
const cost=resultCostCents(result);
if(!Number.isFinite(cost))return 999999;
return cost+resultCardCount(result)*CFG.efficiencyCardPenaltyCents;
}

function filterState(){
const modal=
S.modal;

if(
!modal
){
return{
text:'',
maxCost:null,
onlyGreen:false,
onlyBadgeHit:false,
onlyFoil:false,
onlyFoilGreen:false,
onlyFav:false,
onlyLevel0:false,
onlyMarketSuper:false,
onlyLowBidTop:false,
hideActiveOrderSets:false,
onlyStartedSets:false,
sort:'relevance'
};
}

const maxRaw=
modal
.querySelector(
'#filterMaxCost'
)
?.value||
'';

return{
text:
clean(
modal
.querySelector(
'#filterText'
)
?.value||
''
),

maxCost:
maxRaw===
''
?null
:Number(
maxRaw
),

onlyGreen:
Boolean(
modal
.querySelector(
'#filterGreen'
)
?.checked
),

onlyBadgeHit:
Boolean(
modal
.querySelector(
'#filterBadgeHit'
)
?.checked
),

onlyFoil:
Boolean(
modal
.querySelector(
'#filterFoil'
)
?.checked
),

onlyFoilGreen:
Boolean(
modal
.querySelector(
'#filterFoilGreen'
)
?.checked
),

onlyFav:
Boolean(
modal
.querySelector(
'#filterFav'
)
?.checked
),

onlyLevel0:
Boolean(
modal
.querySelector(
'#filterLevel0'
)
?.checked
),

onlyMarketSuper:
Boolean(
modal
.querySelector(
'#filterMarketSuper'
)
?.checked
),

onlyLowBidTop:
Boolean(
modal
.querySelector(
'#filterLowBidTop'
)
?.checked
),

hideActiveOrderSets:
Boolean(
modal
.querySelector(
'#filterFreshHunt'
)
?.checked
),

onlyStartedSets:
Boolean(
modal
.querySelector(
'#filterStartedSets'
)
?.checked
),

sort:
modal
.querySelector(
'#filterSort'
)
?.value||
'relevance'
};
}

function resultFilterHaystack(
result
){
return clean(
[
result?.title||
'',

...(
result?.scx
?.levels||
[]
)
.map(
item=>
item?.name||
''
),

result?.scx
?.foilBadge
?.name||
'',

foilVerdict(
result
)
?.[1]||
'',

...(
result?.cost
?.cards||
[]
)
.map(
item=>
item?.name||
''
),

badgeMatchesText(
result
),

matchedViaText(
result
),
marketQualityText(result),
deepMarketText(result),
activeOrderCoverageText(result)
]
.join(
' '
)
);
}

function resultPassesFilters(
result,
filters=filterState()
){
if(
filters.text&&
!norm(
resultFilterHaystack(
result
)
)
.includes(
norm(
filters.text
)
)
){
return false;
}

if(
filters.maxCost!==
null
){
const cost=
resultCostCents(
result
);

if(
cost===
null||
cost>
filters.maxCost
){
return false;
}
}

if(
filters.onlyGreen&&
primaryVerdict(
result
)[0]!==
'green'
){
return false;
}

if(
filters.onlyBadgeHit&&
!(
result.badgeMatches||
[]
)
.length
){
return false;
}

if(
filters.onlyFoil&&
!result?.scx
?.foilBadge
){
return false;
}

if(
filters.onlyFoilGreen&&
foilVerdict(
result
)[0]!==
'green'
){
return false;
}

if(
filters.onlyLevel0&&
Number(
result?.badge
?.badgeLevel||
0
)!==
0
){
return false;
}

if(
filters.onlyMarketSuper&&
result?.marketQuality?.key!==
'super'
){
return false;
}

if(
filters.onlyLowBidTop&&
!['top','good','pending'].includes(
lowBidState(result).key
)
){
return false;
}

if(
filters.onlyFav&&
!isFav(
result.appid
)
){
return false;
}

if(
filters.hideActiveOrderSets&&
resultHiddenByFreshHunt(result)
){
return false;
}

if(
filters.onlyStartedSets&&
!resultHiddenByFreshHunt(result)
){
return false;
}

return true;
}

function sortFilteredResults(
results,
filters=filterState()
){
const list=[
...results
];

switch(
filters.sort
){
case'price':
list.sort(
(a,b)=>
(
resultCostCents(
a
)??
999999
)-
(
resultCostCents(
b
)??
999999
)||
(
a._scanIndex??
999999
)-
(
b._scanIndex??
999999
)
);
break;

case'efficiency':
list.sort(
(a,b)=>
efficiencyScore(a)-efficiencyScore(b)||
resultCardCount(a)-resultCardCount(b)||
(resultCostCents(a)??999999)-(resultCostCents(b)??999999)||
(a._scanIndex??999999)-(b._scanIndex??999999)
);
break;

case'supply':
list.sort(
(a,b)=>
(
b?.normalSupply
?.minSellListings??
-1
)-
(
a?.normalSupply
?.minSellListings??
-1
)||
(
a._scanIndex??
999999
)-
(
b._scanIndex??
999999
)
);
break;

case'market':
list.sort(
(a,b)=>
(
Number(b?.marketQuality?.score||0)-
Number(a?.marketQuality?.score||0)
)||
(
resultCostCents(a)??999999
)-
(
resultCostCents(b)??999999
)||
(
(b?.normalSupply?.minSellListings??-1)-
(a?.normalSupply?.minSellListings??-1)
)
);
break;

case'lowbid':
list.sort(
(a,b)=>
Number(lowBidState(b).score||0)-
Number(lowBidState(a).score||0)||
Number(b?.marketQuality?.score||0)-
Number(a?.marketQuality?.score||0)||
(resultCostCents(a)??999999)-(resultCostCents(b)??999999)
);
break;

case'popularity':
list.sort(
(a,b)=>
(
b?.popularity
?.totalReviews||
0
)-
(
a?.popularity
?.totalReviews||
0
)||
(
a._scanIndex??
999999
)-
(
b._scanIndex??
999999
)
);
break;

case'theme':
list.sort(
(a,b)=>
(
b.themeScore||
0
)-
(
a.themeScore||
0
)||
(
a._scanIndex??
999999
)-
(
b._scanIndex??
999999
)
);
break;

case'name':
list.sort(
(a,b)=>
String(
a.title||
''
)
.localeCompare(
String(
b.title||
''
),
'de'
)
);
break;

case'relevance':
default:
list.sort(
(a,b)=>
(
a._scanIndex??
999999
)-
(
b._scanIndex??
999999
)
);
break;
}

return list;
}

function createResultCard(
result
){
const[
verdictClass,
verdictText
]=
primaryVerdict(
result
);

const foilMode=
S.mode===
'foil';

const div=
document.createElement(
'div'
);

div.className=
'result';

div.dataset.appid=
String(
result.appid
);

const mainMeta=
foilMode
?(
`Glanz-Set: ${result.foilCost?.expectedCardCount || result.cardsInSet || '—'} Karten`+
` · normales Badge: ${result.badge.badgeLevel ?? 0}/${result.badge.maxLevel || 5}`+
(
result.badge.badgeMaxed
?' (normal bereits MAX – für Glanzsuche egal)'
:''
)+
(
result.foilBadgeState
?.accessible
?` · dein Glanz: ${result.foilBadgeState.badgeLevel || 0}/${result.foilBadgeState.maxLevel || 1}`
:' · dein Glanz: Status unbekannt'
)
)
:(
`Set: ${result.cost.expectedCardCount || result.cardsInSet || '—'} Karten`+
(
result.cost.personalPriceNeedsAnalyzer
?' · persönlich fehlende Karten: Vollanalyse nötig'
:` · für nächsten normalen Craft fehlen: ${result.cost.missingCount ?? '—'}`
)+
` · dein Badge-Level: ${result.badge.badgeLevel ?? 0}/${result.badge.maxLevel || 5}`
);

const priceMeta=
foilMode
?(
result.foilCost
?.exactComplete
?(
`Steam-Sofortkauf des kompletten Glanz-Sets: `+
`${result.foilCost.exactTotal}`
)
:(
`Glanz-Preis nicht vollständig · `+
`${result.foilCost?.knownCardCount || 0}/${result.foilCost?.expectedCardCount || 0} Foil-Karten mit aktuellem Preis`
)
)
:(
result.cost.exactComplete
?(
(
result.cost.personalPriceNeedsAnalyzer
?'Steam-Sofortkauf des kompletten Sets (konservativer Vergleich): '
:'Steam-Sofortkauf der fehlenden Karten: '
)+
`${result.cost.exactTotal}`
)
:(
`Aktueller Steam-Preis noch nicht vollständig · `+
`grober Katalog-Richtwert von SteamCardExchange: `+
`${result.cost.sceFullSetText || '—'} (nur Sortierhilfe, nicht live)`
)
);

const marketSourceText=
result.marketDataSource==='exact-game'
?'📊 Preisquelle: spielbezogene Steam-Marktprüfung'
:result.marketDataSource==='global-ready'
?'💶 Preisquelle: frischer gebündelter Steam-Schnellmarkt'
:result.marketDataSource==='global-cached'
?'💾 Preisquelle: höchstens 20 Minuten alter Steam-Schnellmarkt-Cache'
:String(result.marketDataSource||'').includes('stale')||String(result.marketDataSource||'').includes('partial')
?'⚠ Preisquelle: alter/teilweiser Schnellmarkt – grün erst nach Exaktprüfung'
:'📊 Preisquelle: Steam-Markt';

div.innerHTML=`
<div class="head">
<div>
<small class="result-rank">#?</small>
<h3>${esc(result.title)}</h3>
<div class="${verdictClass}">${esc(verdictText)}</div>
</div>
<button class="fav">${result.favorite ? '★ Favorit' : '☆ Favorit'}</button>
</div>

<div class="meta">${esc(mainMeta)}${S.mode === 'theme' ? ` · Themen-Score ${result.themeScore || 0}` : ''}</div>

${
S.mode==='theme'&&matchedViaText(result)
?`<div class="meta">Gefunden über: ${esc(matchedViaText(result))}</div>`
:''
}

${
S.mode==='theme'&&result.badgeMatches?.length
?`<div class="meta badge-hit">🎖 Badge-Treffer: ${esc(badgeMatchesText(result))}</div>`
:''
}

<div class="meta">
${esc(popularityText(result.popularity))}
<span class="proxy">(Spiel-Popularität, kein Badge-Like-Wert)</span>
</div>

<div class="meta">${priceMeta}</div>

${!foilMode?`<div class="meta">${esc(marketSourceText)}</div>`:''}

${
!foilMode&&result.normalSupply?.cardsWithSupply
?`<div class="meta">Sell-Angebot (Scout-Snapshot): ${esc(String(result.normalSupply.cardsWithSupply))} Karten erkannt · Ø ${esc(String(result.normalSupply.avgSellListings ?? '—'))} Angebote · Minimum ${esc(String(result.normalSupply.minSellListings ?? '—'))}</div>`
:''
}

${
!foilMode&&result.marketQuality
?`<div class="meta market-signal ${esc(result.marketQuality.className)}"><b>${esc(result.marketQuality.label)}</b> · ${esc(result.marketQuality.reason)}</div>`
:''
}

${
!foilMode&&deepMarketText(result)
?`<div class="meta market-signal ${esc(lowBidState(result).className)}"><b>${esc(deepMarketText(result))}</b></div>`
:''
}

${
activeOrderCoverageText(result)
?`<div class="meta order-coverage order-covered"><b>${esc(activeOrderCoverageText(result))}</b></div>`
:''
}

${
result.sharedIntel?.decision
?`<div class="meta intel">🧠 Frische Set-Entscheidung: ${esc(result.sharedIntel.decision.action || '—')}${result.sharedIntel.decision.reason ? ` · ${esc(result.sharedIntel.decision.reason)}` : ''}</div>`
:''
}

${
foilMode&&result.badge.badgeMaxed
?`
<div class="meta badge-hit">
✨ Das normale Level-5-Badge wird hier NICHT als kostenloser Treffer gewertet.
Dieser Treffer existiert ausschließlich wegen des separaten Glanz-Sets.
</div>`
:''
}

<div class="levels">
${levelsHtml(result)}
</div>

${foilBadgeHtml(result)}

<div class="actions">
<button class="openBadge">🏅 Badge öffnen + Vollanalyse</button>
<button class="openScx">👀 Alle Badge-Level extern</button>
</div>
`;

const favButton=
div.querySelector(
'.fav'
);

favButton.onclick=
()=>{
toggleFav(
result.appid
);

result.favorite=
isFav(
result.appid
);

favButton.textContent=
result.favorite
?'★ Favorit'
:'☆ Favorit';

syncVisibleResults(
true
);
};

div.querySelector(
'.openBadge'
)
.onclick=
()=>{
if(
!S.profile
){
alert(
'Steam-Profil konnte nicht erkannt werden.'
);

return;
}

window.open(
`${S.profile}/gamecards/${result.appid}/`,
'_blank',
'noopener'
);
};

div.querySelector(
'.openScx'
)
.onclick=
()=>{
window.open(
result.scx.url,
'_blank',
'noopener'
);
};

observeFoilVisual(result,div);

return div;
}

function refreshResultCard(result){
if(!S.modal)return;
const key=String(result.appid);
const old=S.cardNodes.get(key);
if(!old||!old.isConnected)return;
const node=createResultCard(result);
const rank=old.querySelector('.result-rank')?.textContent||'#?';
const newRank=node.querySelector('.result-rank');
if(newRank)newRank.textContent=rank;
old.replaceWith(node);
S.cardNodes.set(key,node);
const filters=filterState();
if(['market','lowbid','efficiency'].includes(filters.sort)||filters.onlyMarketSuper||filters.onlyLowBidTop||filters.onlyStartedSets)syncVisibleResults(true);
}

function needsFullBadgeVisual(result){
if(!result?.scx?.fastVisualOnly)return false;
const levelCount=Array.isArray(result.scx.levels)?result.scx.levels.length:0;
return levelCount<5||!result.scx.foilBadge;
}

function mergeLazyVisualData(result,full){
const old=result?.scx||{};
const freshLevels=Array.isArray(full?.levels)&&full.levels.length
?full.levels
:Array.isArray(old.levels)
?old.levels
:[];
return{
...old,
url:full?.url||old.url,
levels:freshLevels,
foilBadge:full?.foilBadge||old.foilBadge||null,
cardCount:Number(full?.cardCount||old.cardCount||result?.cardsInSet||0),
fastVisualOnly:false,
fullVisualLazyLoaded:true
};
}

function ensureFoilObserver(){
if(!CFG.foilVisualLazy||S.foilObserver||!('IntersectionObserver'in window)||!S.modal)return;
const root=S.modal.querySelector('.scoutModal');
S.foilObserver=new IntersectionObserver(entries=>{
for(const entry of entries){
if(!entry.isIntersecting)continue;
S.foilObserver.unobserve(entry.target);
const result=S.results.find(item=>String(item.appid)===String(entry.target.dataset.appid));
if(result)queueFoilVisual(result);
}
},{root,rootMargin:`${CFG.foilVisualRootMarginPx}px 0px`,threshold:0.01});
}

function observeFoilVisual(result,node){
if(!CFG.foilVisualLazy||S.mode==='foil'||!needsFullBadgeVisual(result))return;
ensureFoilObserver();
S.foilObserver?.observe(node);
}

function queueFoilVisual(result){
if(!CFG.foilVisualLazy||S.mode==='foil'||!needsFullBadgeVisual(result))return;
const key=String(result.appid);
if(S.foilVisualQueued.has(key))return;
S.foilVisualQueued.add(key);
S.foilVisualQueue.push(result);
void processFoilVisualQueue();
}

async function processFoilVisualQueue(){
if(S.foilVisualBusy)return;
S.foilVisualBusy=true;
try{
while(S.foilVisualQueue.length){
const result=S.foilVisualQueue.shift();
const key=String(result.appid);
try{
await sleep(CFG.foilVisualGapMs);
const full=await getScx(result.appid);
if(full&&(full.foilBadge||(Array.isArray(full.levels)&&full.levels.length))){
result.scx=mergeLazyVisualData(result,full);
S.stats.foilVisuals++;
refreshResultCard(result);
}
}catch(error){console.warn('[Badge Scout] Lazy Foil-Optik fehlgeschlagen',result.appid,error);}
finally{S.foilVisualQueued.delete(key);}
}
}finally{S.foilVisualBusy=false;}
}

function visibleResults(){
const filters=
filterState();

return sortFilteredResults(
S.results.filter(
result=>
resultPassesFilters(
result,
filters
)
),
filters
);
}

function paginateResults(results,page=0,pageSize=CFG.resultPageSize){
const size=Math.max(1,Number(pageSize)||CFG.resultPageSize);
const total=Array.isArray(results)?results.length:0;
const totalPages=Math.max(1,Math.ceil(total/size));
const safePage=Math.min(Math.max(0,Number(page)||0),totalPages-1);
const start=safePage*size;
return{
items:(results||[]).slice(start,start+size),
page:safePage,
pageSize:size,
start,
total,
totalPages
};
}

function syncVisibleResults(
preserveScroll=true
){
if(S.uiSyncTimer){
clearTimeout(S.uiSyncTimer);
S.uiSyncTimer=null;
}
if(
!S.modal
){
return;
}

const box=
S.modal
.querySelector(
'#scout-results'
);

if(
!box
){
return;
}

const modal=
S.modal
.querySelector(
'.scoutModal'
);

const oldScroll=
preserveScroll
?modal?.scrollTop||
0
:0;

const allResults=
visibleResults();

const pageData=
paginateResults(
allResults,
S.resultPage,
S.resultPageSize
);

S.resultPage=
pageData.page;

const results=
pageData.items;

const pageKeys=
new Set(
results.map(result=>String(result.appid))
);

if(S.foilVisualQueue.length){
const keep=[];
for(const queuedResult of S.foilVisualQueue){
const queuedKey=String(queuedResult.appid);
if(pageKeys.has(queuedKey))keep.push(queuedResult);
else S.foilVisualQueued.delete(queuedKey);
}
S.foilVisualQueue=keep;
}

for(const[key,node]of S.cardNodes){
if(pageKeys.has(key))continue;
S.foilObserver?.unobserve(node);
S.cardNodes.delete(key);
}

const fragment=
document.createDocumentFragment();

results.forEach(
(
result,
index
)=>{
const key=
String(
result.appid
);

let node=
S.cardNodes.get(
key
);

if(
!node
){
node=
createResultCard(
result
);

S.cardNodes.set(
key,
node
);
}

const rank=
node
.querySelector(
'.result-rank'
);

if(
rank
){
rank.textContent=
`#${pageData.start + index + 1}`;
}

fragment.appendChild(
node
);
}
);

box.replaceChildren(
fragment
);

if(
!results.length
){
const empty=
document.createElement(
'div'
);

empty.className=
'empty';

empty.textContent=
S.results.length
?(
filterState().onlyLowBidTop
?'Noch kein geprüfter/vorgemerkter Low-Bid-Top-Treffer. Nutze „Nächste 20 live prüfen“ und danach „Top 5 Low-Bid prüfen“.'
:filterState().onlyMarketSuper||filterState().onlyGreen
?'Noch kein durch vollständige Steam-Livedaten bestätigter Treffer für diesen strengen Filter. Externe Katalog-Richtwerte werden absichtlich nicht grün gefärbt; „Nächste 20 live prüfen“ kann weitere Kandidaten bestätigen.'
:filterState().onlyStartedSets
?'Unter den geladenen Kandidaten wurde noch keine begonnene Sammlung erkannt. Sammlung/Kaufaufträge aktualisieren oder den Billigscan vollständig laden.'
:'Keine der bereits geprüften Ergebnisse passen zu den aktuellen Filtern.'
)
:'Noch keine Kandidaten geprüft.';

box.appendChild(
empty
);
}

if(
preserveScroll&&
modal
){
modal.scrollTop=
Math.min(
oldScroll,
Math.max(
0,
modal.scrollHeight-
modal.clientHeight
)
);
}else if(modal){
modal.scrollTop=Math.max(0,Number(box.offsetTop||0)-10);
}

updateMoreUi();
}

function scheduleVisibleSync(){
if(S.uiSyncTimer)return;
S.uiSyncTimer=setTimeout(()=>{
S.uiSyncTimer=null;
syncVisibleResults(true);
},80);
}

function clearRenderedResultCards(){
for(const node of S.cardNodes.values())S.foilObserver?.unobserve(node);
S.cardNodes=new Map();
for(const queuedResult of S.foilVisualQueue)S.foilVisualQueued.delete(String(queuedResult.appid));
S.foilVisualQueue=[];
}

function syncFiltersFromFirstPage(){
S.resultPage=0;
clearRenderedResultCards();
syncVisibleResults(false);
}

function moveResultPage(delta){
const count=visibleResults().length;
const pages=Math.max(1,Math.ceil(count/S.resultPageSize));
const next=Math.min(pages-1,Math.max(0,S.resultPage+Number(delta||0)));
if(next===S.resultPage)return;
S.resultPage=next;
clearRenderedResultCards();
syncVisibleResults(false);
}

function appendResultFast(
result
){
if(S.fastDiscoveryMode){
scheduleVisibleSync();
return;
}

const filters=
filterState();

if(
filters.sort!==
'relevance'||
filters.text||
filters.maxCost!==
null||
filters.onlyGreen||
filters.onlyBadgeHit||
filters.onlyFoil||
filters.onlyFoilGreen||
filters.onlyFav||
filters.onlyLevel0||
filters.onlyMarketSuper||
filters.onlyLowBidTop||
filters.hideActiveOrderSets||
filters.onlyStartedSets
){
scheduleVisibleSync();

return;
}

const box=
S.modal
?.querySelector(
'#scout-results'
);

if(
!box
){
return;
}

if(
box.children.length===
1&&
box.firstElementChild
?.classList
.contains(
'empty'
)
){
box.innerHTML=
'';
}

const key=
String(
result.appid
);

let node=
S.cardNodes.get(
key
);

if(
!node
){
node=
createResultCard(
result
);

S.cardNodes.set(
key,
node
);
}

const rank=
node
.querySelector(
'.result-rank'
);

if(
rank
){
rank.textContent=
`#${S.results.length}`;
}

box.appendChild(
node
);

if(S.results.length%10===0||S.nextCandidateIndex>=S.candidates.length-1){
updateMoreUi();
}
}

function status(
text
){
const element=
S.modal
?.querySelector(
'#status'
);

if(
element
){
element.textContent=
text;
}
}

function setExpanded(
terms
){
const element=
S.modal
?.querySelector(
'#expanded'
);

if(
!element
){
return;
}

element.textContent=
terms.length>
1
?(
`Erweiterte Suche: `+
`${terms.join(' · ')}`
)
:(
`Suche: `+
`${terms.join(' · ')}`
);
}

function beginRun(
clearResults=false
){
S.stop=
false;

if(clearResults)S.pauseRequested=false;

if(
clearResults&&
S.modal
){
S.modal
.querySelector(
'#scout-results'
)
.innerHTML=
'<div class="empty">Suche läuft … Treffer erscheinen fortlaufend.</div>';
}

const stop=
S.modal
?.querySelector(
'#stop'
);

if(
stop
){
stop.style.display=
'';

stop.disabled=
false;

stop.textContent=
'⏸ Scan pausieren';
}
}

function endRun(){
if(
S.running||
S.scanBusy
){
return;
}

const stop=
S.modal
?.querySelector(
'#stop'
);

if(
stop
){
stop.style.display=
'none';
}
}

function resetResultSession(
mode,
candidates,
terms=[],
query=''
){
S.mode=
mode;

S.fastDiscoveryMode=mode==='cheap';

S.candidates=[
...candidates
];

S.nextCandidateIndex=
0;

S.results=
[];

S.terms=[
...terms
];

S.query=
query;

clearRenderedResultCards();

S.resultPage=0;

if(S.uiSyncTimer){clearTimeout(S.uiSyncTimer);S.uiSyncTimer=null;}

S.marketRowsCache=
new Map();

S.steamQueue=
Promise.resolve();

S.badgeCache=
new Map();

S.foilBadgeCache=
new Map();

S.deepCheckQueue=[];
S.deepCheckQueued=new Set();
S.deepChecked=new Set();
S.deepCheckBusy=false;
S.deepCheckCompleted=0;
S.marketValidatedApps=new Set();
S.stats.marketValidations=0;
S.stats.foilVisuals=0;
S.paused=false;
S.scanStartedAt=null;
S.scanStartIndex=0;
S.foilVisualQueue=[];
S.foilVisualQueued=new Set();
S.foilVisualBusy=false;
if(S.foilObserver){S.foilObserver.disconnect();S.foilObserver=null;}

const box=
S.modal
?.querySelector(
'#scout-results'
);

if(
box
){
box.innerHTML=
'<div class="empty">Treffer gefunden. Die ersten Kandidaten werden jetzt geprüft …</div>';
}

updateMoreUi();
}

function updateMoreUi(){
if(!S.modal)return;
const progress=S.modal.querySelector('#resultProgress');
const resume=S.modal.querySelector('#resumeScan');
const pageStatus=S.modal.querySelector('#resultPageStatus');
const previousPage=S.modal.querySelector('#previousPage');
const nextPage=S.modal.querySelector('#nextPage');
const deepStatus=S.modal.querySelector('#deepStatus');
const freshStatus=S.modal.querySelector('#freshHuntStatus');
const currentFilters=filterState();
const visibleCount=S.results.reduce((count,result)=>count+(resultPassesFilters(result,currentFilters)?1:0),0);
const filtersWithoutFreshHunt={...currentFilters,hideActiveOrderSets:false};
const freshStartedLoadedCount=S.results.reduce(
(count,result)=>count+(resultHiddenByFreshHunt(result)?1:0),
0
);
const freshHiddenCount=currentFilters.hideActiveOrderSets
?S.results.reduce(
(count,result)=>count+(
resultPassesFilters(result,filtersWithoutFreshHunt)&&
resultHiddenByFreshHunt(result)
?1
:0
),
0
)
:0;
const total=S.candidates.length;
const checked=S.nextCandidateIndex;
const remaining=Math.max(0,total-checked);
const pageCount=visibleCount?Math.ceil(visibleCount/S.resultPageSize):0;
S.resultPage=pageCount?Math.min(S.resultPage,pageCount-1):0;
let rate=null,eta=null;
if(S.scanStartedAt&&checked>S.scanStartIndex){
const minutes=(Date.now()-S.scanStartedAt)/60000;
if(minutes>0){rate=(checked-S.scanStartIndex)/minutes;if(rate>0)eta=remaining/rate;}
}
if(progress){
progress.textContent=`${checked}/${total} geprüft · ${S.results.length} geladen · ${visibleCount} sichtbar${Number.isFinite(rate)?` · ${rate.toFixed(1).replace('.',',')}/Min`:''}${Number.isFinite(eta)&&remaining>0?` · Rest ~${formatDuration(eta)}`:''}`;
}
if(pageStatus){
pageStatus.textContent=visibleCount
?`Seite ${S.resultPage+1}/${pageCount} · ${S.resultPageSize} pro Seite`
:'Seite 0/0';
}
if(previousPage){
previousPage.disabled=!visibleCount||S.resultPage<=0;
}
if(nextPage){
nextPage.disabled=!visibleCount||S.resultPage>=pageCount-1;
}
if(resume){
const show=S.paused&&remaining>0&&!S.running&&!S.scanBusy;
resume.style.display=show?'':'none';
resume.disabled=!show;
}
if(deepStatus){
const queued=S.deepCheckQueue.length;
deepStatus.textContent=CFG.deepCheckEnabled?`🔬 Low-Bid manuell: ${S.deepCheckCompleted}/${CFG.deepCheckMaxGames}${queued?` · ${queued} Topset(s) bereit`:''}`:'🔬 Deepchecks aus';
}
if(freshStatus){
const collectionCount=[...S.badgeCollectionByApp.values()].filter(entry=>entry?.started).length;
const loading=S.activeBuyOrdersStatus==='loading'||S.badgeCollectionStatus==='loading';
const unavailable=['error'].includes(S.activeBuyOrdersStatus)&&['error','idle'].includes(S.badgeCollectionStatus);
const stale=S.activeBuyOrdersStatus==='stale'||S.badgeCollectionStatus==='stale'||S.badgeCollectionStatus==='partial';
if(loading){
freshStatus.textContent='🧭 Kaufaufträge und begonnene Sammlungen werden gebündelt geladen …';
freshStatus.className='auto-more order-loading';
}else if(unavailable){
freshStatus.textContent=`⚠ Sammlungsstatus derzeit nicht live verfügbar${activeRateLimitText()?` · ${activeRateLimitText()}`:''}`;
freshStatus.className='auto-more order-error';
}else if(['ready','cached','stale'].includes(S.activeBuyOrdersStatus)||S.badgeCollectionLoadedAt){
const setCount=S.activeBuyOrdersByApp.size;
const collectionAge=S.badgeCollectionLoadedAt
?formatDuration(Math.max(0,Date.now()-S.badgeCollectionLoadedAt)/60000)
:'unbekannt';
const orderAge=S.activeBuyOrdersLoadedAt
?formatDuration(Math.max(0,Date.now()-S.activeBuyOrdersLoadedAt)/60000)
:'unbekannt';
freshStatus.textContent=
`🧭 ${collectionCount} begonnene Badge-Sets · ${S.activeBuyOrders.length} Kaufaufträge in ${setCount} Set(s) · `+
`${freshStartedLoadedCount} begonnene Sammlung(en) unter ${S.results.length} geladenen Treffern`+
(
currentFilters.hideActiveOrderSets
?` · 🆕 ${freshHiddenCount} in der aktuellen Filteransicht ausgeblendet`
 :currentFilters.onlyStartedSets
 ?' · 📌 nur begonnene Sets sichtbar'
 :' · Sammlungsfilter aus'
)+
(stale?' · Cache/Teilstand':'')+
` · Datenalter: Sammlung ${collectionAge}, Aufträge ${orderAge}`;
freshStatus.className='auto-more order-ready';
}else{
freshStatus.textContent='🧭 Sammlungsstatus noch nicht geladen';
freshStatus.className='auto-more';
}
}
}

async function scanUiCheckpoint(done,total){
if(!S.fastDiscoveryMode){
updateMoreUi();
return;
}
const interval=done<=CFG.fastScanYieldEvery
?CFG.fastScanInitialUiEvery
:CFG.fastScanYieldEvery;
if(done>=total||done%interval===0){
syncVisibleResults(true);
// Ein echter Makrotask-Yield lässt Browser, Stop-Button und Filter reagieren,
// obwohl der Vollkatalog ansonsten vollständig lokal durchgerechnet wird.
await sleep(0);
}
}

async function scanNextResults(){
if(S.scanBusy||S.running||!S.candidates.length||S.nextCandidateIndex>=S.candidates.length){updateMoreUi();return;}
if(S.pauseRequested&&!S.paused){
S.pauseRequested=false;
S.paused=true;
status(`⏸ Scan vor dem ersten Kandidaten pausiert. Mit „Scan fortsetzen“ beginnt die Auswertung der ${S.candidates.length} vorbereiteten Sets.`);
updateMoreUi();
return;
}
S.scanBusy=true;S.stop=false;S.pauseRequested=false;S.paused=false;beginRun(false);
S.scanStartedAt=Date.now();S.scanStartIndex=S.nextCandidateIndex;
const total=S.candidates.length;
let networkPaused=false;
try{
while(S.nextCandidateIndex<total&&!S.stop&&!S.pauseRequested){
const index=S.nextCandidateIndex;
const candidate=S.candidates[index];
try{
if(CFG.normalModesHideMaxed&&S.mode!=='foil'&&sharedNormalMaxed(candidate.appid)){
S.nextCandidateIndex=index+1;await scanUiCheckpoint(S.nextCandidateIndex,total);continue;
}
if(S.mode==='foil'&&CFG.hideCompletedFoil&&sharedFoilMaxed(candidate.appid)){
S.nextCandidateIndex=index+1;await scanUiCheckpoint(S.nextCandidateIndex,total);continue;
}

// 3.0.1: Im normalen Billigmodus kommen Badge-Zusammenfassung und Marktzeilen
// aus den gebündelten Indizes. Nur die Top-Kandidaten werden später einzeln
// nachvalidiert; Themen-/Glanzmodus darf weiterhin gezielt live auflösen.
const result=await enrich(candidate,index,total,S.mode,S.terms,null,null);
result._scanIndex=index;
result.favorite=isFav(result.appid);
// Katalog-Zusammenfassungen sind keine spielbezogene Live-Prüfung und dürfen
// deshalb weder 13.000 LocalStorage-Schreibvorgänge noch falsches Shared-Intel erzeugen.
if(!result?.badge?.summaryOnly)rememberBadgeState(candidate.appid,'normalBadge',result.badge);
if(S.mode==='foil'&&result.foilBadgeState)rememberBadgeState(candidate.appid,'foilBadge',result.foilBadgeState);

const hideMaxedNormal=CFG.normalModesHideMaxed&&S.mode!=='foil'&&result.badge.badgeMaxed;
const missingFoilForFoilMode=S.mode==='foil'&&!result?.scx?.foilBadge;
const foilAlreadyMaxed=S.mode==='foil'&&result?.foilBadgeState?.accessible&&result.foilBadgeState.badgeMaxed;
S.nextCandidateIndex=index+1;
if(hideMaxedNormal||missingFoilForFoilMode||foilAlreadyMaxed){await scanUiCheckpoint(S.nextCandidateIndex,total);continue;}
S.results.push(result);
queueDeepCheck(result);
if(S.fastDiscoveryMode){
await scanUiCheckpoint(S.nextCandidateIndex,total);
}else{
appendResultFast(result);
}

}catch(error){
if(S.stop)break;
if(isRateLimitError(error)){
networkPaused=true;
status(`⏸ Steam drosselt den ${error.channel||'Daten'}-Kanal. ${activeRateLimitText()}. Der Scan bleibt am aktuellen Kandidaten fortsetzbar.`);
break;
}
console.warn('[Badge Scout] Kandidat übersprungen',candidate?.appid,error);
S.nextCandidateIndex=index+1;await scanUiCheckpoint(S.nextCandidateIndex,total);
}
}

if(!S.stop&&!S.pauseRequested&&!networkPaused&&S.nextCandidateIndex>=total&&S.mode==='cheap'){
await validateTopMarketResults(CFG.autoExactValidationGames,false);
}
}finally{
S.scanBusy=false;updateMoreUi();endRun();
}

if(networkPaused){
S.paused=true;
updateMoreUi();
return;
}
if(S.pauseRequested){
S.paused=true;status(`⏸ Scan pausiert: ${S.nextCandidateIndex}/${total} Kandidaten geprüft. Alle bisherigen Treffer bleiben nutzbar; mit „Scan fortsetzen“ geht es exakt an dieser Stelle weiter.`);S.pauseRequested=false;updateMoreUi();return;
}
if(S.stop){
S.paused=true;status(`⏸ Scan pausiert: ${S.nextCandidateIndex}/${total} Kandidaten geprüft. Alle bisherigen Treffer bleiben nutzbar; mit „Scan fortsetzen“ geht es exakt an dieser Stelle weiter.`);S.stop=false;updateMoreUi();return;
}
S.paused=false;
if(S.nextCandidateIndex>=total){
const limit=activeRateLimitText();
status(`✅ Vollkatalogscan fertig: ${total} Badge-Sets geprüft · ${S.results.length} Treffer geladen · alle Treffer bleiben per Seitenwahl erreichbar · ${S.stats.marketValidations} Top-Marktprüfungen · ${S.deepCheckCompleted} manuelle Low-Bid-Deepchecks.${limit?` ${limit}; weitere Exaktprüfung später möglich.`:''}`);
}
}

function clearFilters(){
if(
!S.modal
){
return;
}

const text=
S.modal
.querySelector(
'#filterText'
);

const max=
S.modal
.querySelector(
'#filterMaxCost'
);

const green=
S.modal
.querySelector(
'#filterGreen'
);

const badge=
S.modal
.querySelector(
'#filterBadgeHit'
);

const foil=
S.modal
.querySelector(
'#filterFoil'
);

const foilGreen=
S.modal
.querySelector(
'#filterFoilGreen'
);

const fav=
S.modal
.querySelector(
'#filterFav'
);

const level0=
S.modal
.querySelector(
'#filterLevel0'
);

const marketSuper=
S.modal
.querySelector(
'#filterMarketSuper'
);

const lowBidTop=
S.modal
.querySelector(
'#filterLowBidTop'
);

const freshHunt=
S.modal
.querySelector(
'#filterFreshHunt'
);

const startedSets=
S.modal
.querySelector(
'#filterStartedSets'
);

const sort=
S.modal
.querySelector(
'#filterSort'
);

if(
text
){
text.value=
'';
}

if(
max
){
max.value=
'';
}

if(
green
){
green.checked=
false;
}

if(
badge
){
badge.checked=
false;
}

if(
foil
){
foil.checked=
false;
}

if(
foilGreen
){
foilGreen.checked=
false;
}

if(
fav
){
fav.checked=
false;
}

if(
level0
){
level0.checked=
false;
}

if(marketSuper){marketSuper.checked=false;}
if(lowBidTop){lowBidTop.checked=false;}
if(freshHunt){freshHunt.checked=false;}
if(startedSets){startedSets.checked=false;}
saveFreshHuntPreference(false);
saveStartedSetsPreference(false);

if(
sort
){
sort.value=
'relevance';
}

syncFiltersFromFirstPage();
}

async function runCheap(){
if(
S.running||
S.scanBusy
){
return;
}

S.running=
true;

beginRun(
true
);

try{
status(
'📚 Lade globalen Badge-Preis-Katalog …'
);

const[catalog]=
await Promise.all([
loadSceCatalog(),

loadBadgeNameDb()
.catch(
error=>{
console.warn(
'[Badge Scout] Badge-Level-Katalog im Schnellscan nicht verfügbar',
error
);

return[];
}
),

loadGlobalNormalMarketSnapshot(false)
.catch(error=>{
console.warn('[Badge Scout] Schnellmarkt ohne Live-Snapshot',error);
return[];
}),

ensureBadgeCollection(false),

ensureActiveBuyOrders(false)
]);

const hints=
visibleBadgeHints();

const trackedApps=new Set([
...[...S.badgeCollectionByApp.entries()]
.filter(([,entry])=>entry?.started)
.map(([appid])=>String(appid)),
...S.activeBuyOrdersByApp.keys(),
...loadFavs()
]);

const withPrice=
catalog
.filter(
candidate=>
candidate.cardsInSet>
0&&
(
(
Number.isFinite(candidate.scePriceCents)&&
candidate.scePriceCents!==null
)||
trackedApps.has(String(candidate.appid))
)&&
!(
CFG
.normalModesHideMaxed&&
Number(
hints.get(
String(
candidate.appid
)
)
?.badgeLevel||
0
)>=
5
)
)
.map(
candidate=>({
...candidate,

prelimCost:
preliminaryPersonalCost(
candidate,
hints
),

prelimEfficiency:
preliminaryPersonalCost(candidate,hints)+
Number(candidate.cardsInSet||0)*CFG.efficiencyCardPenaltyCents
})
)
.sort(
(a,b)=>
a.prelimEfficiency-
b.prelimEfficiency||
a.prelimCost-b.prelimCost||
a.cardsInSet-b.cardsInSet||
(a.scePriceCents??999999)-
(b.scePriceCents??999999)
);

if(
!withPrice.length
){
throw new Error(
'Der Preis-Katalog enthielt keine verwertbaren Badge-Preise.'
);
}

resetResultSession(
'cheap',
withPrice,
[],
''
);

status(
`💸 Vollkatalogscan bereit: alle ${withPrice.length} katalogisierten Badge-Sets werden lokal und fortlaufend ausgewertet. Der gebündelte Markt-Snapshot ersetzt tausende Einzelabfragen; nur unvollständige Topsets werden anschließend gezielt validiert. Alle Treffer bleiben über Seiten erreichbar.`
);

}catch(error){
status(
`❌ ${String(
error?.message||
error
)}`
);

console.error(
'[Badge Scout]',
error
);

return;

}finally{
S.running=
false;

endRun();
}

await scanNextResults();
}

async function runFoilCheap(){
if(
S.running||
S.scanBusy
){
return;
}

S.running=
true;

beginRun(
true
);

try{
status(
'✨ Lade Katalog für separate Glanz-Suche …'
);

const[catalog]=await Promise.all([
loadSceCatalog(),
ensureActiveBuyOrders(false),
ensureBadgeCollection(false)
]);

const candidates=
catalog
.filter(
candidate=>
candidate.cardsInSet>
0
)
.map(
candidate=>({
...candidate,

prelimFoilRank:
(
Number.isFinite(
candidate.scePriceCents
)
?candidate.scePriceCents
:9999
)+
candidate.cardsInSet*
3
})
)
.sort(
(a,b)=>
a.prelimFoilRank-
b.prelimFoilRank||
a.cardsInSet-
b.cardsInSet
);

if(
!candidates.length
){
throw new Error(
'Keine verwertbaren Kandidaten für die Glanz-Suche gefunden.'
);
}

resetResultSession(
'foil',
candidates,
[],
''
);

status(
`✨ ${candidates.length} Spiele werden als unabhängige Glanz-Kandidaten geführt. Normale Level-5-Badges dürfen hier erscheinen; bereits fertige Foil-Badges werden entfernt.`
);

}catch(error){
status(
`❌ ${String(
error?.message||
error
)}`
);

console.error(
'[Badge Scout]',
error
);

return;

}finally{
S.running=
false;

endRun();
}

await scanNextResults();
}

async function runTheme(){
if(
S.running||
S.scanBusy
){
return;
}

const query=
clean(
S.modal
.querySelector(
'#theme'
)
.value
);

if(
!query
){
alert(
'Suchbegriff eingeben, z. B. Shenlong, Dragon Ball, Dragon, Anime, Cyberpunk, Demon, Anime …'
);

return;
}

S.running=
true;

beginRun(
true
);

try{
status(
'📚 Lade Badge-Katalog und suche alle bekannten Treffer …'
);

const[catalog]=await Promise.all([
loadSceCatalog(),
ensureActiveBuyOrders(false),
ensureBadgeCollection(false)
]);

const terms=
expandTheme(
query
);

const candidates=
await themeCandidates(
catalog,
query
);

if(
!candidates.length
){
throw new Error(
`Keine Kandidaten für „${query}“ gefunden.`
);
}

resetResultSession(
'theme',
candidates,
terms,
query
);

status(
`🔎 ${candidates.length} Kandidaten für „${query}“ gefunden. Der Scan startet; Low-Bid-Deepchecks bleiben bewusst manuell, damit die Themen-Suche nicht unnötig ausgebremst wird.`
);

}catch(error){
status(
`❌ ${String(
error?.message||
error
)}`
);

console.error(
'[Badge Scout]',
error
);

return;

}finally{
S.running=
false;

endRun();
}

await scanNextResults();
}

function showFavs(){
const checkbox=
S.modal
?.querySelector(
'#filterFav'
);

if(
!checkbox
){
return;
}

checkbox.checked=
!checkbox.checked;

syncVisibleResults(
true
);

status(
checkbox.checked
?'⭐ Filter aktiv: Es werden nur Favoriten aus den bereits geprüften Treffern angezeigt.'
:'⭐ Favoriten-Filter ausgeschaltet.'
);
}

function injectStyle(){
if(
document.getElementById(
'badgeScoutStyle'
)
){
return;
}

const style=
document.createElement(
'style'
);

style.id=
'badgeScoutStyle';

style.textContent=`
#badgeScoutLaunch{position:fixed;right:20px;bottom:72px;z-index:999998;border:0;border-radius:5px;padding:11px 15px;background:#1a9fff;color:#fff;font-weight:700;cursor:pointer;box-shadow:0 4px 15px rgba(0,0,0,.35)}
#badgeScoutOverlay{position:fixed;inset:0;z-index:1000002;background:rgba(0,0,0,.84);display:flex;align-items:center;justify-content:center;padding:18px}
.scoutModal{width:min(1200px,97vw);max-height:94vh;overflow:auto;overscroll-behavior:contain;scrollbar-gutter:stable;background:#1b2a3a;color:#d6d7d8;border:1px solid #35536e;border-radius:6px;padding:18px;font-family:Arial,Helvetica,sans-serif;box-shadow:0 18px 70px rgba(0,0,0,.7)}
.controls,.actions{display:flex;flex-wrap:wrap;gap:8px;margin:14px 0;align-items:center}
.controls button,.actions button,.filterchecks button,.fav{border:0;border-radius:4px;padding:9px 12px;font-weight:700;cursor:pointer}
.btnGreen,.openBadge{background:#75b022;color:#fff}.btnBlue{background:#1a9fff;color:#fff}.btnGray,.openScx,.fav{background:#ddd;color:#111}
#theme{min-width:280px;flex:1 1 320px;padding:10px;background:#101923;color:#fff;border:1px solid #35536e;border-radius:4px}
#status{background:#101923;border:1px solid #35536e;padding:10px;margin:10px 0;border-radius:4px}
.meta,#expanded,.muted{color:#9fb0bf;font-size:12px}.proxy{opacity:.75}.badge-hit{color:#8bcf5b;font-weight:700;margin-top:4px}
.result{background:#26394c;content-visibility:auto;contain-intrinsic-size:430px;border-left:4px solid #1a9fff;padding:12px;margin:10px 0;border-radius:4px}
.head{display:flex;justify-content:space-between;gap:12px;align-items:flex-start}
.head h3{margin:2px 0 5px;color:#fff;font-size:18px}.head small{color:#9fb0bf}
.green{color:#8bcf5b}.yellow{color:#ffcf70}.intel{color:#8fc7ff}.red{color:#ff7777}.market-signal{margin-top:5px;padding:5px 7px;border-radius:3px;background:#172636}.marketSuper{color:#7ee787}.marketGood{color:#9be36a}.marketOkay{color:#ffd166}.marketThin{color:#ffad66}.marketWeak{color:#ff7777}.marketUnknown{color:#aab8c5}
.order-coverage{margin-top:5px;padding:5px 7px;border-radius:3px;background:#132535}.order-covered{color:#74e6a7}.order-partial{color:#ffd166}.order-ready{color:#9bd8ff}.order-loading{color:#ffd166}.order-error{color:#ff8c8c}
.levels{display:grid;grid-template-columns:repeat(5,minmax(110px,1fr));gap:8px;margin-top:12px}
.level{background:#172636;border:1px solid #35536e;padding:8px;min-height:145px;text-align:center;border-radius:4px;display:flex;flex-direction:column;align-items:center;gap:5px}
.level.target{outline:2px solid #75b022}
.level img,.placeholder{width:80px;height:80px;object-fit:contain;background:#0f1822;border-radius:3px}
.placeholder{display:flex;align-items:center;justify-content:center;font-size:28px;color:#789}
.level b{color:#fff;font-size:12px}.level span{color:#b9c5cf;font-size:11px;line-height:1.25}
.foil-section{margin-top:10px;padding-top:10px;border-top:1px solid #35536e}
.foil-title{color:#fff;font-weight:700;font-size:13px;margin-bottom:7px}
.foil-verdict{font-weight:700;font-size:12px;margin:0 0 4px}
.foil-market-meta{color:#9fb0bf;font-size:11px;margin:0 0 8px}
.foil-badge{display:flex;align-items:center;gap:10px;width:fit-content;min-width:220px;max-width:100%;background:#172636;border:1px solid #8a6fb5;padding:8px 12px;border-radius:4px}
.foil-badge.missing{opacity:.75}
.foil-badge img,.foil-badge .placeholder{width:80px;height:80px;object-fit:contain;flex:0 0 80px}
.foil-badge b{display:block;color:#fff;font-size:13px;margin-bottom:4px}
.foil-badge span{display:block;color:#b9c5cf;font-size:11px;line-height:1.25}
.filterbar{display:grid;grid-template-columns:minmax(180px,1.5fr) minmax(130px,.7fr) minmax(150px,.8fr);gap:8px;margin:10px 0;padding:10px;background:#101923;border:1px solid #35536e;border-radius:4px}
.filterbar input[type="text"],.filterbar select{width:100%;box-sizing:border-box;padding:8px;background:#172636;color:#fff;border:1px solid #35536e;border-radius:4px}
.filterchecks{grid-column:1/-1;display:flex;flex-wrap:wrap;gap:12px;align-items:center;font-size:12px;color:#c4d1dc}
.filterchecks label{display:inline-flex;align-items:center;gap:5px;cursor:pointer}
.filter-note{grid-column:1/-1;color:#9fc8e8;font-size:12px;padding:6px 8px;background:#142638;border-radius:4px}
.morebar{position:sticky;bottom:0;z-index:5;display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:12px;padding:10px;background:rgba(16,25,35,.96);border:1px solid #35536e;border-radius:4px;backdrop-filter:blur(5px)}
.morebar button{border:0;border-radius:4px;padding:9px 12px;font-weight:700;cursor:pointer}
.morebar button:disabled{opacity:.55;cursor:default}
#resultProgress{margin-right:auto;font-size:12px;color:#b9c5cf}
.page-nav{display:inline-flex;align-items:center;gap:6px;white-space:nowrap}
.page-nav select{padding:7px;background:#172636;color:#fff;border:1px solid #35536e;border-radius:4px}
#resultPageStatus{min-width:150px;text-align:center;color:#d5e2ec;font-size:12px}
.auto-more{display:inline-flex;align-items:center;gap:5px;font-size:12px;color:#b9c5cf}
.empty{padding:25px;text-align:center;color:#9fb0bf}
@media(max-width:850px){.filterbar{grid-template-columns:1fr}.filterchecks{grid-column:1}.levels{grid-template-columns:repeat(2,minmax(120px,1fr))}}
`;

document.head.appendChild(
style
);
}

function openModal(){
document
.getElementById(
'badgeScoutOverlay'
)
?.remove();

const overlay=
document.createElement(
'div'
);

overlay.id=
'badgeScoutOverlay';

overlay.innerHTML=`
<div class="scoutModal">
<h2>🎯 Badge Scout 3.0.1 – Vollkatalog + Schnellmarkt + Sammlungsradar</h2>

<div class="muted">
Der Scout funktioniert vollständig eigenständig.
Analyzer und Wächter sind nicht erforderlich.
Shared-Intel ist nur ein Bonus:
Ein gespeicherter Level-5-Status darf ausschließlich dann
einen Steam-Request sparen, wenn er höchstens 6 Stunden alt ist.
Alte oder undatierte Zustände werden ignoriert.
<br><br>
<b>3.0.1 Vollkatalogscan:</b> Der Scout wertet wieder den gesamten verfügbaren Badge-Katalog aus – nicht nur eine feste Vorauswahl.
Eine kleine Zahl globaler Steam-Marktseiten liefert viele günstige Karten gebündelt; der restliche Katalog wird lokal mit einem groben SteamCardExchange-Katalogwert vorsortiert.
Nur unvollständige Top-Kandidaten werden danach spielbezogen exakt validiert.
Alle Treffer bleiben filter- und sortierbar; angezeigt wird immer nur eine wählbare Ergebnisseite, damit 13.000+ Sets den Browser nicht blockieren.
So ersetzt der Scout zehntausende Einzelrequests durch wenige gezielte Abfragen und reagiert auf HTTP 429 mit einer kontrollierten Pause.
<br><br>
Normale und Glanz-Suche sind getrennt.
Level-5-Normalbadges werden aus normalen Kauf-Treffern entfernt.
Für die Glanz-Suche darf das normale Badge dagegen Level 5 sein,
solange dein Foil-Badge noch nicht gefertigt wurde.
<br><br>
<b>Sammlungsradar:</b> Der Scout lädt deine Badge-Seiten und aktiven Karten-Kaufaufträge direkt von Steam.
Der optionale Filter zeigt wirklich frische Sets: Bereits begonnene Sammlungen werden ausgeblendet,
sobald mindestens ein passender Kaufauftrag läuft, mindestens eine Karte vorhanden ist oder bereits Badge-Fortschritt besteht.
Das gilt sofort beim Ein- und Ausschalten, auch während eines laufenden Scans und unabhängig von der Sortierung.
Die Treffer werden niemals gelöscht: Haken entfernen und alle vorher ausgeblendeten Sammlungen erscheinen wieder.
Der Gegenfilter zeigt ausschließlich begonnene Sets, damit du sie erneut analysieren und verfolgen kannst.
<br><br>
<b>SteamCardExchange (SCE)</b> liefert nur einen groben, nicht live von deinem Steam-Markt stammenden Katalog-Richtwert für die Reihenfolge. Das ist keine Kaufempfehlung und keine neue Bewertungsskala. Grün/MARKT-SUPER gibt es erst mit ausreichend vollständigen Steam-Livepreisen und Sell-Supply. Mit „Nächste 20 live prüfen“ kannst du weitere Kandidaten kontrolliert bestätigen lassen.
<br><br>
<b>Low-Bid-Deepcheck:</b> Er vergleicht bei zwei repräsentativen Karten aktive Buy- mit Sell-Orders. Das ist ein Konkurrenzindikator, keine Fill-Garantie.
Die Top-5-Prüfung wird bewusst manuell gestartet, damit sie den Hauptscan nicht stundenlang ausbremst.
Die Sortierung <b>Preis + wenige Karten</b> addiert nur für die Reihenfolge 0,02 € je Setkarte zum Preis; sie verändert weder Marktampel noch Kaufempfehlung.
</div>

<div class="controls">
<button id="cheap" class="btnGreen">💸 Billige normale Sets finden</button>
<button id="foilCheap" class="btnBlue">✨ Günstige Glanz-Sets finden</button>

<input id="theme" placeholder="z. B. Dragon Ball, Shenlong, Dragon, Cyberpunk, Demon, Anime …">

<button id="themeBtn" class="btnBlue">🔎 Thema / ähnliche Badges suchen</button>
<button id="favs" class="btnGray">⭐ Favoriten-Filter</button>
<button id="stop" class="btnGray" style="display:none">⏸ Scan pausieren</button>
<button id="close" class="btnGray">Schließen</button>
</div>

<div class="filterbar">
<input id="filterText" type="text" placeholder="In geladenen Treffern filtern: Spiel, Badge, Glanz, Karte …">

<select id="filterMaxCost">
<option value="">Preis im aktuellen Modus: egal</option>
<option value="30">bis 0,30 €</option>
<option value="60">bis 0,60 €</option>
<option value="100">bis 1,00 €</option>
<option value="200">bis 2,00 €</option>
</select>

<select id="filterSort">
<option value="relevance">Sortierung: Relevanz/Fundreihenfolge</option>
<option value="price">Preis: günstig zuerst</option>
<option value="efficiency">Preis + wenige Karten: effizient zuerst</option>
<option value="supply">Sell-Angebot: gesund zuerst</option>
<option value="market">Marktlage: beste zuerst</option>
<option value="lowbid">Low-Bid-Chance: beste zuerst</option>
<option value="popularity">Popularität</option>
<option value="theme">Themen-Score</option>
<option value="name">Spielname A–Z</option>
</select>

<div class="filterchecks">
<label><input id="filterGreen" type="checkbox">nur 🟢 günstige/okay</label>
<label><input id="filterLevel0" type="checkbox">nur normales Badge Level 0</label>
<label><input id="filterMarketSuper" type="checkbox">nur 🟢 MARKT-SUPER</label>
<label title="Zeigt geprüfte oder vorgemerkte Topsets. Die Prüfung nutzt zwei repräsentative Karten als Konkurrenzindikator, nicht als Fill-Garantie."><input id="filterLowBidTop" type="checkbox">nur 💎/🟢 Low-Bid-Top (Deepcheck)</label>
<label><input id="filterBadgeHit" type="checkbox">nur 🎖 Badge-Namens-Treffer</label>
<label><input id="filterFoil" type="checkbox">nur ✨ mit geladenem Glanzabzeichen</label>
<label><input id="filterFoilGreen" type="checkbox">nur ✨ 🟢 günstige Glanz-Sets</label>
<label><input id="filterFav" type="checkbox">nur ★ Favoriten</label>
<label title="Blendet bereits begonnene Sammlungen aus: aktiver Kaufauftrag, vorhandene Karte oder Badge-Fortschritt. Abschalten stellt die Treffer sofort wieder her."><input id="filterFreshHunt" type="checkbox">🆕 Fresh Hunt: begonnene Sammlungen ausblenden</label>
<label title="Gegenansicht zu Fresh Hunt: zeigt nur Sets mit vorhandener Karte, Badge-Fortschritt oder aktivem Karten-Kaufauftrag."><input id="filterStartedSets" type="checkbox">📌 nur aktuell begonnene/gesammelte Sets</label>
<button id="refreshBuyOrders" class="btnGray" type="button">↻ Sammlung + Kaufaufträge aktualisieren</button>
<button id="validateMarket" class="btnGray" type="button">📊 Nächste 20 live prüfen</button>
<button id="runDeepChecks" class="btnGray" type="button">🔬 Top 5 Low-Bid prüfen</button>
<button id="clearFilters" class="btnGray" type="button">Filter zurücksetzen</button>
</div>
<div class="filter-note">ℹ️ Mehrere „nur“-Haken werden als UND kombiniert: Ein Treffer muss dann alle aktivierten Bedingungen gleichzeitig erfüllen. Darum wird z. B. aus 16 günstigen Treffern eine kleinere Schnittmenge, wenn MARKT-SUPER und Low-Bid-Top dazukommen.</div>
</div>

<div id="expanded" class="muted"></div>

<div id="status">
Bereit. Suche starten; danach erscheinen die Treffer fortlaufend.
</div>

<div id="scout-results"></div>

<div class="morebar">
<span id="resultProgress">0/0 geprüft · 0 geladen · 0 sichtbar</span>
<span class="page-nav">
<button id="previousPage" class="btnGray" type="button" disabled>◀ Zurück</button>
<span id="resultPageStatus">Seite 0/0</span>
<select id="resultPageSize" title="Treffer pro Ergebnisseite">
<option value="50">50 / Seite</option>
<option value="100" selected>100 / Seite</option>
<option value="200">200 / Seite</option>
</select>
<button id="nextPage" class="btnGray" type="button" disabled>Weiter ▶</button>
</span>
<button id="resumeScan" class="btnGreen" style="display:none">▶ Scan fortsetzen</button>
<span id="deepStatus" class="auto-more">🔬 Low-Bid manuell: 0/${CFG.deepCheckMaxGames}</span>
<span id="freshHuntStatus" class="auto-more">🧭 Sammlung wird geladen …</span>
<span class="auto-more">⚡ Vollkatalog · paginiert · 429-sicher · kein Scrollzwang</span>
</div>
</div>`;

document.body.appendChild(
overlay
);

S.modal=
overlay;

const pageSizeSelect=overlay.querySelector('#resultPageSize');
if(pageSizeSelect){
pageSizeSelect.value=String(S.resultPageSize);
pageSizeSelect.addEventListener('change',()=>{
S.resultPageSize=Math.max(1,Number(pageSizeSelect.value)||CFG.resultPageSize);
syncFiltersFromFirstPage();
});
}

overlay.querySelector('#previousPage')?.addEventListener('click',()=>moveResultPage(-1));
overlay.querySelector('#nextPage')?.addEventListener('click',()=>moveResultPage(1));

const freshHuntFilter=overlay.querySelector('#filterFreshHunt');
if(freshHuntFilter){
freshHuntFilter.checked=loadFreshHuntPreference();
freshHuntFilter.addEventListener('change',async()=>{
const enabled=freshHuntFilter.checked;
saveFreshHuntPreference(enabled);
if(enabled){
const started=overlay.querySelector('#filterStartedSets');
if(started){started.checked=false;saveStartedSetsPreference(false);}
}
syncFiltersFromFirstPage();
if(enabled){
await Promise.all([
ensureActiveBuyOrders(false),
ensureBadgeCollection(false)
]);
}
if(S.modal===overlay&&freshHuntFilter.checked===enabled){
syncFiltersFromFirstPage();
announceFreshHuntState(enabled);
}
});
}

const startedSetsFilter=overlay.querySelector('#filterStartedSets');
if(startedSetsFilter){
startedSetsFilter.checked=loadStartedSetsPreference();
if(startedSetsFilter.checked&&freshHuntFilter){
freshHuntFilter.checked=false;
saveFreshHuntPreference(false);
}
startedSetsFilter.addEventListener('change',()=>{
saveStartedSetsPreference(startedSetsFilter.checked);
if(startedSetsFilter.checked&&freshHuntFilter){
freshHuntFilter.checked=false;
saveFreshHuntPreference(false);
}
syncFiltersFromFirstPage();
if(startedSetsFilter.checked){
void ensureActiveBuyOrders(false);
void ensureBadgeCollection(false);
}
});
}

const refreshBuyOrders=overlay.querySelector('#refreshBuyOrders');
if(refreshBuyOrders){
refreshBuyOrders.onclick=async()=>{
const oldText=refreshBuyOrders.textContent;
refreshBuyOrders.disabled=true;
refreshBuyOrders.textContent='↻ Sammlung und Kaufaufträge werden geladen …';
await Promise.all([
ensureActiveBuyOrders(true),
ensureBadgeCollection(true)
]);
if(S.modal===overlay){
syncFiltersFromFirstPage();
refreshBuyOrders.disabled=false;
refreshBuyOrders.textContent=oldText;
}
};
}

const validateMarket=overlay.querySelector('#validateMarket');
if(validateMarket){
validateMarket.onclick=async()=>{
validateMarket.disabled=true;
const oldText=validateMarket.textContent;
validateMarket.textContent='📊 Marktprüfung läuft …';
await validateTopMarketResults(CFG.manualExactValidationGames,true);
if(S.modal===overlay){validateMarket.disabled=false;validateMarket.textContent=oldText;}
};
}

const runDeepChecksButton=overlay.querySelector('#runDeepChecks');
if(runDeepChecksButton){
runDeepChecksButton.onclick=async()=>{
runDeepChecksButton.disabled=true;
const oldText=runDeepChecksButton.textContent;
runDeepChecksButton.textContent='🔬 Topsets werden geprüft …';
await runBestDeepChecks();
if(S.modal===overlay){runDeepChecksButton.disabled=false;runDeepChecksButton.textContent=oldText;}
};
}

overlay
.querySelector(
'#cheap'
)
.onclick=
runCheap;

overlay
.querySelector(
'#themeBtn'
)
.onclick=
runTheme;

overlay
.querySelector(
'#foilCheap'
)
.onclick=
runFoilCheap;

overlay
.querySelector(
'#favs'
)
.onclick=
showFavs;

overlay
.querySelector(
'#resumeScan'
)
.onclick=
()=>
scanNextResults();

overlay
.querySelector(
'#stop'
)
.onclick=
event=>{
S.pauseRequested=
true;

event.currentTarget.disabled=
true;

event.currentTarget.textContent=
'Scan wird pausiert …';
};

overlay
.querySelector(
'#close'
)
.onclick=
()=>{
if(
!S.running&&
!S.scanBusy
){
if(S.foilObserver){S.foilObserver.disconnect();S.foilObserver=null;}
if(S.uiSyncTimer){clearTimeout(S.uiSyncTimer);S.uiSyncTimer=null;}
overlay.remove();
}
};

overlay
.querySelector(
'#theme'
)
.addEventListener(
'keydown',
event=>{
if(
event.key===
'Enter'
){
runTheme();
}
}
);

for(const selector of[
'#filterText',
'#filterMaxCost',
'#filterSort',
'#filterGreen',
'#filterLevel0',
'#filterMarketSuper',
'#filterLowBidTop',
'#filterBadgeHit',
'#filterFoil',
'#filterFoilGreen',
'#filterFav'
]){
const element=
overlay
.querySelector(
selector
);

const eventName=
element?.tagName===
'INPUT'&&
element?.type===
'text'
?'input'
:'change';

element
?.addEventListener(
eventName,
()=>syncFiltersFromFirstPage()
);
}

const lowBidFilter=overlay.querySelector('#filterLowBidTop');
lowBidFilter?.addEventListener('change',()=>{
if(lowBidFilter.checked&&S.deepCheckCompleted===0&&S.deepCheckQueue.length){
status('🔬 Low-Bid-Top zeigt vorgemerkte Kandidaten. Für die echte Buy/Sell-Stichprobe „Top 5 Low-Bid prüfen“ klicken.');
}
});

overlay
.querySelector(
'#clearFilters'
)
.onclick=
clearFilters;

// Die Seitengröße begrenzt nur den DOM, niemals den Scan.
// Kein Scroll-Trigger: Jede Suche scannt automatisch bis Ende oder manuellem Stop.
updateMoreUi();
void ensureActiveBuyOrders(false);
void ensureBadgeCollection(false);
}

function launch(){
injectStyle();

if(
document.getElementById(
'badgeScoutLaunch'
)
){
return;
}

const button=
document.createElement(
'button'
);

button.id=
'badgeScoutLaunch';

button.textContent=
'🎯 Badge Scout';

button.onclick=
openModal;

document.body.appendChild(
button
);
}

S.profile=
profileBase();

launch();
})();
