// ==UserScript==
// @name         Steam Badge & Kaufauftrags-Wächter
// @namespace    emre-steam-badge-order-watch
// @version      3.2.1
// @description  Portfolio-Wächter mit Current-/Future-Craft-Reserve, Badge-Zielen, konkurrenzbereinigter Kaufpreisprüfung und vollständigerer Steam-Verkaufsübersicht. Liest aktive Listings plus separat gerenderte Market-Holds, prüft Buy-/Sell-Depth, Historien, geduldige Preisziele und taktisches Verkaufen/Rückkaufen. Keine automatischen Käufe/Stornos/Verkäufe.
// @match        https://steamcommunity.com/market/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==
(() => {'use strict';

const CFG = {
country:'DE',
currency:3,
language:'english',
marketAppId:753,
targetCopiesPerCard:1,
normalBadgeMaxLevel:5,

// Future-Craft-Reserve:
// Ohne bewusst gesetztes Badge-Ziel wird bis Level 5 geschützt. Das ist
// absichtlich konservativ: Unklare Duplikate werden nicht voreilig verkauft.
protectFutureCopiesWhenGoalUnknown:true,

// Eine Future-Craft-Kopie darf nur dann taktisch verkauft werden, wenn der
// aktuelle Marktpreis nach geschätzter Steam-Gebühr einen klaren Rückkauf-
// Vorteil gegenüber dem robusten 30/90/365T-Anker lässt.
futureReserveSellPremiumPct:0.45,
futureReserveSellMinGrossGapCents:3,
futureReserveSellMinNetGainCents:2,
futureReserveSellMinNetRoiPct:0.25,
futureReserveSellMinDailyVolume:1.0,
futureReserveSellMinActiveDays30d:12,
futureReserveMaxTacticalCopiesPerCard:1,

gapBadgeMs:750,
gapListingMs:1800,
gapApiMs:600,

maxAttempts:4,
cooldown429Ms:15000,

itemIdCacheDays:365,
orderTrackingKeepDays:365,
sellTrackingKeepDays:730,

// Aktive Verkaufsangebote: geduldig, aber nicht unrealistisch.
scanActiveSellListings:true,
scanMarketOverviewSellListings:true,
sellListingsPageSize:100,
sellAgeInfoDays:60,
sellAgeReviewDays:120,
sellAgeHardReviewDays:180,
preferredSellQueueDays:90,
hardSellQueueDays:180,
absurdSellQueueDays:365,
sellRaiseMinCents:2,
sellLowerMinCents:2,
sellHistoricalUpsidePct:0.12,
sellMaxPremiumVsLowestPct:0.55,

// Verkaufsnachfrage und Steam-Holds:
// Buy-Depth bestätigt oder bremst Preisänderungen; sie ist niemals eine
// Verkaufs- oder Fill-Garantie. Gehaltene/unbestätigte Listings werden nicht
// als normal aktive Sell-Queue behandelt.
sellDemandNearLevels:3,
sellStrongDemandQueueMultiplier:1.15,
sellWeakDemandQueueMultiplier:0.75,
sellPendingUnderpriceMinCents:3,
sellPendingUnderpriceMinPct:0.25,

// Bestehende Kaufaufträge:
// Der eigene Auftrag wird aus der sichtbaren Buy-Stufe herausgerechnet. Nur
// ein belastbarer, materieller Abstand zur höchsten fremden Konkurrenz kann
// eine SENKEN-Prüfung auslösen; KEEP bleibt der Standard.
buyLowerMinSavingsCents:2,
buyLowerMinSavingsPct:0.20,
buyLowerStepAboveExternalCents:1,
buyLowerMaxTargetQueueDays:120,
buyLowerMinDailyVolume:0.25,
buyLowerMinActiveDays30d:8,

// Geduldige Effizienzstrategie:
// Alter und Queue allein sind kein Problem.
staleDaysReview:90,
veryStaleDaysReview:180,

// Queue-Flag ist nur Information und löst allein kein Review aus.
crowdedQueueDays:60,

fallbackSearchPages:4,
fallbackMinScore:0.58,
eurMinimumBuyCents:3,
marketDepthLevels:60,

scanOwnedCardsForSale:true,
scanMaxedBadgesForSale:true,

discoverOwnedCardSets:true,
inventoryPageSize:2000,

fewSellers:50,
veryFewSellers:20,

lowDailyVolume:2.0,
veryLowDailyVolume:0.75,

lowActiveDays30d:20,
veryLowActiveDays30d:15,

thinCheapestTier:2,
thinFirstTwoTiers:8,

expensiveCardCents:15,
expensiveSetCents:80,
veryExpensiveSetCents:120,

stopCandidateOwnedMax:1,
stopCandidateMissingRatio:0.60,

sharedIntelKey:'emreSteamBadgeIntel:v1'
};

const KEYS = {
itemIdCache:'sbw:itemNameId:v3',
orderWatch:'sbw:orderWatch:v3',
actionPlan:'sbw:actionPlan:v3',
actionDone:'sbw:actionDone:v3',
sellWatch:'sbw:sellWatch:v2',
sellWatchLegacy:'sbw:sellWatch:v1',
badgeGoals:'sbw:badgeGoals:v1'
};

const STATE = {
running:false,
stopRequested:false,
profileBase:null,
orders:[],
sellListings:[],
marketOverviewHtml:null,
sellListingCoverage:null,
groups:[],
ownedCardApps:new Map(),
steamId64:null,
discoveryWarning:null,
sellListingWarning:null,
generated:null,
modal:null,
stats:{}
};

let lastRequestAt=0;

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const clean=value=>String(value??'').replace(/\s+/g,' ').trim();
const round2=value=>Number.isFinite(Number(value))?Math.round(Number(value)*100)/100:null;
const round4=value=>Number.isFinite(Number(value))?Math.round(Number(value)*10000)/10000:null;
const finiteNumber=value=>value===null||value===undefined||value===''?null:(Number.isFinite(Number(value))?Number(value):null);

function escapeHtml(value){
const div=document.createElement('div');
div.textContent=String(value??'');
return div.innerHTML;
}

function parseCount(value){
const digits=String(value??'').replace(/[^0-9]/g,'');
return digits?Number(digits):0;
}

function moneyToCents(value){
const matches=[...clean(value).matchAll(/(\d+[.,]\d{1,2})/g)];
if(!matches.length)return null;
const number=Number(matches[0][1].replace(',','.'));
return Number.isFinite(number)?Math.round(number*100):null;
}

function euro(cents){
if(cents===null||cents===undefined||!Number.isFinite(Number(cents)))return'—';
return`${(Number(cents)/100).toFixed(2).replace('.',',')} €`;
}

function stripHtml(html){
const doc=new DOMParser().parseFromString(String(html??''),'text/html');
return clean(doc.body?.textContent||'');
}

function normalizeName(value){
return String(value??'')
.normalize('NFKD')
.toLowerCase()
.replace(/\(foil(?: trading card)?\)/g,'')
.replace(/\(trading card\)/g,'')
.replace(/[^a-z0-9]+/g,'');
}

function levenshtein(a,b){
if(a===b)return 0;
if(!a.length)return b.length;
if(!b.length)return a.length;

const previous=Array.from({length:b.length+1},(_,i)=>i);
const current=new Array(b.length+1);

for(let i=1;i<=a.length;i++){
current[0]=i;

for(let j=1;j<=b.length;j++){
current[j]=Math.min(
current[j-1]+1,
previous[j]+1,
previous[j-1]+(a[i-1]===b[j-1]?0:1)
);
}

for(let j=0;j<=b.length;j++){
previous[j]=current[j];
}}

return previous[b.length];
}

function nameScore(wanted,candidate){
const a=normalizeName(wanted);
const b=normalizeName(candidate);

if(!a||!b)return 0;
if(a===b)return 1;

if(a.includes(b)||b.includes(a)){
const ratio=Math.min(a.length,b.length)/Math.max(a.length,b.length);
return 0.82+0.18*ratio;
}

return 1-levenshtein(a,b)/Math.max(a.length,b.length);
}

function getCookie(name){
const prefix=encodeURIComponent(name)+'=';
const found=document.cookie.split('; ').find(value=>value.startsWith(prefix));
return found?decodeURIComponent(found.slice(prefix.length)):null;
}

function setCookie(name,value,domain=null){
document.cookie=
`${encodeURIComponent(name)}=`+
`${encodeURIComponent(value)}; `+
`path=/; max-age=31536000; `+
`${domain?`domain=${domain}; `:''}`+
`SameSite=Lax; Secure`;
}

function deleteCookie(name,domain=null){
document.cookie=
`${encodeURIComponent(name)}=; `+
`path=/; max-age=0; `+
`${domain?`domain=${domain}; `:''}`+
`SameSite=Lax; Secure`;
}

function restoreCookie(name,previous){
if(previous===null||previous===undefined){
deleteCookie(name);
deleteCookie(name,'steamcommunity.com');
}else{
setCookie(name,previous);
setCookie(name,previous,'steamcommunity.com');
}}

function loadSharedIntel(){
try{
const raw=JSON.parse(localStorage.getItem(CFG.sharedIntelKey)||'{}');
return raw&&typeof raw==='object'?raw:{};
}catch{return{};}
}

function saveSharedIntel(data){
try{
localStorage.setItem(CFG.sharedIntelKey,JSON.stringify(data));
}catch{}
}

function updateSharedIntel(appid,patch){
if(!appid)return;

const all=loadSharedIntel();
const key=String(appid);
const old=all[key]&&typeof all[key]==='object'?all[key]:{};

const merged={
...old,
...patch,
appid:key,
updatedAt:Date.now(),
lastSource:'badge-watcher'
};

for(const field of[
'normalBadge',
'foilBadge',
'lastAnalyzer',
'lastWatcher',
'lastSetDecision'
]){
if(patch?.[field]&&typeof patch[field]==='object'){
merged[field]={
...(old[field]||{}),
...patch[field]
};
}}

all[key]=merged;
saveSharedIntel(all);
}

function loadBadgeGoals(){
try{
const raw=JSON.parse(localStorage.getItem(KEYS.badgeGoals)||'{}');
return raw&&typeof raw==='object'?raw:{};
}catch{return{};}
}

function saveBadgeGoals(goals){
try{localStorage.setItem(KEYS.badgeGoals,JSON.stringify(goals));}catch{}
}

function setBadgeGoal(appid,targetLevel,gameName=''){
if(!appid)return;
const goals=loadBadgeGoals();
const key=String(appid);

if(targetLevel===null||targetLevel===undefined||targetLevel===''){
delete goals[key];
saveBadgeGoals(goals);
return;
}

const target=Math.max(0,Math.min(CFG.normalBadgeMaxLevel,Math.trunc(Number(targetLevel))));
if(!Number.isFinite(target))return;
goals[key]={
targetLevel:target,
gameName:clean(gameName),
updatedAt:Date.now(),
source:'badge-watcher'
};
saveBadgeGoals(goals);
}

function resolveBadgeGoal(group){
const maxLevel=CFG.normalBadgeMaxLevel;
const current=Math.max(0,Math.min(maxLevel,Math.trunc(Number(group?.badgeLevel)||0)));

if(group?.badgeMaxed||current>=maxLevel){
return{
status:'MAXED',
confirmed:true,
source:'badge-level',
currentLevel:current,
targetLevel:maxLevel,
remainingCrafts:0,
label:`Level ${maxLevel}/5 erreicht`
};
}

const stored=loadBadgeGoals()[String(group?.gameAppId||'')];
const rawTarget=Number(stored?.targetLevel);

if(Number.isInteger(rawTarget)&&rawTarget>=0&&rawTarget<=maxLevel){
const target=Math.max(current,rawTarget);
const reached=rawTarget<=current;
return{
status:reached?'REACHED':'EXPLICIT',
confirmed:true,
source:'saved-goal',
currentLevel:current,
targetLevel:target,
remainingCrafts:Math.max(0,target-current),
savedTargetLevel:rawTarget,
updatedAt:stored.updatedAt||null,
label:reached?`Ziel Level ${rawTarget}/5 erreicht`:`Ziel Level ${target}/5`
};
}

const protectiveTarget=CFG.protectFutureCopiesWhenGoalUnknown
?maxLevel
:Math.min(maxLevel,current+1);

return{
status:'UNDECIDED',
confirmed:false,
source:'protective-default',
currentLevel:current,
targetLevel:protectiveTarget,
remainingCrafts:Math.max(0,protectiveTarget-current),
savedTargetLevel:null,
updatedAt:null,
label:`Ziel ungeklärt – vorsorglich bis Level ${protectiveTarget}/5 schützen`
};
}

function badgeReservePlan(group,totalPositionCopies){
const total=Math.max(0,Math.trunc(Number(totalPositionCopies)||0));
const goal=group?.badgeGoal||resolveBadgeGoal(group);
const remainingCrafts=Math.max(0,Math.trunc(Number(goal.remainingCrafts)||0));
const reserveCapacity=remainingCrafts*Math.max(1,Math.trunc(Number(CFG.targetCopiesPerCard)||1));
const plannedReserveCopies=Math.min(total,reserveCapacity);
const currentCraftReserveCopies=remainingCrafts>0
?Math.min(total,CFG.targetCopiesPerCard)
:0;
const futureCraftReserveCopies=Math.max(0,plannedReserveCopies-currentCraftReserveCopies);

return{
goal,
remainingCrafts,
reserveCapacity,
plannedReserveCopies,
currentCraftReserveCopies,
futureCraftReserveCopies,
trueSurplusCopies:Math.max(0,total-plannedReserveCopies)
};
}

function hashFromUrl(url){
const match=String(url||'').match(/\/market\/listings\/753\/(.+?)(?:\?|#|$)/);
if(!match?.[1])return null;

try{
return decodeURIComponent(match[1]);
}catch{
return match[1];
}}

function gameAppIdFromHash(hash){
return String(hash||'').match(/^(\d+)-/)?.[1]||null;
}

function marketUrl(hash){
return`https://steamcommunity.com/market/listings/${CFG.marketAppId}/${encodeURIComponent(hash)}`;
}

function isFoilMarketHash(hash){
return /\(Foil(?: Trading Card)?\)/i.test(String(hash||''));
}

function isTradingCardMarketHash(hash){
return /^\d+-.+/.test(String(hash||'')) && /\((?:Foil )?Trading Card\)$/i.test(String(hash||''));
}

function normalizedMarketMonth(value){
return String(value||'')
.normalize('NFKD')
.replace(/[\u0300-\u036f]/g,'')
.replace(/[^a-z]/gi,'')
.toLowerCase();
}

function marketMonthIndex(value){
const token=normalizedMarketMonth(value);
const aliases={
jan:0,january:0,januar:0,
feb:1,february:1,februar:1,
mar:2,march:2,marz:2,maerz:2,mrz:2,
apr:3,april:3,
may:4,mai:4,
jun:5,june:5,juni:5,
jul:6,july:6,juli:6,
aug:7,august:7,
sep:8,sept:8,september:8,
oct:9,october:9,okt:9,oktober:9,
nov:10,november:10,
dec:11,december:11,dez:11,dezember:11
};
return Object.prototype.hasOwnProperty.call(aliases,token)?aliases[token]:null;
}

function parseSteamMarketDateParts(value){
const text=clean(value);
if(!text)return null;
const now=new Date();
if(/\b(?:tomorrow|morgen)\b/i.test(text)){
const tomorrow=new Date(Date.now()+86400000);
return{year:tomorrow.getUTCFullYear(),month:tomorrow.getUTCMonth(),day:tomorrow.getUTCDate(),explicitYear:true};
}
if(/\b(?:today|heute)\b/i.test(text)){
return{year:now.getUTCFullYear(),month:now.getUTCMonth(),day:now.getUTCDate(),explicitYear:true};
}
let year=null;
let month=null;
let day=null;
let explicitYear=false;
let match=text.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
if(match){year=Number(match[1]);month=Number(match[2])-1;day=Number(match[3]);explicitYear=true;}
if(!match){
match=text.match(/(?:^|\s)(\d{1,2})\.(\d{1,2})\.(?:\s*(\d{2,4}))?(?:\s|$)/);
if(match){day=Number(match[1]);month=Number(match[2])-1;year=match[3]?Number(match[3]):now.getFullYear();explicitYear=Boolean(match[3]);}
}
if(!match){
match=text.match(/(?:^|\s)(\d{1,2})\.?\s+([A-Za-zÀ-ÿ]{3,12})\.?(?:,?\s+(\d{2,4}))?(?:\s|$)/);
if(match){day=Number(match[1]);month=marketMonthIndex(match[2]);year=match[3]?Number(match[3]):now.getFullYear();explicitYear=Boolean(match[3]);}
}
if(!match){
match=text.match(/(?:^|\s)([A-Za-zÀ-ÿ]{3,12})\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{2,4}))?(?:\s|$)/i);
if(match){month=marketMonthIndex(match[1]);day=Number(match[2]);year=match[3]?Number(match[3]):now.getFullYear();explicitYear=Boolean(match[3]);}
}
if(!match||month===null||!Number.isInteger(month)||month<0||month>11||!Number.isInteger(day)||day<1||day>31||!Number.isFinite(year))return null;
if(year<100)year+=2000;
const ts=Date.UTC(year,month,day,12,0,0);
const check=new Date(ts);
if(check.getUTCFullYear()!==year||check.getUTCMonth()!==month||check.getUTCDate()!==day)return null;
return{year,month,day,explicitYear};
}

function parseMarketListedDate(value){
const parts=parseSteamMarketDateParts(value);
if(!parts)return null;
let ts=Date.UTC(parts.year,parts.month,parts.day,12,0,0);
if(!parts.explicitYear&&ts>Date.now()+2*86400000)ts=Date.UTC(parts.year-1,parts.month,parts.day,12,0,0);
return ts;
}

function parseFutureMarketDate(value){
const parts=parseSteamMarketDateParts(value);
if(!parts)return null;
let ts=Date.UTC(parts.year,parts.month,parts.day,12,0,0);
if(!parts.explicitYear&&ts<Date.now()-2*86400000)ts=Date.UTC(parts.year+1,parts.month,parts.day,12,0,0);
return ts;
}

function listingStateFromContext(value,{allowActive=false}={}){
const text=clean(value);
if(!text)return null;
if(/(?:awaiting|pending|needs?)\s+(?:mobile\s+)?confirmation|confirm\s+(?:this\s+)?listing|confirmation[_\s-]*(?:required|pending)|best[aä]tigung\s+ausstehend|muss\s+best[aä]tigt|angebot\s+best[aä]tigen/i.test(text))return'AWAITING_CONFIRMATION';
if(/market[_\s-]*hold|on[_\s-]*hold|held[_\s-]*(?:listings?|until)|hold[_\s-]*(?:listings?|until|date)|will\s+be\s+held|being\s+held|hold\s+for\s+\d+|available\s+(?:on|after)|will\s+be\s+(?:listed|available)|zur[uü]ckgehalten(?:e[nrms]?|\s+bis)?|haltefrist|verf[uü]gbar\s+ab/i.test(text))return'MARKET_HOLD';
if(allowActive&&/my\s+active\s+listings?|my\s+listings\s*\(|date\s+listed|listed\s+on|meine\s+aktiven\s+angebote|meine\s+verkaufsangebote|eingestellt\s+am/i.test(text))return'ACTIVE';
return null;
}

function inferSellListingSectionState(row){
let cursor=row;
for(let depth=0;cursor&&depth<8;depth++,cursor=cursor.parentElement){
const structural=clean([cursor.id,cursor.className,cursor.getAttribute?.('data-state'),cursor.getAttribute?.('data-status')].join(' '));
const structuralState=listingStateFromContext(structural);
if(structuralState)return{listingState:structuralState,source:'ancestor-structure',evidence:structural.slice(0,300)};
}
const ownText=clean(row?.textContent||'');
const ownState=listingStateFromContext(ownText);
if(ownState)return{listingState:ownState,source:'row-text',evidence:ownText.slice(0,300)};
cursor=row;
for(let depth=0;cursor&&depth<8;depth++,cursor=cursor.parentElement){
let sibling=cursor.previousElementSibling;
for(let checked=0;sibling&&checked<40;checked++,sibling=sibling.previousElementSibling){
if(/^mylisting_/i.test(String(sibling.id||'')))continue;
const structural=clean([sibling.id,sibling.className,sibling.getAttribute?.('data-state'),sibling.getAttribute?.('data-status')].join(' '));
const structuralState=listingStateFromContext(structural,{allowActive:true});
if(structuralState)return{listingState:structuralState,source:'preceding-structure',evidence:structural.slice(0,300)};
const text=clean(sibling.textContent||'');
if(!text||text.length>2500)continue;
const textState=listingStateFromContext(text,{allowActive:true});
if(textState)return{listingState:textState,source:'preceding-section-label',evidence:text.slice(0,300)};
}
}
return null;
}

function sellListingStateInfo(row,listedDateText='',sectionHint=null){
const statusText=clean(row?.textContent||'');
const structuralParts=[];
let cursor=row;
for(let depth=0;cursor&&depth<6;depth++,cursor=cursor.parentElement)structuralParts.push(cursor.id,cursor.className,cursor.getAttribute?.('data-state'),cursor.getAttribute?.('data-status'));
const structuralText=clean(structuralParts.join(' '));
const directState=listingStateFromContext(`${statusText} ${structuralText}`);
const inferred=sectionHint||inferSellListingSectionState(row);
const listingState=directState||inferred?.listingState||'ACTIVE';
const awaitingConfirmation=listingState==='AWAITING_CONFIRMATION';
const marketHold=listingState==='MARKET_HOLD';
const evidence=clean(inferred?.evidence||'');
const holdTimestamp=marketHold?parseFutureMarketDate(listedDateText)||parseFutureMarketDate(statusText)||parseFutureMarketDate(evidence):null;
return{
listingState,
needConfirmation:awaitingConfirmation,
marketHold,
holdUntil:holdTimestamp?new Date(holdTimestamp).toISOString():null,
holdRemainingDays:holdTimestamp?Math.max(0,round2((holdTimestamp-Date.now())/86400000)):null,
stateDetectionSource:directState?'row-or-structure':inferred?.source||'default-active',
stateDetectionEvidence:(directState?statusText:evidence).slice(0,300),
statusText:listingState==='ACTIVE'?'':clean(`${statusText} ${evidence}`).slice(0,600)
};
}

function firstCountMatch(text,patterns){
for(const pattern of patterns){
const match=String(text||'').match(pattern);
if(match?.[1])return parseCount(match[1]);
}
return null;
}

function extractMarketOverviewSellCounts(doc){
const text=clean(doc?.body?.textContent||'');
const activeNode=doc?.querySelector?.('#tabContentsMyActiveMarketListings_total');
const activeFromNode=activeNode?parseCount(activeNode.textContent):null;
return{
active:activeFromNode??firstCountMatch(text,[/my\s+active\s+listings\s*\(([\d.,]+)\)/i,/meine\s+aktiven\s+angebote\s*\(([\d.,]+)\)/i,/meine\s+verkaufsangebote\s*\(([\d.,]+)\)/i]),
hold:firstCountMatch(text,[/([\d.,]+)\s+(?:sell\s+)?listings?\s+(?:(?:are\s+)?(?:being\s+)?held|on[-\s]?hold)\b/i,/my\s+(?:(?:held|on[-\s]?hold)\s+(?:sell\s+)?listings?|(?:sell\s+)?listings?\s+on[-\s]?hold)\s*\(([\d.,]+)\)/i,/([\d.,]+)\s+verkaufsangebote\s+werden\s+zur[uü]ckgehalten/i,/meine\s+zur[uü]ckgehaltenen\s+verkaufsangebote\s*\(([\d.,]+)\)/i]),
awaiting:firstCountMatch(text,[/([\d.,]+)\s+(?:sell\s+)?listings?\s+(?:are\s+)?awaiting\s+confirmation/i,/my\s+(?:unconfirmed|pending)\s+(?:sell\s+)?listings?\s*\(([\d.,]+)\)/i,/([\d.,]+)\s+verkaufsangebote\s+(?:warten|ben[oö]tigen)\s+(?:auf\s+)?best[aä]tigung/i])
};
}

function extractSellListingAssetMap(html){
const map=new Map();
const text=String(html||'');
const regex=/CreateItemHoverFromContainer\(\s*[\w$]+,\s*['"]mylisting_(\d+)_.*?['"],\s*(\d+),\s*['"](\d+)['"],\s*['"](\d+)['"]/g;
let match;
while((match=regex.exec(text))){
map.set(String(match[1]),{appid:String(match[2]),contextid:String(match[3]),assetid:String(match[4])});
}
return map;
}

function assetDescriptionFromTree(assets,address){
if(!assets||!address)return null;
const app=assets?.[address.appid]||assets?.[Number(address.appid)]||null;
const context=app?.[address.contextid]||app?.[Number(address.contextid)]||null;
return context?.[address.assetid]||context?.[Number(address.assetid)]||null;
}

function genericMarketDescriptionInfo(description, fallbackHash=null){
const hash=clean(description?.market_hash_name||fallbackHash||'')||null;
const itemClass=tagByCategory(description,'item_class');
const border=tagByCategory(description,'cardborder');
const gameTag=(Array.isArray(description?.tags)?description.tags:[]).find(tag=>/^app_\d+$/.test(String(tag?.internal_name||'')))||tagByCategory(description,'Game');
const typeText=clean(description?.type||'');
const isTradingCard=itemClass?.internal_name==='item_class_2'||/(?:Steam\s+)?Trading Card|Sammelkarte/i.test(typeText)||isTradingCardMarketHash(hash);
const isFoil=border?.internal_name==='cardborder_1'||/\bFoil\b|Glanz/i.test(typeText)||isFoilMarketHash(hash);
const tagAppId=String(gameTag?.internal_name||'').match(/^app_(\d+)$/)?.[1]||null;
const feeAppId=/^\d+$/.test(String(description?.market_fee_app||''))?String(description.market_fee_app):null;
const gameAppId=gameAppIdFromHash(hash)||tagAppId||feeAppId;
const gameName=clean(gameTag?.localized_tag_name||'')||(gameAppId?`App ${gameAppId}`:'Andere Marktobjekte');
const itemName=clean(description?.market_name||description?.name||'')||(hash?nameFromHash(hash,gameAppId):'Unbekanntes Marktobjekt');
return{hash,itemName,gameAppId,gameName,isTradingCard,isFoil};
}

function parseSellListingRows(html,assets=null,hovers='',listingSource='sell-endpoint'){
const doc=new DOMParser().parseFromString(String(html||''),'text/html');
const assetMap=extractSellListingAssetMap(`${html||''}\n${hovers||''}`);
const rows=[...doc.querySelectorAll('div[id^="mylisting_"]')];
const listings=[];
for(const row of rows){
const listingId=String(row.id||'').replace(/^mylisting_/,'').split('_')[0];
if(!listingId)continue;
const link=row.querySelector('a[href*="/market/listings/"]');
let hash=hashFromUrl(link?.href);
const address=assetMap.get(listingId)||null;
const description=assetDescriptionFromTree(assets,address);
if(address?.appid&&String(address.appid)!==String(CFG.marketAppId))continue;
const info=genericMarketDescriptionInfo(description,hash);
hash=hash||info.hash;
if(!hash)continue;
const titleSpans=[...row.querySelectorAll('span[title]')].filter(span=>moneyToCents(span.textContent)!==null);
const priceElement=row.querySelector('.market_listing_price');
const priceText=clean(priceElement?.textContent||'');
const priceValues=[...priceText.matchAll(/(\d+[.,]\d{1,2})/g)].map(match=>Math.round(Number(match[1].replace(',','.'))*100)).filter(Number.isFinite);
const buyerPayCents=moneyToCents(titleSpans[0]?.textContent||'')??priceValues[0]??null;
const sellerReceivesCents=moneyToCents(titleSpans[1]?.textContent||'')??priceValues[1]??null;
const sectionHint=inferSellListingSectionState(row);
let listedDateText=clean(row.querySelector('.market_listing_listed_date,[class*="hold"][class*="date"],[class*="held"][class*="date"]')?.textContent||'');
if(!listedDateText&&sectionHint?.listingState==='MARKET_HOLD'){
const dateCandidate=[...row.querySelectorAll('span,div')]
.map(node=>clean(node.textContent||''))
.filter(text=>text&&text.length<=48&&parseFutureMarketDate(text))[0];
listedDateText=dateCandidate||'';
}
const listingStateInfo=sellListingStateInfo(row,listedDateText,sectionHint);
const listedAt=listingStateInfo.listingState==='ACTIVE'?parseMarketListedDate(listedDateText):null;
const rawGameLabel=clean(row.querySelector('.market_listing_game_name')?.textContent||row.querySelector('.market_listing_game_name_link')?.textContent||'');
const itemName=clean(row.querySelector('.market_listing_item_name_link')?.textContent||row.querySelector('.market_listing_item_name')?.textContent||link?.textContent||info.itemName||nameFromHash(hash,info.gameAppId));
const gameName=rawGameLabel.replace(/-Sammelkarte$/i,'').replace(/ Trading Card$/i,'')||info.gameName||(info.gameAppId?`App ${info.gameAppId}`:'Andere Marktobjekte');
const likelyTradingCard=info.isTradingCard||/(?:sammelkarte|trading card)/i.test(rawGameLabel)||isTradingCardMarketHash(hash);
listings.push({
listingId,
itemName,
gameName,
rawGameLabel,
likelyTradingCard,
isFoil:Boolean(info.isFoil),
gameAppId:info.gameAppId||gameAppIdFromHash(hash),
marketHashName:hash,
marketUrl:marketUrl(hash),
buyerPayCents,
buyerPay:euro(buyerPayCents),
sellerReceivesCents,
sellerReceives:euro(sellerReceivesCents),
listedDateText,
listedAt:listedAt?new Date(listedAt).toISOString():null,
listedAgeDays:listedAt?round2((Date.now()-listedAt)/86400000):null,
listingState:listingStateInfo.listingState,
needConfirmation:listingStateInfo.needConfirmation,
marketHold:listingStateInfo.marketHold,
holdUntil:listingStateInfo.holdUntil,
holdRemainingDays:listingStateInfo.holdRemainingDays,
listingStatusText:listingStateInfo.statusText,
listingSource,
stateDetectionSource:listingStateInfo.stateDetectionSource,
stateDetectionEvidence:listingStateInfo.stateDetectionEvidence,
assetAddress:address
});
}
return listings;
}

function sellListingStatePriority(listing){
return listing?.listingState==='AWAITING_CONFIRMATION'?3:listing?.listingState==='MARKET_HOLD'?2:1;
}

function mergeSellListings(listings){
const byId=new Map();
for(const listing of listings||[]){
if(!listing?.listingId)continue;
const key=String(listing.listingId);
const previous=byId.get(key);
if(!previous){byId.set(key,listing);continue;}
const incomingWins=sellListingStatePriority(listing)>sellListingStatePriority(previous)
||(sellListingStatePriority(listing)===sellListingStatePriority(previous)&&listing.listingSource==='market-overview-live');
const primary=incomingWins?listing:previous;
const fallback=incomingWins?previous:listing;
byId.set(key,{
...fallback,
...primary,
itemName:primary.itemName||fallback.itemName,
gameName:primary.gameName||fallback.gameName,
rawGameLabel:primary.rawGameLabel||fallback.rawGameLabel,
gameAppId:primary.gameAppId||fallback.gameAppId,
marketHashName:primary.marketHashName||fallback.marketHashName,
marketUrl:primary.marketUrl||fallback.marketUrl,
buyerPayCents:primary.buyerPayCents??fallback.buyerPayCents??null,
buyerPay:primary.buyerPayCents!==null&&primary.buyerPayCents!==undefined?primary.buyerPay:fallback.buyerPay,
sellerReceivesCents:primary.sellerReceivesCents??fallback.sellerReceivesCents??null,
sellerReceives:primary.sellerReceivesCents!==null&&primary.sellerReceivesCents!==undefined?primary.sellerReceives:fallback.sellerReceives,
listedDateText:primary.listedDateText||fallback.listedDateText,
holdUntil:primary.holdUntil||fallback.holdUntil,
holdRemainingDays:primary.holdRemainingDays??fallback.holdRemainingDays??null,
assetAddress:primary.assetAddress||fallback.assetAddress,
listingSources:[...new Set([...(previous.listingSources||[previous.listingSource]),...(listing.listingSources||[listing.listingSource])].filter(Boolean))]
});
}
return[...byId.values()];
}

function mergeExpectedSellCounts(...counts){
const result={active:null,hold:null,awaiting:null};
for(const key of Object.keys(result)){
const values=counts.map(item=>finiteNumber(item?.[key])).filter(value=>value!==null&&value>=0);
if(values.length)result[key]=Math.max(...values);
}
return result;
}

async function loadAllSellListings(){
if(!CFG.scanActiveSellListings)return[];
const all=[];
const sourceRows={overviewFetched:0,overviewLive:0,endpoint:0};
let overviewCounts={active:null,hold:null,awaiting:null};
let liveCounts={active:null,hold:null,awaiting:null};
let endpointTotal=null;
let endpointError=null;

if(CFG.scanMarketOverviewSellListings&&STATE.marketOverviewHtml){
try{
const overviewDoc=new DOMParser().parseFromString(STATE.marketOverviewHtml,'text/html');
overviewCounts=extractMarketOverviewSellCounts(overviewDoc);
const rows=parseSellListingRows(STATE.marketOverviewHtml,null,'','market-overview-fetched');
sourceRows.overviewFetched=rows.length;
all.push(...rows);
}catch(error){endpointError=`Marktübersicht konnte nicht vollständig ausgewertet werden: ${String(error?.message||error)}`;}
}

if(CFG.scanMarketOverviewSellListings&&/^\/market\/?$/i.test(location.pathname||'')){
try{
const liveHtml=document.documentElement?.outerHTML||'';
const liveDoc=new DOMParser().parseFromString(liveHtml,'text/html');
liveCounts=extractMarketOverviewSellCounts(liveDoc);
const rows=parseSellListingRows(liveHtml,null,'','market-overview-live');
sourceRows.overviewLive=rows.length;
all.push(...rows);
}catch(error){
const message=`Sichtbare Marktübersicht konnte nicht vollständig ausgewertet werden: ${String(error?.message||error)}`;
endpointError=endpointError?`${endpointError} · ${message}`:message;
}
}

let start=0;
let total=null;
let guard=0;
try{while(guard++<100){
if(STATE.stopRequested)break;
const count=CFG.sellListingsPageSize;
const url=new URL('https://steamcommunity.com/market/mylistings/render/');
url.searchParams.set('query','');
url.searchParams.set('start',String(start));
url.searchParams.set('count',String(count));
url.searchParams.set('l',CFG.language);
url.searchParams.set('_sbw',String(Date.now()));
const response=await pacedFetch(url.toString(),{headers:{Accept:'application/json,text/plain,*/*'}},'sellListingPage','Aktive Verkaufsangebote');
const raw=await response.text();
if(raw.trimStart().startsWith('<'))throw new Error('Aktive Verkaufsangebote: HTML statt JSON.');
const data=JSON.parse(raw);
if(data?.success!==true&&data?.success!==1)throw new Error('Aktive Verkaufsangebote konnten nicht gelesen werden.');
const parsed=parseSellListingRows(data.results_html||'',data.assets||null,data.hovers||'','sell-endpoint');
sourceRows.endpoint+=parsed.length;
all.push(...parsed);
const pageSize=Math.max(1,Number(data.pagesize||count)||count);
total=Number(data.total_count??total??0);
endpointTotal=Number.isFinite(total)?Math.max(0,total):endpointTotal;
start+=pageSize;
if(Number.isFinite(total)&&start>=total)break;
if(!Number.isFinite(total)&&parsed.length<pageSize)break;
}}catch(error){
const message=`Aktive Verkaufsangebote-Endpunkt unvollständig: ${String(error?.message||error)}`;
endpointError=endpointError?`${endpointError} · ${message}`:message;
}

const merged=mergeSellListings(all);
if(!merged.length&&endpointError)throw new Error(endpointError);
const detected=sellListingStateCounts(merged);
const expected=mergeExpectedSellCounts(overviewCounts,liveCounts,{active:endpointTotal});
const coverageWarnings=[];
for(const[state,label]of[['active','aktive'],['hold','zurückgehaltene'],['awaiting','unbestätigte']]){
if(expected[state]!==null&&detected[state]<expected[state])coverageWarnings.push(`Steam meldet ${expected[state]} ${label} Verkaufsangebot(e), erkannt wurden ${detected[state]}.`);
}
if(endpointError)coverageWarnings.push(endpointError);
STATE.sellListingCoverage={
expected,
detected,
sourceRows,
overviewFetched:Boolean(STATE.marketOverviewHtml),
endpointTotal,
complete:coverageWarnings.length===0,
warnings:coverageWarnings
};
STATE.sellListingWarning=coverageWarnings.length?coverageWarnings.join(' '):null;
return merged;
}

function sellListingStateCounts(listings=STATE.sellListings){
const rows=Array.isArray(listings)?listings:[];
return{
total:rows.length,
active:rows.filter(listing=>(listing.listingState||'ACTIVE')==='ACTIVE').length,
hold:rows.filter(listing=>listing.listingState==='MARKET_HOLD').length,
awaiting:rows.filter(listing=>listing.listingState==='AWAITING_CONFIRMATION').length
};
}

function loadSellWatch(){
try{
const current=localStorage.getItem(KEYS.sellWatch);
const legacy=!current&&KEYS.sellWatchLegacy?localStorage.getItem(KEYS.sellWatchLegacy):null;
const raw=JSON.parse(current||legacy||'{}');
const cutoff=Date.now()-CFG.sellTrackingKeepDays*86400000;
const cleaned={};
for(const[id,value]of Object.entries(raw))if(Number(value?.lastSeen||0)>=cutoff)cleaned[id]=value;
return cleaned;
}catch{return{};}
}

function updateSellWatch(listings){
const watch=loadSellWatch();
const now=Date.now();
const activeIds=new Set(listings.map(x=>String(x.listingId)));
for(const listing of listings){
const id=String(listing.listingId);
const old=watch[id];
const changed=old&&old.lastBuyerPayCents!==listing.buyerPayCents;
const state=listing.listingState||'ACTIVE';
const previousState=old?.lastState||null;
const stateChanged=Boolean(previousState&&previousState!==state);
const inheritedActiveStart=!previousState&&state==='ACTIVE'?old?.firstSeen:null;
watch[id]={
firstSeen:old?.firstSeen||now,
lastSeen:now,
observations:(old?.observations||0)+1,
lastBuyerPayCents:listing.buyerPayCents,
priceChanges:(old?.priceChanges||0)+(changed?1:0),
marketHashName:listing.marketHashName,
lastState:state,
stateChangedAt:stateChanged?now:(old?.stateChangedAt||old?.firstSeen||now),
firstActiveSeen:state==='ACTIVE'?(old?.firstActiveSeen||inheritedActiveStart||now):(old?.firstActiveSeen||null),
firstPendingSeen:state!=='ACTIVE'?(old?.firstPendingSeen||now):(old?.firstPendingSeen||null),
lastHoldUntil:listing.holdUntil||old?.lastHoldUntil||null
};
}
const cutoff=now-CFG.sellTrackingKeepDays*86400000;
for(const[id,value]of Object.entries(watch))if(!activeIds.has(id)&&Number(value?.lastSeen||0)<cutoff)delete watch[id];
try{localStorage.setItem(KEYS.sellWatch,JSON.stringify(watch));}catch{}
return watch;
}

function sellWatchInfoFor(listing,watch){
const item=watch?.[String(listing?.listingId)];
const observedDays=item?round2((Date.now()-item.firstSeen)/86400000):null;
const state=listing?.listingState||item?.lastState||'ACTIVE';
const isActive=state==='ACTIVE';
const actualAge=isActive&&Number.isFinite(Number(listing?.listedAgeDays))?Number(listing.listedAgeDays):null;
const activeObservedDays=isActive&&item?.firstActiveSeen?round2((Date.now()-item.firstActiveSeen)/86400000):null;
const holdUntil=listing?.holdUntil||item?.lastHoldUntil||null;
const holdTs=holdUntil?Date.parse(holdUntil):NaN;
const holdRemainingDays=Number.isFinite(holdTs)?Math.max(0,round2((holdTs-Date.now())/86400000)):(listing?.holdRemainingDays??null);
return{
firstSeen:item?new Date(item.firstSeen).toISOString():null,
lastSeen:item?new Date(item.lastSeen).toISOString():null,
observedDays,
listingState:state,
stateChangedAt:item?.stateChangedAt?new Date(item.stateChangedAt).toISOString():null,
firstActiveSeen:item?.firstActiveSeen?new Date(item.firstActiveSeen).toISOString():null,
activeObservedDays,
actualListedAgeDays:actualAge,
ageDays:isActive?(actualAge??activeObservedDays):null,
ageSource:!isActive?'not-active':actualAge!==null?'steam-listed-date':'active-watcher-observation',
holdUntil,
holdRemainingDays,
observations:item?.observations||0,
priceChangesObserved:item?.priceChanges||0,
note:state==='AWAITING_CONFIRMATION'
?'Steam-Bestätigung steht aus; noch keine normale aktive Sell-Queue und kein aktives Verkaufsalter.'
:state==='MARKET_HOLD'
?'Steam hält das Angebot zurück; Hold-Zeit wird nicht als aktive Sell-Queue oder aktives Verkaufsalter gewertet.'
:actualAge!==null
?'Aktives Alter aus Steams Listing-Datum; Beobachtungsdaten dienen zusätzlich als Fallback.'
:'Steam-Listing-Datum nicht sicher parsebar; aktives Alter seit erster aktiver Wächter-Beobachtung.'
};
}

function assignSellListingsToBadgeCards(cards,listings){
const assignments=new Map();
const matchedListingIds=new Set();
for(let i=0;i<cards.length;i++)assignments.set(i,[]);
for(const listing of listings){
if(listing.isFoil)continue;
let index=cards.findIndex(card=>card.marketHashFromBadge&&card.marketHashFromBadge===listing.marketHashName);
if(index<0){
const wanted=normalizeName(nameFromHash(listing.marketHashName,listing.gameAppId));
const exact=cards.map((card,i)=>({i,n:normalizeName(card.badgeName)})).filter(x=>x.n===wanted);
if(exact.length===1)index=exact[0].i;
}
if(index>=0){assignments.get(index).push(listing);matchedListingIds.add(String(listing.listingId));}
}
return{assignments,matchedListingIds};
}

function detectProfileBase(){
try{
const globalUrl=window.g_rgProfileData?.url;

if(globalUrl){
const match=String(globalUrl).match(
/^(https:\/\/steamcommunity\.com\/(?:id\/[^/]+|profiles\/\d+))\/?/i
);

if(match?.[1])return match[1];
}
}catch{}

const hrefs=[
document.querySelector('#global_actions a.user_avatar')?.href,
document.querySelector('a[href*="steamcommunity.com/id/"]')?.href,
document.querySelector('a[href*="steamcommunity.com/profiles/"]')?.href
].filter(Boolean);

for(const href of hrefs){
const match=String(href).match(
/^(https:\/\/steamcommunity\.com\/(?:id\/[^/]+|profiles\/\d+))\/?/i
);

if(match?.[1])return match[1];
}

return null;
}

function steamId64Candidate(value){
const text=clean(value);
return/^\d{17}$/.test(text)?text:null;
}

async function resolveSteamId64(){
const directCandidates=[];

try{
directCandidates.push(
window.g_steamID,
window.g_steamID64,
window.g_rgProfileData?.steamid
);
}catch{}

for(const candidate of directCandidates){
const resolved=steamId64Candidate(candidate);
if(resolved)return resolved;
}

if(!STATE.profileBase){
throw new Error('SteamID64 konnte nicht ermittelt werden: Profilbasis fehlt.');
}

const url=new URL(`${STATE.profileBase}/`);
url.searchParams.set('l',CFG.language);
url.searchParams.set('_sbw',String(Date.now()));

const response=await pacedFetch(
url.toString(),
{headers:{Accept:'text/html,application/xhtml+xml'}},
'profile',
'Profil-ID'
);

const html=await response.text();

for(const pattern of[
/"steamid"\s*:\s*"(\d{17})"/i,
/g_steamID\s*=\s*["'](\d{17})["']/i,
/g_steamID64\s*=\s*["'](\d{17})["']/i,
/<steamID64>\s*(\d{17})\s*<\/steamID64>/i
]){
const match=html.match(pattern);
const resolved=steamId64Candidate(match?.[1]);

if(resolved)return resolved;
}

throw new Error('SteamID64 konnte aus deinem Profil nicht sicher ermittelt werden.');
}

function inventoryDescriptionKey(classid,instanceid){
return`${String(classid||'')}_${String(instanceid||'0')}`;
}

function tagByCategory(description,category){
const wanted=String(category||'').toLowerCase();

return(
(Array.isArray(description?.tags)?description.tags:[])
.find(tag=>String(tag?.category||'').toLowerCase()===wanted)
||null
);
}

function normalTradingCardAppInfo(description){
if(!description)return null;

const itemClass=tagByCategory(description,'item_class');
const border=tagByCategory(description,'cardborder');

const gameTag=
(Array.isArray(description.tags)?description.tags:[])
.find(tag=>/^app_\d+$/.test(String(tag?.internal_name||'')))
||tagByCategory(description,'Game');

const typeText=clean(description.type);

const isTradingCard=
itemClass?.internal_name==='item_class_2'||
/(?:Steam\s+)?Trading Card|Sammelkarte/i.test(typeText);

if(!isTradingCard)return null;

const isFoil=
border?.internal_name==='cardborder_1'||
/\bFoil\b|Glanz/i.test(typeText);

if(isFoil)return null;

const tagAppId=
String(gameTag?.internal_name||'').match(/^app_(\d+)$/)?.[1]||null;

const feeAppId=
/^\d+$/.test(String(description.market_fee_app||''))
?String(description.market_fee_app)
:null;

const gameAppId=tagAppId||feeAppId;

if(!gameAppId||gameAppId===String(CFG.marketAppId)){
return null;
}

const gameName=
clean(gameTag?.localized_tag_name||'')||
`App ${gameAppId}`;

const marketHashName=
clean(description.market_hash_name||'')||
null;

const cardName=
clean(description.market_name||description.name||'')||
marketHashName||
'Unbekannte Sammelkarte';

return{
gameAppId,
gameName,
cardName,
marketHashName,
marketable:Number(description.marketable||0)===1,
tradable:Number(description.tradable??1)===1
};
}

async function loadOwnedNormalTradingCardApps(){
if(!CFG.discoverOwnedCardSets)return new Map();

const steamId64=await resolveSteamId64();
STATE.steamId64=steamId64;

const apps=new Map();
let startAssetId=null;
let page=0;

while(true){
if(STATE.stopRequested)break;

page++;

updateMainStatus(
`Eigenes Steam-Inventar wird nach normalen Sammelkarten durchsucht … Seite ${page}`
);

const url=new URL(
`https://steamcommunity.com/inventory/${steamId64}/753/6`
);

url.searchParams.set('l',CFG.language);
url.searchParams.set('count',String(CFG.inventoryPageSize));

if(startAssetId){
url.searchParams.set('start_assetid',startAssetId);
}

const response=await pacedFetch(
url.toString(),
{headers:{Accept:'application/json,text/plain,*/*'}},
'inventory',
'Eigenes Sammelkarten-Inventar'
);

const raw=await response.text();

if(raw.trimStart().startsWith('<')){
throw new Error('Inventar lieferte HTML statt JSON.');
}

const data=JSON.parse(raw);

if(Number(data?.success)!==1){
throw new Error('Steam-Inventar konnte nicht erfolgreich gelesen werden.');
}

const descriptions=new Map();

for(const description of Array.isArray(data.descriptions)?data.descriptions:[]){
descriptions.set(
inventoryDescriptionKey(description.classid,description.instanceid),
description
);
}

for(const asset of Array.isArray(data.assets)?data.assets:[]){
const description=descriptions.get(
inventoryDescriptionKey(asset.classid,asset.instanceid)
);

const info=normalTradingCardAppInfo(description);
if(!info)continue;

const amount=Math.max(1,Number(asset.amount||1)||1);

const old=apps.get(info.gameAppId)||{
gameAppId:info.gameAppId,
gameName:info.gameName,
ownedInventoryCopies:0,
inventoryCards:[],
source:'steam-inventory-normal-trading-card'
};

if(!old.gameName||/^App \d+$/.test(old.gameName)){
old.gameName=info.gameName;
}

old.ownedInventoryCopies+=amount;

const cardKey=
info.marketHashName||
normalizeName(info.cardName)||
inventoryDescriptionKey(asset.classid,asset.instanceid);

let inventoryCard=
old.inventoryCards.find(item=>item.key===cardKey);

if(!inventoryCard){
inventoryCard={
key:cardKey,
cardName:info.cardName,
marketHashName:info.marketHashName,
quantity:0,
marketableCopies:0,
tradableCopies:0,
classid:String(asset.classid||''),
instanceid:String(asset.instanceid||'0')
};

old.inventoryCards.push(inventoryCard);
}

inventoryCard.quantity+=amount;

if(info.marketable){
inventoryCard.marketableCopies+=amount;
}

if(info.tradable){
inventoryCard.tradableCopies+=amount;
}

apps.set(info.gameAppId,old);
}

const more=Boolean(data.more_items);
const nextAssetId=
data.last_assetid
?String(data.last_assetid)
:null;

if(!more||!nextAssetId||nextAssetId===startAssetId){
break;
}

startAssetId=nextAssetId;
}

for(const meta of apps.values()){
meta.inventoryCards=(meta.inventoryCards||[])
.map(item=>({
cardName:item.cardName,
marketHashName:item.marketHashName,
quantity:item.quantity,
marketableCopies:item.marketableCopies,
tradableCopies:item.tradableCopies,
classid:item.classid,
instanceid:item.instanceid
}))
.sort((a,b)=>
String(a.cardName||'').localeCompare(String(b.cardName||''),'de')
);
}

return apps;
}

function resetStats(){
STATE.stats={
total:0,
buyOrderPage:0,
sellListingPage:0,
profile:0,
inventory:0,
badge:0,
listing:0,
search:0,
histogram:0,
history:0,
retries:0,
rateLimits:0,
cachedItemIdsUsed:0,
itemIdsLearned:0
};
}

function gapFor(kind){
if(kind==='listing')return CFG.gapListingMs;
if(kind==='badge')return CFG.gapBadgeMs;
return CFG.gapApiMs;
}

async function pacedFetch(
url,
options={},
kind='api',
label='Steam'
){
let lastError=null;

for(let attempt=1;attempt<=CFG.maxAttempts;attempt++){
if(STATE.stopRequested){
throw new Error('Prüfung vom Benutzer gestoppt');
}

try{
const gap=gapFor(kind);
const elapsed=Date.now()-lastRequestAt;

if(elapsed<gap){
await sleep(gap-elapsed);
}

lastRequestAt=Date.now();

STATE.stats.total++;
STATE.stats[kind]=(STATE.stats[kind]||0)+1;

const response=await fetch(
url,
{
credentials:'include',
cache:'no-store',
redirect:'follow',
...options
}
);

if(response.status===429){
STATE.stats.rateLimits++;
STATE.stats.retries++;

lastError=
new Error(`${label}: HTTP 429`);

await sleep(
CFG.cooldown429Ms*
attempt
);

continue;
}

if([502,503,504].includes(response.status)){
STATE.stats.retries++;

lastError=
new Error(`${label}: HTTP ${response.status}`);

await sleep(
2500*
attempt
);

continue;
}

if(!response.ok){
throw new Error(
`${label}: HTTP ${response.status}`
);
}

return response;

}catch(error){
lastError=error;

if(attempt>=CFG.maxAttempts){
break;
}

STATE.stats.retries++;

await sleep(
1800*
attempt
);
}}

throw(
lastError||
new Error(
`${label} fehlgeschlagen`
)
);
}

async function loadAllBuyOrders(){
const previous=
getCookie(
'bMarketOptOut'
);

setCookie(
'bMarketOptOut',
'1'
);

await sleep(120);

try{
const response=
await pacedFetch(
`https://steamcommunity.com/market/?l=english&_sbw=${Date.now()}`,
{
headers:{
Accept:'text/html,application/xhtml+xml'
}
},
'buyOrderPage',
'Kaufauftragsliste'
);

const html=
await response.text();

// Dieselbe klassische Marktübersicht enthält neben den Kaufaufträgen auch
// Steam-Bereiche, die der reine /mylistings/render/-Endpunkt nicht liefert,
// insbesondere zurückgehaltene und teils noch unbestätigte Verkaufsangebote.
// Für die spätere Sell-Prüfung unverändert zwischenspeichern.
STATE.marketOverviewHtml=html;

const doc=
new DOMParser()
.parseFromString(
html,
'text/html'
);

const elements=
[
...doc.querySelectorAll(
'div[id^="mybuyorder_"]'
)
];

const orders=[];

for(const element of elements){
const link=
element.querySelector(
'a[href*="/market/listings/753/"]'
);

const priceElement=
element.querySelector(
'.market_listing_price'
);

if(!link||!priceElement){
continue;
}

const hash=
hashFromUrl(
link.href
);

if(!hash){
continue;
}

const priceText=
clean(
priceElement.textContent
);

const qtyMatch=
priceText.match(
/^\s*(\d+)\s*@/
);

const quantity=
qtyMatch
?Number(
qtyMatch[1]
)
:1;

const afterAt=
priceText.includes(
'@'
)
?priceText
.split('@')[1]
:priceText;

const priceCents=
moneyToCents(
afterAt
);

const itemName=
clean(
element
.querySelector(
'.market_listing_item_name_link'
)
?.textContent||
element
.querySelector(
'.market_listing_item_name'
)
?.textContent||
link.textContent
);

const rawGameLabel=
clean(
element
.querySelector(
'.market_listing_game_name'
)
?.textContent||
element
.querySelector(
'.market_listing_game_name_link'
)
?.textContent||
''
);

const likelyTradingCard=
/(?:sammelkarte|trading card)/i
.test(
rawGameLabel
)||
/\(Trading Card\)$/i
.test(
hash
);

const gameName=
rawGameLabel
.replace(
/-Sammelkarte$/i,
''
)
.replace(
/ Trading Card$/i,
''
)||
`App ${
gameAppIdFromHash(
hash
)||
'?'
}`;

orders.push({
orderId:
element.id
.replace(
'mybuyorder_',
''
),

itemName,
gameName,
rawGameLabel,
likelyTradingCard,
isFoil:isFoilMarketHash(hash),

gameAppId:
gameAppIdFromHash(
hash
),

marketHashName:
hash,

marketUrl:
marketUrl(
hash
),

quantity,

ownBidCents:
priceCents,

ownBid:
euro(
priceCents
)
});
}

return orders;

}finally{
restoreCookie(
'bMarketOptOut',
previous
);

await sleep(
120
);
}
}

function loadOrderWatch(){
try{
const raw=
JSON.parse(
localStorage.getItem(
KEYS.orderWatch
)||
'{}'
);

const cutoff=
Date.now()-
CFG
.orderTrackingKeepDays*
86400000;

const cleaned={};

for(const[
hash,
value
]of
Object.entries(
raw
)){
if(
Number(
value?.lastSeen||
0
)>=
cutoff
){
cleaned[hash]=
value;
}
}

return cleaned;

}catch{
return{};
}
}

function updateOrderWatch(
orders
){
const watch=
loadOrderWatch();

const now=
Date.now();

const activeHashes=
new Set(
orders.map(
order=>
order.marketHashName
)
);

for(const order of orders){
const old=
watch[
order.marketHashName
];

const priceChanged=
old&&
old.lastBidCents!==
order.ownBidCents;

watch[
order.marketHashName
]={
firstSeen:
old?.firstSeen||
now,

lastSeen:
now,

observations:
(
old?.observations||
0
)+
1,

lastBidCents:
order.ownBidCents,

priceChanges:
(
old?.priceChanges||
0
)+
(
priceChanged
?1
:0
),

lastOrderId:
order.orderId
};
}

const cutoff=
now-
CFG
.orderTrackingKeepDays*
86400000;

for(const[
hash,
value
]of
Object.entries(
watch
)){
if(
!activeHashes.has(
hash
)&&
Number(
value?.lastSeen||
0
)<
cutoff
){
delete watch[
hash
];
}
}

try{
localStorage.setItem(
KEYS.orderWatch,
JSON.stringify(
watch
)
);
}catch{}

return watch;
}

function watchInfoFor(
order,
watch
){
const item=
watch[
order.marketHashName
];

if(!item){
return null;
}

const now=
Date.now();

return{
firstSeen:
new Date(
item.firstSeen
)
.toISOString(),

lastSeen:
new Date(
item.lastSeen
)
.toISOString(),

observedDays:
round2(
(
now-
item.firstSeen
)/
86400000
),

observations:
item.observations||
0,

priceChangesObserved:
item.priceChanges||
0,

note:
'Beobachtungsdauer seit Installation dieses Wächters; nicht das echte historische Steam-Erstellungsdatum.'
};
}

function cardNameFromBadgeElement(
element
){
const direct=
element
.querySelector(
'.badge_card_set_text_cardname'
);

if(
direct&&
clean(
direct.textContent
)
){
return clean(
direct.textContent
);
}

const title=
element
.querySelector(
'.badge_card_set_title'
);

if(title){
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

const value=
clean(
clone.textContent
);

if(value){
return value;
}
}

return(
[
...element
.querySelectorAll(
'.badge_card_set_text'
)
]
.map(
element=>
clean(
element.textContent
)
)
.filter(
value=>
value&&
!/^\(\d+\)$/
.test(
value
)
)
.at(-1)||
'Unbekannte Karte'
);
}

function ownedFromBadgeElement(
element
){
const qty=
element
.querySelector(
'.badge_card_set_text_qty'
);

const match=
qty
?.textContent
?.match(
/\((\d+)\)/
);

return match
?Number(
match[1]
)
:0;
}

function parseBadgeLevel(doc){
const candidates=
[
...doc
.querySelectorAll(
'.badge_info_description,.badge_info_description > div,.badge_title,.badge_info'
)
]
.map(
element=>
clean(
element.textContent
)
)
.filter(
Boolean
);

for(const value of candidates){
const match=
value.match(
/(?:Level|Stufe)\s*(\d+)/i
);

if(match){
return Number(
match[1]
);
}
}

return 0;
}

function parseBadgeGameName(
doc,
fallback
){
const badgeTitle=
clean(
doc
.querySelector(
'.badge_title'
)
?.textContent||
''
);

const match=
badgeTitle.match(
/(?:Badge|Abzeichen)\s*:\s*(.+)$/i
);

return match?.[1]
?clean(
match[1]
)
:fallback;
}

async function fetchBadgeState(
gameAppId,
fallbackGameName
){
const url=
`${STATE.profileBase}`+
`/gamecards/${gameAppId}/`+
`?l=english`+
`&_sbw=${Date.now()}`;

const response=
await pacedFetch(
url,
{
headers:{
Accept:
'text/html,application/xhtml+xml'
}
},
'badge',
`Badge ${
fallbackGameName||
gameAppId
}`
);

const html=
await response.text();

const doc=
new DOMParser()
.parseFromString(
html,
'text/html'
);

const nodes=
[
...doc
.querySelectorAll(
'.badge_card_set_card'
)
];

if(!nodes.length){
throw new Error(
'Badge-Seite lieferte keine Karten'
);
}

const level=
parseBadgeLevel(
doc
);

const result={
badgeUrl:
url,

gameAppId:
String(
gameAppId
),

gameName:
parseBadgeGameName(
doc,
fallbackGameName
),

badgeLevel:
level,

badgeMaxed:
level>=5,

targetCopiesPerCard:
CFG.targetCopiesPerCard,

cards:
nodes.map(
(
element,
index
)=>{
const name=
cardNameFromBadgeElement(
element
);

const owned=
ownedFromBadgeElement(
element
);

const link=
element
.querySelector(
'a[href*="/market/listings/753/"]'
);

return{
nr:
index+1,

badgeName:
name,

owned,

needed:
Math.max(
0,
CFG
.targetCopiesPerCard-
owned
),

marketHashFromBadge:
hashFromUrl(
link?.href
),

marketLinkPresent:
Boolean(
link
)
};
}
)
};

updateSharedIntel(
gameAppId,
{
normalBadge:{
level,

maxLevel:
5,

maxed:
level>=5,

checkedAt:
Date.now(),

checkedBy:
'badge-watcher'
}
}
);

return result;
}

function nameFromHash(
hash,
app
){
let value=
String(
hash||
''
);

const prefix=
`${app}-`;

if(
value.startsWith(
prefix
)
){
value=
value.slice(
prefix.length
);
}

return value
.replace(
/\s*\(Foil Trading Card\)\s*$/i,
''
)
.replace(
/\s*\(Trading Card\)\s*$/i,
''
)
.replace(
/\s*\(Foil\)\s*$/i,
''
)
.trim();
}

function numericIdentity(
value
){
return(
String(
value??
''
)
.match(
/\d+/g
)||
[]
)
.map(
value=>
String(
Number(
value
)
)
);
}

function hasConflictingNumericIdentity(
a,
b
){
const left=
numericIdentity(
a
);

const right=
numericIdentity(
b
);

if(
!left.length&&
!right.length
){
return false;
}

return(
left.join(
'|'
)!==
right.join(
'|'
)
);
}

function orderNames(
order
){
return[
order.itemName,

nameFromHash(
order.marketHashName,
order.gameAppId
)
]
.map(
clean
)
.filter(
Boolean
)
.filter(
(
value,
index,
array
)=>
array.indexOf(
value
)===
index
);
}

function exactNameMatch(
order,
card
){
if(
order
.likelyTradingCard===
false||
order.isFoil===true
){
return false;
}

const wanted=
normalizeName(
card.badgeName
);

if(!wanted){
return false;
}

return orderNames(
order
)
.some(
candidate=>
normalizeName(
candidate
)===
wanted
);
}

function fuzzyOrderCardScore(
order,
card
){
if(
order
.likelyTradingCard===
false||
order.isFoil===true
){
return 0;
}

let best=0;

for(const candidate of
orderNames(
order
)){
if(
hasConflictingNumericIdentity(
card.badgeName,
candidate
)
){
continue;
}

best=
Math.max(
best,
nameScore(
card.badgeName,
candidate
)
);
}

return best;
}

function assignOrdersToBadgeCards(
cards,
orders
){
const assignments=
new Map();

const matchedOrderIds=
new Set();

const matchedCardIndexes=
new Set();

const attach=(
cardIndex,
order,
method,
score
)=>{
if(
matchedCardIndexes.has(
cardIndex
)||
matchedOrderIds.has(
order.orderId
)
){
return false;
}

assignments.set(
cardIndex,
{
order,
method,
score:
round4(
score
)
}
);

matchedCardIndexes.add(
cardIndex
);

matchedOrderIds.add(
order.orderId
);

return true;
};

cards.forEach(
(
card,
cardIndex
)=>{
if(
!card
.marketHashFromBadge
){
return;
}

const exact=
orders.find(
order=>
!matchedOrderIds.has(
order.orderId
)&&
order.marketHashName===
card.marketHashFromBadge
);

if(exact){
attach(
cardIndex,
exact,
'exact-market-hash',
1
);
}
}
);

cards.forEach(
(
card,
cardIndex
)=>{
if(
matchedCardIndexes.has(
cardIndex
)
){
return;
}

const exactCandidates=
orders.filter(
order=>
!matchedOrderIds.has(
order.orderId
)&&
exactNameMatch(
order,
card
)
);

if(
exactCandidates.length===
1
){
attach(
cardIndex,
exactCandidates[0],
'exact-name',
1
);
}
}
);

const pairs=[];

for(const cardIndex of
cards
.map(
(
_,
index
)=>
index
)
.filter(
index=>
!matchedCardIndexes.has(
index
)
)
){
for(const order of
orders.filter(
order=>
!matchedOrderIds.has(
order.orderId
)
)
){
const score=
fuzzyOrderCardScore(
order,
cards[
cardIndex
]
);

if(
score>=
Math.max(
CFG
.fallbackMinScore,
0.78
)
){
pairs.push({
cardIndex,
order,
score
});
}
}
}

const bestForCard=
new Map();

const bestForOrder=
new Map();

for(const pair of pairs){
if(
!bestForCard.get(
pair.cardIndex
)||
pair.score>
bestForCard.get(
pair.cardIndex
).score
){
bestForCard.set(
pair.cardIndex,
pair
);
}

if(
!bestForOrder.get(
pair.order
.orderId
)||
pair.score>
bestForOrder.get(
pair.order
.orderId
).score
){
bestForOrder.set(
pair.order
.orderId,
pair
);
}
}

pairs
.sort(
(a,b)=>
b.score-
a.score
)
.forEach(
pair=>{
if(
matchedCardIndexes.has(
pair.cardIndex
)||
matchedOrderIds.has(
pair.order
.orderId
)
){
return;
}

if(
bestForCard.get(
pair.cardIndex
)
?.order
?.orderId!==
pair.order
.orderId||
bestForOrder.get(
pair.order
.orderId
)
?.cardIndex!==
pair.cardIndex
){
return;
}

attach(
pair.cardIndex,
pair.order,
'fuzzy-mutual-best',
pair.score
);
}
);

return{
assignments,
matchedOrderIds
};
}

function loadItemIdCache(){
try{
const raw=
JSON.parse(
localStorage.getItem(
KEYS.itemIdCache
)||
'{}'
);

const cutoff=
Date.now()-
CFG
.itemIdCacheDays*
86400000;

const cleaned={};

for(const[
hash,
value
]of
Object.entries(
raw
)){
if(
value?.id&&
Number(
value.ts||
0
)>=
cutoff
){
cleaned[hash]=
value;
}
}

return cleaned;

}catch{
return{};
}
}

function saveItemIdCache(
cache
){
try{
localStorage.setItem(
KEYS.itemIdCache,
JSON.stringify(
Object.fromEntries(
Object.entries(
cache
)
.sort(
(a,b)=>
Number(
b[1]
?.ts||
0
)-
Number(
a[1]
?.ts||
0
)
)
.slice(
0,
2000
)
)
)
);
}catch{}
}

function extractItemNameId(
html
){
for(const pattern of[
/Market_LoadOrderSpread\(\s*(\d+)/i,
/item_nameid\s*[:=]\s*["']?(\d+)/i,
/ItemActivityTicker\.Start\([^,]+,[^,]+,\s*(\d+)/i
]){
const match=
String(
html
)
.match(
pattern
);

if(
match?.[1]
){
return match[1];
}
}

return null;
}

function detectMarketabilityFromListing(
html
){
const text=
stripHtml(
html
);

if(
/can no longer be bought or sold on the Community Market/i
.test(
text
)||
/Dieser Gegenstand kann nicht mehr auf dem Communitymarkt gekauft oder verkauft werden/i
.test(
text
)
){
return{
status:
'UNMARKETABLE',

explicit:
true,

reason:
'Steam sagt ausdrücklich, dass der Gegenstand nicht mehr auf dem Communitymarkt gekauft oder verkauft werden kann.'
};
}

if(
/There are no active listings for this item/i
.test(
text
)
){
return{
status:
'NO_SELLERS',

explicit:
true,

reason:
'Steam meldet aktuell keine aktiven Verkaufsangebote.'
};
}

return{
status:
'MARKETABLE_OR_UNKNOWN',

explicit:
false,

reason:
null
};
}

async function fetchListing(
hash,
label
){
const baseUrl=
marketUrl(
hash
);

const requestUrl=
new URL(
baseUrl
);

requestUrl
.searchParams
.set(
'l',
CFG.language
);

requestUrl
.searchParams
.set(
'_sbw',
String(
Date.now()
)
);

const previous=
getCookie(
'bMarketOptOut'
);

setCookie(
'bMarketOptOut',
'1'
);

await sleep(
90
);

try{
const response=
await pacedFetch(
requestUrl.toString(),
{
headers:{
Accept:
'text/html,application/xhtml+xml'
}
},
'listing',
`Marktseite ${label}`
);

const html=
await response.text();

return{
hash,

marketUrl:
baseUrl,

itemNameId:
extractItemNameId(
html
),

marketability:
detectMarketabilityFromListing(
html
),

html
};

}finally{
restoreCookie(
'bMarketOptOut',
previous
);

await sleep(
90
);
}
}

function marketHashCandidates(
gameAppId,
card
){
const candidates=[];

if(
card
.marketHashFromInventory
){
candidates.push(
card
.marketHashFromInventory
);
}

if(
card
.marketHashFromBadge
){
candidates.push(
card
.marketHashFromBadge
);
}

candidates.push(
`${gameAppId}-${card.badgeName}`,
`${gameAppId}-${card.badgeName} (Trading Card)`
);

return[
...new Set(
candidates
.filter(
Boolean
)
)
];
}

function parseMarketSearchData(
data,
gameAppId,
wantedName
){
const found=
new Map();

for(const item of
Array.isArray(
data?.results
)
?data.results
:[]
){
const hash=
clean(
item.hash_name||
item
.asset_description
?.market_hash_name||
''
);

if(
!hash||
!hash.startsWith(
`${gameAppId}-`
)||
/\(Foil(?: Trading Card)?\)/i
.test(
hash
)
){
continue;
}

const displayName=
nameFromHash(
hash,
gameAppId
);

const score=
nameScore(
wantedName,
displayName
);

const previous=
found.get(
hash
);

if(
!previous||
score>
previous.score
){
found.set(
hash,
{
hash,
displayName,
score
}
);
}
}

if(
typeof data
?.results_html===
'string'
){
const doc=
new DOMParser()
.parseFromString(
data.results_html,
'text/html'
);

for(const link of
doc.querySelectorAll(
'a.market_listing_row_link[href*="/market/listings/753/"]'
)
){
const hash=
hashFromUrl(
link.href
);

if(
!hash||
!hash.startsWith(
`${gameAppId}-`
)||
/\(Foil(?: Trading Card)?\)/i
.test(
hash
)
){
continue;
}

const displayName=
nameFromHash(
hash,
gameAppId
);

const score=
nameScore(
wantedName,
displayName
);

const previous=
found.get(
hash
);

if(
!previous||
score>
previous.score
){
found.set(
hash,
{
hash,
displayName,
score
}
);
}
}
}

return[
...found.values()
]
.sort(
(a,b)=>
b.score-
a.score
);
}

async function discoverMarketHash(
gameAppId,
cardName
){
const collected=
new Map();

for(const query of[
cardName,
''
]){
const maxPages=
query
?1
:CFG.fallbackSearchPages;

let start=0;

for(
let page=0;
page<
maxPages;
page++
){
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
'10'
);

url.searchParams.set(
'search_descriptions',
'0'
);

url.searchParams.set(
'sort_column',
query
?'popular'
:'name'
);

url.searchParams.set(
'sort_dir',
'asc'
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
'category_753_Game[]',
`tag_app_${gameAppId}`
);

url.searchParams.append(
'category_753_item_class[]',
'tag_item_class_2'
);

url.searchParams.append(
'category_753_cardborder[]',
'tag_cardborder_0'
);

const response=
await pacedFetch(
url.toString(),
{
headers:{
Accept:
'application/json,text/plain,*/*'
}
},
'search',
`Marktsuche ${cardName}`
);

const raw=
await response.text();

const data=
JSON.parse(
raw
);

if(
data.success!==
true&&
data.success!==
1
){
throw new Error(
'Steam-Marktsuche ohne Erfolg'
);
}

const results=
parseMarketSearchData(
data,
gameAppId,
cardName
);

for(const result of results){
collected.set(
result.hash,
result
);
}

const pageSize=
Math.max(
1,
Number(
data.pagesize||
data.searchdata
?.pagesize||
10
)||
10
);

const total=
Number(
data.total_count||
data.searchdata
?.total_count||
0
)||
0;

start+=
pageSize;

if(
query&&
results.length
){
break;
}

if(
!results.length||
(
total>0&&
start>=
total
)
){
break;
}
}

const best=
[
...collected.values()
]
.sort(
(a,b)=>
b.score-
a.score
)[0];

if(
best?.score>=
CFG.fallbackMinScore
){
break;
}
}

return[
...collected.values()
]
.sort(
(a,b)=>
b.score-
a.score
)
.filter(
result=>
result.score>=
CFG.fallbackMinScore
);
}

async function resolveCardMarket(
gameAppId,
card,
cache
){
const tried=
new Set();

for(const hash of
marketHashCandidates(
gameAppId,
card
)){
tried.add(
hash
);

try{
const listing=
await fetchListing(
hash,
card.badgeName
);

if(
!listing.itemNameId&&
listing
.marketability
.status!==
'UNMARKETABLE'
){
continue;
}

if(
listing.itemNameId
){
cache[hash]={
id:
String(
listing.itemNameId
),

ts:
Date.now()
};

STATE.stats
.itemIdsLearned++;

saveItemIdCache(
cache
);
}

return{
...listing,

resolution:
'direct',

resolvedMarketName:
nameFromHash(
hash,
gameAppId
),

resolutionScore:
null
};

}catch{}
}

for(const candidate of
await discoverMarketHash(
gameAppId,
card.badgeName
)){
if(
tried.has(
candidate.hash
)
){
continue;
}

try{
const listing=
await fetchListing(
candidate.hash,
card.badgeName
);

if(
!listing.itemNameId&&
listing
.marketability
.status!==
'UNMARKETABLE'
){
continue;
}

if(
listing.itemNameId
){
cache[
candidate.hash
]={
id:
String(
listing.itemNameId
),

ts:
Date.now()
};

STATE.stats
.itemIdsLearned++;

saveItemIdCache(
cache
);
}

return{
...listing,

resolution:
'steam-market-search',

resolvedMarketName:
candidate.displayName,

resolutionScore:
round4(
candidate.score
)
};

}catch{}
}

throw new Error(
'Keine sichere Steam-Marktzuordnung gefunden'
);
}

async function listingForExistingOrder(
order,
cache,
forceListing=false
){
const cached=
cache[
order
.marketHashName
];

if(
cached?.id&&
!forceListing
){
STATE.stats
.cachedItemIdsUsed++;

return{
hash:
order.marketHashName,

marketUrl:
order.marketUrl,

itemNameId:
String(
cached.id
),

marketability:{
status:
'NOT_CHECKED_YET',

explicit:
false,

reason:
null
},

resolution:
'active-order-cache',

resolvedMarketName:
order.itemName,

resolutionScore:
null,

listingFetched:
false
};
}

const listing=
await fetchListing(
order.marketHashName,
order.itemName
);

if(
listing.itemNameId
){
cache[
order.marketHashName
]={
id:
String(
listing.itemNameId
),

ts:
Date.now()
};

STATE.stats
.itemIdsLearned++;

saveItemIdCache(
cache
);
}

return{
...listing,

resolution:
'active-order',

resolvedMarketName:
order.itemName,

resolutionScore:
null,

listingFetched:
true
};
}

async function listingForMarketHash(hash,label,cache){
const cached=cache[hash];
if(cached?.id){
STATE.stats.cachedItemIdsUsed++;
return{
hash,
marketUrl:marketUrl(hash),
itemNameId:String(cached.id),
marketability:{status:'NOT_CHECKED_YET',explicit:false,reason:null},
resolution:'market-hash-cache',
resolvedMarketName:label||nameFromHash(hash,gameAppIdFromHash(hash)),
resolutionScore:null,
listingFetched:false
};
}
const listing=await fetchListing(hash,label||hash);
if(listing.itemNameId){cache[hash]={id:String(listing.itemNameId),ts:Date.now()};STATE.stats.itemIdsLearned++;saveItemIdCache(cache);}
return{...listing,resolution:'market-hash',resolvedMarketName:label||nameFromHash(hash,gameAppIdFromHash(hash)),resolutionScore:null,listingFetched:true};
}

function normalizeOrderGraph(
graph
){
if(
!Array.isArray(
graph
)
){
return[];
}

return graph
.map(
row=>({
priceEUR:
Number(
row?.[0]
),

priceCents:
Math.round(
Number(
row?.[0])*
100
),

cumulativeQuantity:
Number(
row?.[1]
)
})
)
.filter(
item=>
Number.isFinite(
item.priceEUR
)&&
Number.isFinite(
item
.cumulativeQuantity
)
);
}

function levelsFromCumulativeGraph(
graph,
side
){
if(
!Array.isArray(
graph
)||
!graph.length
){
return[];
}

const byPrice=
new Map();

for(const row of graph){
const current=
byPrice.get(
row.priceCents
);

if(
!current||
row
.cumulativeQuantity>
current
.cumulativeQuantity
){
byPrice.set(
row.priceCents,
row
);
}
}

const sorted=
[
...byPrice.values()
]
.sort(
(a,b)=>
side==='buy'
?(
b.priceCents-
a.priceCents
)
:(
a.priceCents-
b.priceCents
)
);

let previousCumulative=
0;

const levels=[];

for(const row of sorted){
const cumulative=
Math.max(
0,
Math.round(
row
.cumulativeQuantity
)
);

const quantity=
Math.max(
0,
cumulative-
previousCumulative
);

previousCumulative=
Math.max(
previousCumulative,
cumulative
);

if(
quantity<=0
){
continue;
}

levels.push({
priceCents:
row.priceCents,

price:
euro(
row.priceCents
),

quantity,

cumulativeQuantity:
cumulative
});
}

return levels;
}

function graphStatsAtPrice(
graph,
cents,
totalBuyOrders=0
){
if(
!Number.isFinite(
Number(
cents
)
)
){
return{
quantityAtPrice:
null,

ordersAtOrAbovePrice:
null,

estimateSource:
'unavailable'
};
}

const own=
Number(
cents
);

const total=
Number.isFinite(
Number(
totalBuyOrders
)
)
?Math.max(
0,
Number(
totalBuyOrders
)
)
:0;

const levels=
levelsFromCumulativeGraph(
graph,
'buy'
);

if(
!levels.length
){
if(
own<=
CFG.eurMinimumBuyCents&&
total>0
){
return{
quantityAtPrice:
null,

ordersAtOrAbovePrice:
total,

estimateSource:
'total-buy-order-count-fallback'
};
}

return{
quantityAtPrice:
null,

ordersAtOrAbovePrice:
null,

estimateSource:
'unavailable'
};
}

const exact=
levels.find(
level=>
level.priceCents===
own
);

let quantityAtPrice=
exact
?exact.quantity
:0;

let ordersAtOrAbovePrice=
exact
?exact
.cumulativeQuantity
:(
levels
.filter(
level=>
level.priceCents>
own
)
.at(-1)
?.cumulativeQuantity??
0
);

let estimateSource=
'order-graph';

if(
own<=
CFG.eurMinimumBuyCents&&
total>
ordersAtOrAbovePrice
){
const higherCount=
exact
?Math.max(
0,
exact
.cumulativeQuantity-
exact.quantity
)
:ordersAtOrAbovePrice;

quantityAtPrice=
Math.max(
quantityAtPrice||
0,
total-
higherCount
);

ordersAtOrAbovePrice=
total;

estimateSource=
'total-buy-order-count-fallback';
}

return{
quantityAtPrice,
ordersAtOrAbovePrice,
estimateSource
};
}

function sellGraphStatsAtPrice(
graph,
cents
){
if(
!Number.isFinite(
Number(
cents
)
)
){
return{
quantityAtPrice:
null,

offersAtOrBelowPrice:
null,

estimateSource:
'unavailable'
};
}

const target=
Number(
cents
);

const levels=
levelsFromCumulativeGraph(
graph,
'sell'
);

if(
!levels.length
){
return{
quantityAtPrice:
null,

offersAtOrBelowPrice:
null,

estimateSource:
'unavailable'
};
}

const exact=
levels.find(
level=>
level.priceCents===
target
);

const belowOrEqual=
levels.filter(
level=>
level.priceCents<=
target
);

return{
quantityAtPrice:
exact
?exact.quantity
:0,

offersAtOrBelowPrice:
belowOrEqual.length
?belowOrEqual
.at(-1)
.cumulativeQuantity
:0,

estimateSource:
'order-graph'
};
}

async function fetchHistogram(
itemNameId,
referrer
){
if(!itemNameId){
return{
lowestSellCents:null,
lowestSell:'—',
highestBuyCents:null,
highestBuy:'—',
spreadCents:null,
sellOrderCount:0,
buyOrderCount:0,
sellLevels:[],
buyLevels:[],
sellOrderGraph:[],
buyOrderGraph:[]
};
}

const url=
new URL(
'https://steamcommunity.com/market/itemordershistogram'
);

for(const[
key,
value
]of
Object.entries({
country:
CFG.country,

language:
CFG.language,

currency:
String(
CFG.currency
),

item_nameid:
String(
itemNameId
),

two_factor:
'0',

norender:
'1'
})){
url.searchParams.set(
key,
value
);
}

const response=
await pacedFetch(
url.toString(),
{
referrer,

headers:{
Accept:
'application/json'
}
},
'histogram',
'Orderbuch'
);

const raw=
await response.text();

if(
raw
.trimStart()
.startsWith(
'<'
)
){
throw new Error(
'Orderbuch: HTML statt JSON'
);
}

const data=
JSON.parse(
raw
);

if(
!data?.success
){
throw new Error(
'Orderbuch ohne Erfolg'
);
}

const lowNumber=
Number(
data
.lowest_sell_order
);

const highNumber=
Number(
data
.highest_buy_order
);

const lowestSellCents=
Number.isFinite(
lowNumber
)&&
lowNumber>0
?lowNumber
:null;

const highestBuyCents=
Number.isFinite(
highNumber
)&&
highNumber>0
?highNumber
:null;

const sellOrderGraph=
normalizeOrderGraph(
data
.sell_order_graph
);

const buyOrderGraph=
normalizeOrderGraph(
data
.buy_order_graph
);

return{
lowestSellCents,

lowestSell:
lowestSellCents===
null
?'—'
:euro(
lowestSellCents
),

highestBuyCents,

highestBuy:
highestBuyCents===
null
?'—'
:euro(
highestBuyCents
),

spreadCents:
lowestSellCents!==
null&&
highestBuyCents!==
null
?lowestSellCents-
highestBuyCents
:null,

sellOrderCount:
parseCount(
data
.sell_order_count
),

buyOrderCount:
parseCount(
data
.buy_order_count
),

sellLevels:
levelsFromCumulativeGraph(
sellOrderGraph,
'sell'
)
.slice(
0,
CFG
.marketDepthLevels
),

buyLevels:
levelsFromCumulativeGraph(
buyOrderGraph,
'buy'
)
.slice(
0,
CFG
.marketDepthLevels
),

sellOrderGraph,
buyOrderGraph
};
}

const MONTHS={
Jan:0,
Feb:1,
Mar:2,
Apr:3,
May:4,
Jun:5,
Jul:6,
Aug:7,
Sep:8,
Oct:9,
Nov:10,
Dec:11
};

function parseSteamDate(value){
const match=
clean(
value
)
.match(
/^([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{4})(?:\s+(\d{1,2})(?::(\d{2}))?)?/
);

if(
!match||
MONTHS[
match[1]
]===
undefined
){
return null;
}

return Date.UTC(
Number(
match[3]
),
MONTHS[
match[1]
],
Number(
match[2]
),
Number(
match[4]||
0
),
Number(
match[5]||
0
)
);
}

function normalizeHistory(
prices
){
if(
!Array.isArray(
prices
)
){
return[];
}

return prices
.map(
row=>{
const timestamp=
parseSteamDate(
row?.[0]
);

const priceEUR=
Number(
row?.[1]
);

const volume=
parseCount(
row?.[2]
);

return Number.isFinite(
priceEUR
)
?{
timestamp,
priceEUR,
volume
}
:null;
}
)
.filter(
Boolean
)
.sort(
(a,b)=>
(
a.timestamp||
0
)-
(
b.timestamp||
0
)
);
}

function historySummaryFromSubset(
subset,
calendarDays
){
if(
!subset.length
){
return{
points:0,
volume:0,
calendarDays,
activeTradingDays:0,
avgDailyVolume:0,
avgActiveTradingDayVolume:0,
weightedAverageEUR:null,
minEUR:null,
maxEUR:null,
stdDevEUR:null,
firstEUR:null,
lastEUR:null,
trendPct:null,
lastTradeAt:null
};
}

const activeTradingDays=
new Set(
subset.map(
point=>
new Date(
point.timestamp
)
.toISOString()
.slice(
0,
10
)
)
)
.size;

const totalVolume=
subset.reduce(
(
sum,
point
)=>
sum+
point.volume,
0
);

const weightedNumerator=
subset.reduce(
(
sum,
point
)=>
sum+
point.priceEUR*
point.volume,
0
);

const prices=
subset.map(
point=>
point.priceEUR
);

const mean=
prices.reduce(
(
sum,
value
)=>
sum+
value,
0
)/
prices.length;

const variance=
prices.reduce(
(
sum,
value
)=>
sum+
Math.pow(
value-
mean,
2
),
0
)/
prices.length;

const first=
subset[0]
.priceEUR;

const last=
subset
.at(-1)
.priceEUR;

return{
points:
subset.length,

volume:
totalVolume,

calendarDays,

activeTradingDays,

avgDailyVolume:
calendarDays>0
?round2(
totalVolume/
calendarDays
)
:0,

avgActiveTradingDayVolume:
activeTradingDays
?round2(
totalVolume/
activeTradingDays
)
:0,

weightedAverageEUR:
totalVolume
?round4(
weightedNumerator/
totalVolume
)
:null,

minEUR:
round4(
Math.min(
...prices
)
),

maxEUR:
round4(
Math.max(
...prices
)
),

stdDevEUR:
round4(
Math.sqrt(
variance
)
),

firstEUR:
round4(
first
),

lastEUR:
round4(
last
),

trendPct:
first>0
?round2(
(
last-
first
)/
first*
100
)
:null,

lastTradeAt:
new Date(
subset
.at(-1)
.timestamp
)
.toISOString()
};
}

function summarizeHistoryWindow(
points,
days
){
const now=
new Date();

const todayUtc=
Date.UTC(
now.getUTCFullYear(),
now.getUTCMonth(),
now.getUTCDate()
);

const cutoff=
todayUtc-
(
days-
1
)*
86400000;

return{
days,

...historySummaryFromSubset(
points.filter(
point=>
point.timestamp&&
point.timestamp>=
cutoff
),
days
)
};
}

function summarizeHistoryAll(
points
){
const valid=
points.filter(
point=>
point.timestamp
);

if(
!valid.length
){
return{
days:
null,

...historySummaryFromSubset(
[],
0
)
};
}

const first=
valid[0]
.timestamp;

const last=
valid
.at(-1)
.timestamp;

const calendarDays=
Math.max(
1,
Math.floor(
(
last-
first
)/
86400000
)+
1
);

return{
days:
null,

...historySummaryFromSubset(
valid,
calendarDays
)
};
}

function dailyHistoryLast30(
points
){
const now=
new Date();

const todayUtc=
Date.UTC(
now.getUTCFullYear(),
now.getUTCMonth(),
now.getUTCDate()
);

const start=
todayUtc-
29*
86400000;

const buckets=
new Map();

for(
let i=0;
i<
30;
i++
){
const timestamp=
start+
i*
86400000;

const date=
new Date(
timestamp
)
.toISOString()
.slice(
0,
10
);

buckets.set(
date,
{
date,
points:0,
volume:0,
weightedNumerator:0,
prices:[],
lastEUR:null,
lastTradeAt:null
}
);
}

for(const point of points){
if(
!point.timestamp||
point.timestamp<
start
){
continue;
}

const date=
new Date(
point.timestamp
)
.toISOString()
.slice(
0,
10
);

const bucket=
buckets.get(
date
);

if(!bucket){
continue;
}

bucket.points++;

bucket.volume+=
point.volume;

bucket.weightedNumerator+=
point.priceEUR*
point.volume;

bucket.prices.push(
point.priceEUR
);

bucket.lastEUR=
point.priceEUR;

bucket.lastTradeAt=
new Date(
point.timestamp
)
.toISOString();
}

return[
...buckets.values()
]
.map(
bucket=>({
date:
bucket.date,

points:
bucket.points,

volume:
bucket.volume,

weightedAverageEUR:
bucket.volume
?round4(
bucket
.weightedNumerator/
bucket.volume
)
:null,

minEUR:
bucket
.prices
.length
?round4(
Math.min(
...bucket.prices
)
)
:null,

maxEUR:
bucket
.prices
.length
?round4(
Math.max(
...bucket.prices
)
)
:null,

lastEUR:
Number.isFinite(
bucket.lastEUR
)
?round4(
bucket.lastEUR
)
:null,

lastTradeAt:
bucket.lastTradeAt
})
);
}

async function fetchHistory(
hash,
referrer,
label
){
const url=
new URL(
'https://steamcommunity.com/market/pricehistory/'
);

for(const[
key,
value
]of
Object.entries({
country:
CFG.country,

currency:
String(
CFG.currency
),

appid:
String(
CFG.marketAppId
),

market_hash_name:
hash
})){
url.searchParams.set(
key,
value
);
}

const response=
await pacedFetch(
url.toString(),
{
referrer,

headers:{
Accept:
'application/json'
}
},
'history',
`Preisverlauf ${label}`
);

const raw=
await response.text();

if(
raw
.trimStart()
.startsWith(
'<'
)
){
throw new Error(
'Preisverlauf: HTML statt JSON'
);
}

const data=
JSON.parse(
raw
);

if(
!data?.success||
!Array.isArray(
data.prices
)
){
throw new Error(
'Preisverlauf ohne verwertbare Daten'
);
}

const points=
normalizeHistory(
data.prices
);

return{
receivedPoints:
points.length,

all:
summarizeHistoryAll(
points
),

d365:
summarizeHistoryWindow(
points,
365
),

d90:
summarizeHistoryWindow(
points,
90
),

d30:
summarizeHistoryWindow(
points,
30
),

d7:
summarizeHistoryWindow(
points,
7
),

dailyLast30d:
dailyHistoryLast30(
points
)
};
}

function saleRegime(
history
){
const t7=
history?.d7
?.trendPct;

const t30=
history?.d30
?.trendPct;

if(
Number.isFinite(
t7
)&&
Number.isFinite(
t30
)
){
if(
t7>=5&&
t30>=0
){
return'rising';
}

if(
t7<=-5&&
t30<=0
){
return'falling';
}

if(
Math.abs(
t7
)<5&&
Math.abs(
t30
)<8
){
return'stable';
}
}

return'mixed-or-unclear';
}

function suggestedSaleRecheckDays(
avgDaily
){
const daily=
Number(
avgDaily||
0
);

if(
daily>=20
){
return 2;
}

if(
daily>=5
){
return 4;
}

if(
daily>=1
){
return 7;
}

if(
daily>0
){
return 14;
}

return 30;
}

function eurSummaryCents(summary,field='weightedAverageEUR'){
const value=Number(summary?.[field]);
return Number.isFinite(value)&&value>0?Math.round(value*100):null;
}

function medianNumber(values){
const sorted=values.filter(Number.isFinite).sort((a,b)=>a-b);
if(!sorted.length)return null;
const middle=Math.floor(sorted.length/2);
return sorted.length%2?sorted[middle]:Math.round((sorted[middle-1]+sorted[middle])/2);
}

function historyPriceProfile(history,currentCents=null){
const windows={
d7:eurSummaryCents(history?.d7),
d30:eurSummaryCents(history?.d30),
d90:eurSummaryCents(history?.d90),
d365:eurSummaryCents(history?.d365)
};
const longValues=[windows.d30,windows.d90,windows.d365].filter(Number.isFinite);
const robustRebuyAnchorCents=medianNumber(longValues);
const comparisons={};
for(const[key,value]of Object.entries(windows)){
comparisons[key]=Number.isFinite(Number(currentCents))&&Number.isFinite(value)&&value>0
?round2((Number(currentCents)-value)/value*100)
:null;
}
return{
windows,
robustRebuyAnchorCents,
robustRebuyAnchor:robustRebuyAnchorCents===null?'—':euro(robustRebuyAnchorCents),
currentPremiumPct:comparisons
};
}

function marketDemandProfile(market){
const buyLevels=(Array.isArray(market?.buyLevels)?market.buyLevels:[]).slice(0,CFG.sellDemandNearLevels);
const sellLevels=(Array.isArray(market?.sellLevels)?market.sellLevels:[]).slice(0,CFG.sellDemandNearLevels);
const nearBuyQuantity=buyLevels.reduce((sum,level)=>sum+Math.max(0,Number(level?.quantity||0)),0);
const nearSellQuantity=sellLevels.reduce((sum,level)=>sum+Math.max(0,Number(level?.quantity||0)),0);
const nearBookRatio=nearSellQuantity>0?round2(nearBuyQuantity/nearSellQuantity):nearBuyQuantity>0?null:0;
const totalBuy=Math.max(0,Number(market?.buyOrderCount||0));
const totalSell=Math.max(0,Number(market?.sellOrderCount||0));
const totalBookRatio=totalSell>0?round2(totalBuy/totalSell):totalBuy>0?null:0;
const highestBuy=finiteNumber(market?.highestBuyCents);
const lowestSell=finiteNumber(market?.lowestSellCents);
const spread=Number.isFinite(highestBuy)&&Number.isFinite(lowestSell)?lowestSell-highestBuy:null;
const spreadPct=Number.isFinite(spread)&&lowestSell>0?round2(spread/lowestSell):null;
let signal='NORMAL';
if(!Number.isFinite(highestBuy)||nearBuyQuantity<=0){signal='NONE';}
else if(Number.isFinite(spread)&&spread<=2&&nearBookRatio!==null&&nearBookRatio>=1){signal='STRONG';}
else if(Number.isFinite(spread)&&spread<=3&&nearBookRatio!==null&&nearBookRatio>=0.35){signal='HEALTHY';}
else if((nearBookRatio!==null&&nearBookRatio<0.10)||(Number.isFinite(spread)&&Number.isFinite(lowestSell)&&spread>=Math.max(3,Math.ceil(lowestSell*0.40)))){signal='WEAK';}
const queueMultiplier=signal==='STRONG'?CFG.sellStrongDemandQueueMultiplier:signal==='WEAK'||signal==='NONE'?CFG.sellWeakDemandQueueMultiplier:1;
return{
signal,
highestBuyCents:Number.isFinite(highestBuy)?highestBuy:null,
highestBuy:Number.isFinite(highestBuy)?euro(highestBuy):'—',
lowestSellCents:Number.isFinite(lowestSell)?lowestSell:null,
lowestSell:Number.isFinite(lowestSell)?euro(lowestSell):'—',
spreadCents:Number.isFinite(spread)?spread:null,
spreadPct,
nearLevelsChecked:CFG.sellDemandNearLevels,
nearBuyQuantity,
nearSellQuantity,
nearBookRatio,
totalBuyOrders:totalBuy,
totalSellOrders:totalSell,
totalBookRatio,
queueMultiplier,
note:'Buy-Depth ist ein Nachfrage-/Konkurrenzindikator. Sie beweist weder Verkauf noch Fill-Zeit.'
};
}

function adjustedExternalBuyBook(market,activeOrder){
const levels=(Array.isArray(market?.buyLevels)?market.buyLevels:[])
.map(level=>({priceCents:Number(level.priceCents),quantity:Math.max(0,Math.round(Number(level.quantity||0))) }))
.filter(level=>Number.isFinite(level.priceCents)&&level.priceCents>0&&level.quantity>0)
.sort((a,b)=>b.priceCents-a.priceCents);
const ownBid=finiteNumber(activeOrder?.ownBidCents);
const ownQuantity=Math.max(1,Math.round(Number(activeOrder?.quantity||1)));
if(!Number.isFinite(ownBid)||!levels.length){
return{reliable:false,reason:'Buy-Depth oder eigenes Gebot nicht belastbar verfügbar.',levels,externalTopCents:null,removedOwnQuantity:0};
}
const index=levels.findIndex(level=>level.priceCents===ownBid);
if(index<0){
return{reliable:false,reason:'Eigene Preisstufe wurde im sichtbaren Buy-Book nicht exakt gefunden; eigenes Gebot kann nicht sicher herausgerechnet werden.',levels,externalTopCents:levels[0]?.priceCents??null,removedOwnQuantity:0};
}
const removable=Math.min(ownQuantity,levels[index].quantity);
if(removable<=0){
return{reliable:false,reason:'Eigene Menge konnte nicht sicher von der Preisstufe getrennt werden.',levels,externalTopCents:levels[0]?.priceCents??null,removedOwnQuantity:0};
}
levels[index].quantity-=removable;
const adjusted=levels.filter(level=>level.quantity>0);
return{
reliable:true,
reason:'Eigene Auftragsmenge wurde von der exakten sichtbaren Buy-Stufe abgezogen.',
levels:adjusted,
externalTopCents:adjusted[0]?.priceCents??null,
removedOwnQuantity:removable,
ownLevelHadOtherOrders:levels[index].quantity>0
};
}

function buyQueueAtTargetFromLevels(levels,targetCents,avgDaily){
if(!Number.isFinite(Number(targetCents)))return{ordersAtOrAbove:null,estimatedDays:null};
const ordersAtOrAbove=(Array.isArray(levels)?levels:[])
.filter(level=>Number(level.priceCents)>=Number(targetCents))
.reduce((sum,level)=>sum+Math.max(0,Number(level.quantity||0)),0);
return{
ordersAtOrAbove,
estimatedDays:Number(avgDaily)>0?round2(ordersAtOrAbove/Number(avgDaily)):null
};
}

function analyzeActiveBuyPrice({activeOrder,market,history,marketStatus,suppressLowerReason=null}){
if(!activeOrder)return null;
const current=finiteNumber(activeOrder.ownBidCents);
const book=adjustedExternalBuyBook(market,activeOrder);
const externalTop=finiteNumber(book.externalTopCents);
const avgDaily=Number(history?.d30?.avgDailyVolume||0);
const activeDays=Number(history?.d30?.activeTradingDays||0);
const historyProfile=historyPriceProfile(history,current);
const demand=marketDemandProfile(market);
const liquidEnough=avgDaily>=CFG.buyLowerMinDailyVolume&&activeDays>=CFG.buyLowerMinActiveDays30d;
let target=Number.isFinite(externalTop)?Math.max(CFG.eurMinimumBuyCents,externalTop+CFG.buyLowerStepAboveExternalCents):null;
if(Number.isFinite(target)&&Number.isFinite(current))target=Math.min(target,current);
const savings=Number.isFinite(current)&&Number.isFinite(target)?current-target:null;
const savingsPct=Number.isFinite(savings)&&current>0?round2(savings/current):null;
const targetQueue=Number.isFinite(target)?buyQueueAtTargetFromLevels(book.levels,target,avgDaily):{ordersAtOrAbove:null,estimatedDays:null};
const queueAcceptable=targetQueue.estimatedDays===null||targetQueue.estimatedDays<=CFG.buyLowerMaxTargetQueueDays;
const materiallyLower=Number.isFinite(savings)&&savings>=CFG.buyLowerMinSavingsCents&&Number.isFinite(savingsPct)&&savingsPct>=CFG.buyLowerMinSavingsPct;
const marketAllowsDecision=marketStatus==='ACTIVE'&&liquidEnough;
let action='KEEP';
let recommendedTargetCents=current;
let reason='Aktuelles Gebot ist gegenüber der sicher bereinigbaren fremden Buy-Depth nicht klar überhöht; KEEP bleibt Standard.';
if(suppressLowerReason){
action='CANCEL_REVIEW';
recommendedTargetCents=null;
reason=`Preis nicht optimieren, sondern Bedarf prüfen: ${suppressLowerReason}`;
}else if(!book.reliable){
action='KEEP';
reason=`Keine automatische Senkung ohne sichere Bereinigung: ${book.reason}`;
}else if(!Number.isFinite(externalTop)){
action='KEEP';
reason='Nach Abzug des eigenen Auftrags ist keine fremde Buy-Stufe sichtbar. Ohne belastbaren Konkurrenzanker wird keine spekulative Senkung empfohlen.';
}else if(materiallyLower&&marketAllowsDecision&&queueAcceptable&&target<Number(market?.lowestSellCents||Infinity)){
action='LOWER';
recommendedTargetCents=target;
reason=`Eigenes Gebot ${euro(current)} liegt materiell über der höchsten bereinigten Fremdstufe ${euro(externalTop)}. Geduldiges Top-Ziel ${euro(target)} spart ${euro(savings)} (${Math.round(savingsPct*100)} %); eine Änderung verliert die bisherige Steam-Priorität.`;
}else if(materiallyLower&&!marketAllowsDecision){
action='REVIEW';
recommendedTargetCents=target;
reason=`Mögliche Senkung ${euro(current)} → ${euro(target)}, aber Handelsdurchsatz/aktive Tage oder Marktstatus reichen für eine automatische Empfehlung nicht aus.`;
}else if(materiallyLower&&!queueAcceptable){
action='REVIEW';
recommendedTargetCents=target;
reason=`Mögliche Senkung ${euro(current)} → ${euro(target)}, aber der Queue-Proxy am Ziel liegt über ${CFG.buyLowerMaxTargetQueueDays} Tagen. Prioritätsverlust manuell abwägen.`;
}
return{
action,
currentBidCents:Number.isFinite(current)?current:null,
currentBid:Number.isFinite(current)?euro(current):'—',
recommendedTargetCents:Number.isFinite(recommendedTargetCents)?recommendedTargetCents:null,
recommendedTarget:Number.isFinite(recommendedTargetCents)?euro(recommendedTargetCents):null,
externalTopCents:Number.isFinite(externalTop)?externalTop:null,
externalTop:Number.isFinite(externalTop)?euro(externalTop):'—',
savingsCents:Number.isFinite(savings)?savings:null,
savings:Number.isFinite(savings)?euro(savings):null,
savingsPct:Number.isFinite(savingsPct)?round2(savingsPct*100):null,
ownBookRemovalReliable:book.reliable,
removedOwnQuantity:book.removedOwnQuantity,
ownLevelHadOtherOrders:Boolean(book.ownLevelHadOtherOrders),
targetQueue,
liquidEnough,
avgDaily30d:round2(avgDaily),
activeTradingDays30d:activeDays,
marketDemand:demand,
historyPriceProfile:historyProfile,
losesPriorityIfChanged:action==='LOWER'||action==='REVIEW',
reason,
note:'SENKEN ist nur eine wirtschaftliche Empfehlung. Steam-Aufträge werden nie automatisch verändert; Queue- und Historienwerte sind Proxys.'
};
}

function estimatedSellerReceivesCents(buyerPayCents){
const gross=Math.max(0,Math.trunc(Number(buyerPayCents)||0));
if(!gross)return 0;
// Konservative Näherung für die zwei Steam-Gebühren; bei Cent-Artikeln
// verhindern die Mindestgebühren, dass eine nominelle 15%-Rechnung schönt.
return Math.max(0,gross-Math.max(2,Math.ceil(gross*0.15)));
}

function tacticalFutureReserveDecision({reservePlan,market,history,patientTarget}){
const futureCopies=Math.max(0,Number(reservePlan?.futureCraftReserveCopies||0));
const currentLowest=market?.lowestSellCents!==null&&market?.lowestSellCents!==undefined&&Number.isFinite(Number(market.lowestSellCents))?Number(market.lowestSellCents):null;
const target=patientTarget?.targetCents!==null&&patientTarget?.targetCents!==undefined&&Number.isFinite(Number(patientTarget.targetCents))?Number(patientTarget.targetCents):null;
const profile=historyPriceProfile(history,currentLowest);
const rebuy=profile.robustRebuyAnchorCents;
const estimatedNet=Number.isFinite(target)?estimatedSellerReceivesCents(target):null;
const grossGap=Number.isFinite(currentLowest)&&Number.isFinite(rebuy)?currentLowest-rebuy:null;
const premiumPct=Number.isFinite(currentLowest)&&Number.isFinite(rebuy)&&rebuy>0
?round2((currentLowest-rebuy)/rebuy)
:null;
const netGain=Number.isFinite(estimatedNet)&&Number.isFinite(rebuy)?estimatedNet-rebuy:null;
const netRoi=Number.isFinite(netGain)&&Number.isFinite(rebuy)&&rebuy>0?round2(netGain/rebuy):null;
const avgDaily=Number(history?.d30?.avgDailyVolume||0);
const activeDays=Number(history?.d30?.activeTradingDays||0);
const liquidEnough=avgDaily>=CFG.futureReserveSellMinDailyVolume&&activeDays>=CFG.futureReserveSellMinActiveDays30d;
const eligible=futureCopies>0&&
Number.isFinite(currentLowest)&&
Number.isFinite(target)&&
Number.isFinite(rebuy)&&
grossGap>=CFG.futureReserveSellMinGrossGapCents&&
premiumPct>=CFG.futureReserveSellPremiumPct&&
netGain>=CFG.futureReserveSellMinNetGainCents&&
netRoi>=CFG.futureReserveSellMinNetRoiPct&&
liquidEnough;
const quantity=eligible
?Math.min(futureCopies,CFG.futureReserveMaxTacticalCopiesPerCard)
:0;

return{
eligible,
quantity,
currentLowestCents:Number.isFinite(currentLowest)?currentLowest:null,
targetCents:Number.isFinite(target)?target:null,
estimatedSellerReceivesCents:Number.isFinite(estimatedNet)?estimatedNet:null,
expectedRebuyCents:Number.isFinite(rebuy)?rebuy:null,
grossGapCents:Number.isFinite(grossGap)?grossGap:null,
premiumPct,
estimatedNetGainCents:Number.isFinite(netGain)?netGain:null,
estimatedNetRoiPct:Number.isFinite(netRoi)?round2(netRoi*100):null,
avgDaily30d:round2(avgDaily),
activeTradingDays30d:activeDays,
liquidEnough,
historyPriceProfile:profile,
reason:eligible
?`Future-Craft-Kopie darf taktisch verkauft werden: aktueller Lowest ${euro(currentLowest)}, robuster 30/90/365T-Rückkaufanker ${euro(rebuy)}, geschätzter Nettoerlös am Ziel ${euro(estimatedNet)} und damit etwa ${euro(netGain)} Puffer. Später nur per günstigem Kaufauftrag zurückholen.`
:'Future-Craft-Reserve bleibt geschützt: Preisaufschlag, Netto-Rückkaufpuffer oder Liquidität reichen für einen taktischen Verkauf nicht gleichzeitig aus.'
};
}

function sellQueueAtTarget(market,history,targetCents,quantity=1,alreadyListed=false){
const levels=Array.isArray(market?.sellLevels)?market.sellLevels:[];
const avgDaily=Number(history?.d30?.avgDailyVolume||0);
if(!Number.isFinite(Number(targetCents))||!levels.length||avgDaily<=0)return{offersAtOrBelow:null,estimatedDays:null,avgDaily:round2(avgDaily),partialDepth:false};
const target=Number(targetCents);
const sorted=[...levels].sort((a,b)=>a.priceCents-b.priceCents);
const selected=sorted.filter(level=>Number(level.priceCents)<=target);
const offers=selected.length?Number(selected.at(-1).cumulativeQuantity||0):0;
const lastVisible=Number(sorted.at(-1)?.priceCents);
const units=alreadyListed?Math.max(1,offers):offers+Math.max(1,Number(quantity||1));
return{
offersAtOrBelow:offers,
estimatedDays:round2(units/avgDaily),
avgDaily:round2(avgDaily),
partialDepth:Number.isFinite(lastVisible)&&target>lastVisible
};
}

function suggestedPatientSellTarget(market,history,quantity=1){
const low=Number(market?.lowestSellCents);
if(!Number.isFinite(low)||low<=0)return{targetCents:null,reason:'Kein aktueller Lowest Sell.'};
const d30=eurSummaryCents(history?.d30);
const d90=eurSummaryCents(history?.d90);
const regime=saleRegime(history);
const demand=marketDemandProfile(market);
const queueBudgetDays=Math.max(30,Math.round(CFG.preferredSellQueueDays*demand.queueMultiplier));
const anchor=[d30,d90].filter(Number.isFinite).sort((a,b)=>a-b).at(-1)||low;
const upside=regime==='rising'?CFG.sellHistoricalUpsidePct+0.08:CFG.sellHistoricalUpsidePct;
const historyCap=Math.max(low,Math.round(anchor*(1+upside)));
const marketCap=Math.max(low,Math.round(low*(1+CFG.sellMaxPremiumVsLowestPct)));
const cap=Math.min(historyCap,marketCap);
const levels=Array.isArray(market?.sellLevels)?market.sellLevels:[];
let best=low;
let bestQueue=sellQueueAtTarget(market,history,low,quantity,false);
for(const level of levels){
const price=Number(level.priceCents);
if(!Number.isFinite(price)||price<low||price>cap)continue;
const q=sellQueueAtTarget(market,history,price,quantity,false);
if(Number.isFinite(q.estimatedDays)&&q.estimatedDays<=queueBudgetDays){best=price;bestQueue=q;}
}
return{
targetCents:best,
target:euro(best),
queue:bestQueue,
currentLowestCents:low,
historyAnchorCents:anchor,
historyAnchor:euro(anchor),
marketRegime:regime,
marketDemand:demand,
queueBudgetDays,
reason:`Geduldiges Ziel: höchstes sichtbares Preislevel innerhalb ca. ${queueBudgetDays} Tagen nachfragegewichteter Queue und konservativem 30/90T-Preisanker. Buy-Depth-Signal: ${demand.signal}.`
};
}

function buildSalePortfolioAnalysis({group,card,market,history,activeSellListings=[],sellWatch={},inventoryOwned=0}){
const allListings=Array.isArray(activeSellListings)?activeSellListings:[];
const activeListings=allListings.filter(listing=>(listing.listingState||'ACTIVE')==='ACTIVE');
const heldListings=allListings.filter(listing=>listing.listingState==='MARKET_HOLD');
const awaitingListings=allListings.filter(listing=>listing.listingState==='AWAITING_CONFIRMATION');
const listedCount=allListings.length;
const totalPositionCopies=inventoryOwned+listedCount;
const reservePlan=badgeReservePlan(group,totalPositionCopies);
const patientTarget=suggestedPatientSellTarget(market,history,Math.max(1,inventoryOwned||1));
const demand=patientTarget.marketDemand||marketDemandProfile(market);
const tacticalFutureSale=tacticalFutureReserveDecision({reservePlan,market,history,patientTarget});
const saleableTotalCopies=Math.min(totalPositionCopies,reservePlan.trueSurplusCopies+tacticalFutureSale.quantity);
const listingSaleSlots=Math.min(listedCount,saleableTotalCopies);
const rawSaleableInventoryCopies=Math.max(0,saleableTotalCopies-listingSaleSlots);
const marketableInventoryCopies=Number.isFinite(Number(card?.inventoryMarketableCopies))?Math.max(0,Number(card.inventoryMarketableCopies)):inventoryOwned;
const saleableInventoryCopies=Math.min(rawSaleableInventoryCopies,marketableInventoryCopies);
const temporarilyUnmarketableInventoryCopies=Math.max(0,rawSaleableInventoryCopies-saleableInventoryCopies);
const excessSellListings=Math.max(0,listedCount-saleableTotalCopies);
const d30Avg=eurSummaryCents(history?.d30);
const d90Avg=eurSummaryCents(history?.d90);
const d365Avg=eurSummaryCents(history?.d365);
const priceProfile=historyPriceProfile(history,market?.lowestSellCents);
const listingRecommendations=[];
const listingPrice=x=>x?.buyerPayCents!==null&&x?.buyerPayCents!==undefined&&Number.isFinite(Number(x.buyerPayCents))?Number(x.buyerPayCents):-1;
const sortedListings=[...allListings].sort((a,b)=>listingPrice(a)-listingPrice(b));
const cancelIds=new Set(sortedListings.slice(0,excessSellListings).map(x=>String(x.listingId)));
const permittedListings=sortedListings.filter(x=>!cancelIds.has(String(x.listingId))).sort((a,b)=>Number(b.buyerPayCents)-Number(a.buyerPayCents));
const tacticalListingCount=Math.max(0,Math.min(tacticalFutureSale.quantity,listingSaleSlots-reservePlan.trueSurplusCopies));
const tacticalListingIds=new Set(permittedListings.slice(0,tacticalListingCount).map(x=>String(x.listingId)));

for(const listing of allListings){
const watchInfo=sellWatchInfoFor(listing,sellWatch);
const listingState=listing.listingState||'ACTIVE';
const current=listingPrice(listing)>=0?listingPrice(listing):null;
const q=listingState==='ACTIVE'?sellQueueAtTarget(market,history,current,1,true):{offersAtOrBelow:null,estimatedDays:null,avgDaily:round2(Number(history?.d30?.avgDailyVolume||0)),partialDepth:false,notApplicableReason:'Listing ist noch nicht aktiv.'};
const target=patientTarget.targetCents;
const age=Number(watchInfo?.ageDays);
const lowest=Number(market?.lowestSellCents);
const raiseGap=Number.isFinite(target)&&Number.isFinite(current)?target-current:null;
const pendingUnderpricePct=Number.isFinite(raiseGap)&&Number.isFinite(current)&&current>0?raiseGap/current:null;
const dangerouslyUnderpriced=Number.isFinite(raiseGap)&&raiseGap>=CFG.sellPendingUnderpriceMinCents&&Number.isFinite(pendingUnderpricePct)&&pendingUnderpricePct>=CFG.sellPendingUnderpriceMinPct;
let action='SELLKEEP';
let targetCents=current;
let reason=tacticalListingIds.has(String(listing.listingId))
?`Taktischer Verkauf einer Future-Craft-Reserve ist wirtschaftlich freigegeben. ${tacticalFutureSale.reason}`
:'Aktiver Verkauf einer echten Überschusskopie ist für unsere geduldige Strategie aktuell plausibel positioniert.';

if(!group?.badgeMaxed&&cancelIds.has(String(listing.listingId))){
action='SELLCANCEL';
targetCents=null;
reason=`Diese angebotene Kopie gehört zur geschützten ${reservePlan.currentCraftReserveCopies?'Current-/':''}Future-Craft-Reserve. Angebot zurückholen, statt später dieselbe Karte erneut zu kaufen.`;
}else if(listingState==='AWAITING_CONFIRMATION'){
if(dangerouslyUnderpriced){
action='SELLCANCEL';
targetCents=null;
reason=`Steam-Bestätigung steht aus und der vorbereitete Käuferpreis ${euro(current)} liegt deutlich unter dem aktuellen geduldigen Ziel ${euro(target)}. Nicht bestätigen; Preis nach aktueller Marktlage neu setzen.`;
}else{
action='SELLCONFIRM';
reason=`Steam-Bestätigung steht aus. Preis ${euro(current)} bleibt gegenüber dem aktuellen Ziel ${patientTarget.target||'—'} vertretbar; nur bestätigen, wenn der Verkauf weiterhin gewollt ist.`;
}
}else if(listingState==='MARKET_HOLD'){
if(dangerouslyUnderpriced){
action='SELLCANCEL';
targetCents=null;
reason=`Steam hält das Angebot zurück, aber der vorbereitete Käuferpreis ${euro(current)} liegt deutlich unter dem aktuellen Ziel ${euro(target)}. Vor Freigabe zurückziehen und nach Ende der Haltefrist neu bewerten.`;
}else{
action='SELLHOLD';
const holdText=watchInfo?.holdUntil?` bis ungefähr ${new Date(watchInfo.holdUntil).toLocaleDateString('de-DE')}`:'';
reason=`Steam-Market-Hold${holdText}: noch nicht öffentlich kaufbar. Hold-Zeit zählt nicht als Verkaufsqueue; Preis direkt nach Freigabe frisch prüfen.`;
}
}else if(Number.isFinite(target)&&Number.isFinite(current)&&target-current>=CFG.sellRaiseMinCents&&Number.isFinite(patientTarget.queue?.estimatedDays)&&patientTarget.queue.estimatedDays<=Number(patientTarget.queueBudgetDays||CFG.preferredSellQueueDays)&&(demand.signal!=='WEAK'&&demand.signal!=='NONE'||patientTarget.marketRegime==='rising')){
action='SELLRAISE';
targetCents=target;
reason=`Aktives Listing liegt merklich unter einem historisch, per Sell-Queue und Nachfrage tragbaren Geduldsziel (${euro(target)}). Buy-Depth-Signal: ${demand.signal}.`;
}else if(listingState==='ACTIVE'){
const overpricedVsTarget=Number.isFinite(target)&&Number.isFinite(current)&&current-target>=CFG.sellLowerMinCents;
const veryLong=Number.isFinite(q.estimatedDays)&&q.estimatedDays>=CFG.hardSellQueueDays;
const absurd=Number.isFinite(q.estimatedDays)&&q.estimatedDays>=CFG.absurdSellQueueDays;
const oldEnough=Number.isFinite(age)&&age>=CFG.sellAgeHardReviewDays;
const reviewAge=Number.isFinite(age)&&age>=CFG.sellAgeReviewDays;
const extremeVsMarket=Number.isFinite(lowest)&&Number.isFinite(current)&&current>=Math.round(lowest*1.75)&&current-lowest>=3;
const strongDemand=demand.signal==='STRONG';
const lowerEvidence=(oldEnough&&veryLong)||(reviewAge&&absurd)||(oldEnough&&extremeVsMarket);
const strongDemandOverride=strongDemand&&!(oldEnough&&absurd);
if(overpricedVsTarget&&lowerEvidence&&!strongDemandOverride){
action='SELLLOWER';
targetCents=target;
reason=`Aktives Listing ist lange offen und gegenüber realistischer Queue, 30/90T-Preisanker und Nachfrage zu hoch. Geduldig bleiben, aber nicht jahrelang blockieren; Ziel ${euro(target)}, Buy-Depth-Signal ${demand.signal}.`;
}else if(Number.isFinite(age)&&age>=CFG.sellAgeReviewDays){
reason=`Seit ca. ${age.toFixed(0)} aktiven Tagen gelistet. Preis bleibt vertretbar; Alter allein ist kein Senkungsgrund. Buy-Depth-Signal: ${demand.signal}.`;
}else if(Number.isFinite(raiseGap)&&raiseGap>=CFG.sellRaiseMinCents&&(demand.signal==='WEAK'||demand.signal==='NONE')){
reason=`Ein höheres historisches Ziel wäre denkbar, aber die aktuelle Buy-Depth bestätigt die Erhöhung nicht ausreichend. Listing vorerst behalten; Nachfrage-Signal ${demand.signal}.`;
}
}

listingRecommendations.push({
listingId:listing.listingId,
listingState,
needConfirmation:Boolean(listing.needConfirmation),
marketHold:Boolean(listing.marketHold),
holdUntil:listing.holdUntil||null,
holdRemainingDays:watchInfo?.holdRemainingDays??listing.holdRemainingDays??null,
action,
reserveClass:cancelIds.has(String(listing.listingId))?'PROTECTED_RESERVE':tacticalListingIds.has(String(listing.listingId))?'TACTICAL_FUTURE_SALE':'TRUE_SURPLUS',
currentBuyerPayCents:current,
currentBuyerPay:euro(current),
targetCents,
target:targetCents===null?null:euro(targetCents),
queue:q,
watch:watchInfo,
marketDemand:demand,
reason
});
}

const historicalAnchor=priceProfile.robustRebuyAnchorCents;
const lowest=Number(market?.lowestSellCents);
const relativeToHistoryPct=historicalAnchor&&Number.isFinite(lowest)?round2((lowest-historicalAnchor)/historicalAnchor*100):null;
const marketValueSignal=relativeToHistoryPct!==null?(relativeToHistoryPct>=15?'HIGH_NOW':relativeToHistoryPct<=-18?'LOW_NOW':'NORMAL'):'UNKNOWN';
const trueSurplusInventoryCopies=Math.min(saleableInventoryCopies,Math.max(0,reservePlan.trueSurplusCopies-Math.min(listedCount,reservePlan.trueSurplusCopies)));
const tacticalFutureInventoryCopies=Math.max(0,saleableInventoryCopies-trueSurplusInventoryCopies);
let newSaleRecommendation=null;
if(saleableInventoryCopies>0&&patientTarget.targetCents!==null){
if(Number(history?.d30?.avgDailyVolume||0)<=0){
newSaleRecommendation={action:'HOLD',quantity:saleableInventoryCopies,reserveClass:tacticalFutureInventoryCopies>0?'TACTICAL_FUTURE_SALE':'TRUE_SURPLUS',targetCents:patientTarget.targetCents,target:patientTarget.target,queue:null,reason:'In den letzten 30 Kalendertagen fehlt belastbarer Handelsdurchsatz. Nicht blind listen; Markt später erneut prüfen.'};
}else if(marketValueSignal==='LOW_NOW'&&historicalAnchor){
const trigger=Math.max(Number(patientTarget.targetCents||0),Math.round(historicalAnchor*0.92));
newSaleRecommendation={action:'HOLD',quantity:saleableInventoryCopies,reserveClass:tacticalFutureInventoryCopies>0?'TACTICAL_FUTURE_SALE':'TRUE_SURPLUS',targetCents:trigger,target:euro(trigger),queue:null,reason:`Aktueller Lowest Sell liegt deutlich unter dem robusten 30/90/365T-Preisanker. Nicht billig abgeben; ab etwa ${euro(trigger)} oder bei klarer Markterholung neu prüfen.`};
}else{
const reserveClass=tacticalFutureInventoryCopies>0&&trueSurplusInventoryCopies>0?'MIXED':tacticalFutureInventoryCopies>0?'TACTICAL_FUTURE_SALE':'TRUE_SURPLUS';
const saleReason=tacticalFutureInventoryCopies>0
?`${tacticalFutureInventoryCopies} Future-Craft-Kopie(n) werden trotz späterem Bedarf taktisch verkauft. ${tacticalFutureSale.reason}`
:(group?.badgeMaxed
?'Normales Badge 5/5: diese normalen Inventarkopien werden nicht mehr für weitere normale Badge-Level benötigt. '
:`${trueSurplusInventoryCopies} echte Überschusskopie(n) liegen oberhalb des geplanten Badge-Ziels Level ${reservePlan.goal.targetLevel}/5. `);
newSaleRecommendation={action:'SELL',quantity:saleableInventoryCopies,reserveClass,trueSurplusQuantity:trueSurplusInventoryCopies,tacticalFutureQuantity:tacticalFutureInventoryCopies,targetCents:patientTarget.targetCents,target:patientTarget.target,queue:patientTarget.queue,marketDemand:demand,reason:saleReason+(marketValueSignal==='HIGH_NOW'?' Aktueller Marktwert liegt zusätzlich über dem Langfristanker. ':'')+patientTarget.reason};
}
}

return{
inventoryOwnedCopies:inventoryOwned,
totalSellListingCount:listedCount,
activeSellListingCount:activeListings.length,
marketHoldListingCount:heldListings.length,
awaitingConfirmationListingCount:awaitingListings.length,
totalPositionCopies,
badgeGoal:reservePlan.goal,
plannedBadgeTargetLevel:reservePlan.goal.targetLevel,
remainingCraftsToGoal:reservePlan.remainingCrafts,
reserveCapacityCopies:reservePlan.reserveCapacity,
plannedReserveCopies:reservePlan.plannedReserveCopies,
reserveCopiesForNextBadge:reservePlan.currentCraftReserveCopies,
currentCraftReserveCopies:reservePlan.currentCraftReserveCopies,
futureCraftReserveCopies:reservePlan.futureCraftReserveCopies,
protectedFutureCraftReserveCopies:Math.max(0,reservePlan.futureCraftReserveCopies-tacticalFutureSale.quantity),
trueSurplusCopies:reservePlan.trueSurplusCopies,
tacticalFutureSaleCopies:tacticalFutureSale.quantity,
tacticalFutureSale,
saleableTotalCopies,
saleableInventoryCopies,
trueSurplusInventoryCopies,
tacticalFutureInventoryCopies,
temporarilyUnmarketableInventoryCopies,
marketableInventoryCopies,
excessActiveListings:excessSellListings,
excessSellListings,
lowestSellCents:market?.lowestSellCents??null,
lowestSell:market?.lowestSell??'—',
highestBuyCents:market?.highestBuyCents??null,
highestBuy:market?.highestBuy??'—',
marketDemand:demand,
avg30Cents:d30Avg,
avg30:d30Avg===null?'—':euro(d30Avg),
avg90Cents:d90Avg,
avg90:d90Avg===null?'—':euro(d90Avg),
avg365Cents:d365Avg,
avg365:d365Avg===null?'—':euro(d365Avg),
historyPriceProfile:priceProfile,
marketRegime:saleRegime(history),
marketValueSignal,
relativeToHistoryPct,
historicalAnchorCents:historicalAnchor,
historicalAnchor:historicalAnchor===null?'—':euro(historicalAnchor),
patientTarget,
listingRecommendations,
newSaleRecommendation,
note:'Current-Craft-Reserve, Future-Craft-Reserve und echter Überschuss werden getrennt. Steam-Bestätigung und Market Hold zählen nicht als aktive Sell-Queue. Buy-Depth gewichtet das geduldige Verkaufsziel, bleibt aber nur ein Nachfrageindikator. Gebühren, Historie und Queue sind Schätzungen, keine Garantie.'
};
}

function marketHealth(
card,
market,
history
){
const sellers=
Number(
market
.sellOrderCount||
0
);

const daily=
Number(
history?.d30
?.avgDailyVolume||
0
);

const active=
Number(
history?.d30
?.activeTradingDays||
0
);

const firstTier=
Number(
market
.sellLevels
?.[0]
?.quantity||
0
);

const firstTwo=
(
market
.sellLevels||
[]
)
.slice(
0,
2
)
.reduce(
(
sum,
level
)=>
sum+
Number(
level.quantity||
0
),
0
);

const flags=[];

if(
sellers>0&&
sellers<=
CFG
.veryFewSellers
){
flags.push(
'VERY_FEW_SELLERS'
);

}else if(
sellers>0&&
sellers<=
CFG.fewSellers
){
flags.push(
'FEW_SELLERS'
);
}

if(
daily>0&&
daily<=
CFG
.veryLowDailyVolume
){
flags.push(
'VERY_LOW_LIQUIDITY'
);

}else if(
daily>0&&
daily<=
CFG.lowDailyVolume
){
flags.push(
'LOW_LIQUIDITY'
);
}

if(
active>0&&
active<=
CFG
.veryLowActiveDays30d
){
flags.push(
'VERY_SPORADIC_TRADING'
);

}else if(
active>0&&
active<=
CFG.lowActiveDays30d
){
flags.push(
'SPORADIC_TRADING'
);
}

if(
firstTier>0&&
firstTier<=
CFG
.thinCheapestTier
){
flags.push(
'THIN_CHEAPEST_SELL_TIER'
);
}

if(
firstTwo>0&&
firstTwo<=
CFG
.thinFirstTwoTiers
){
flags.push(
'THIN_FIRST_TWO_SELL_TIERS'
);
}

if(
Number.isFinite(
market
.lowestSellCents
)&&
market
.lowestSellCents>=
CFG.expensiveCardCents&&
card?.needed>0
){
flags.push(
'EXPENSIVE_MISSING_CARD'
);
}

const severity=
flags.some(
f=>
[
'VERY_FEW_SELLERS',
'VERY_LOW_LIQUIDITY',
'VERY_SPORADIC_TRADING'
]
.includes(
f
)
)
?'high'
:flags.length
?'medium'
:'low';

return{
severity,
sellers,
avgDaily30d:
round2(
daily
),
activeTradingDays30d:
active,
cheapestTierQuantity:
firstTier,
firstTwoTierQuantity:
firstTwo,
flags
};
}

function emptyHistory(){
return{
receivedPoints:0,

all:{
days:null,
points:0,
volume:0,
calendarDays:0,
activeTradingDays:0,
avgDailyVolume:0
},

d365:{
days:365,
points:0,
volume:0,
calendarDays:365,
activeTradingDays:0,
avgDailyVolume:0
},

d90:{
days:90,
points:0,
volume:0,
calendarDays:90,
activeTradingDays:0,
avgDailyVolume:0
},

d30:{
days:30,
points:0,
volume:0,
calendarDays:30,
activeTradingDays:0,
avgDailyVolume:0
},

d7:{
days:7,
points:0,
volume:0,
calendarDays:7,
activeTradingDays:0,
avgDailyVolume:0
},

dailyLast30d:[]
};
}

async function analyzeMarketCard({
group,
card,
activeOrder,
activeSellListings=[],
cache,
watch,
sellWatch={}
}){
let listing;
if(activeOrder){
listing=await listingForExistingOrder(activeOrder,cache,false);
}else if(activeSellListings.length){
const first=activeSellListings[0];
listing=await listingForMarketHash(first.marketHashName,card.badgeName,cache);
}else{
listing=await resolveCardMarket(group.gameAppId,card,cache);
}

const market=await fetchHistogram(listing.itemNameId,listing.marketUrl);
let history,historyError=null;
try{history=await fetchHistory(listing.hash,listing.marketUrl,card.badgeName);}catch(error){historyError=String(error?.message||error);history=emptyHistory();}

if(activeOrder&&listing.marketability.status==='NOT_CHECKED_YET'&&(market.sellOrderCount===0||market.lowestSellCents===null||(history?.d30?.volume||0)===0)){
listing={...listing,...await listingForExistingOrder(activeOrder,cache,true)};
}

let marketStatus=listing.marketability.status;
let marketStatusReason=listing.marketability.reason;
if(marketStatus!=='UNMARKETABLE'){
if(market.sellOrderCount===0||market.lowestSellCents===null){marketStatus='NO_SELLERS';marketStatusReason=marketStatusReason||'Aktuell keine Verkaufsangebote vorhanden.';}
else if((history?.d30?.volume||0)===0){marketStatus='NO_RECENT_TRADES';marketStatusReason='Keine Verkäufe in den letzten 30 Tagen im Preisverlauf.';}
else{marketStatus='ACTIVE';marketStatusReason='Markt mit aktuellen Verkäufern und 30-Tage-Handelsaktivität.';}
}

const ownQueue=activeOrder?graphStatsAtPrice(market.buyOrderGraph,activeOrder.ownBidCents,market.buyOrderCount):{quantityAtPrice:null,ordersAtOrAbovePrice:null,estimateSource:'not-applicable'};
const orderWatch=activeOrder?watchInfoFor(activeOrder,watch):null;
const avgDaily=Number(history?.d30?.avgDailyVolume||0);
const queueUnitsAhead=activeOrder?(ownQueue.ordersAtOrAbovePrice??ownQueue.quantityAtPrice):null;
const estimatedQueueDays=queueUnitsAhead!==null&&avgDaily>0?round2(queueUnitsAhead/avgDaily):null;
const inventoryOwned=Math.max(0,Number(card.inventoryOwned??card.owned??0)||0);
const totalPositionCopies=inventoryOwned+activeSellListings.length;
const health=marketHealth(card,market,history);
const salePortfolio=(totalPositionCopies>0)?buildSalePortfolioAnalysis({group,card,market,history,activeSellListings,sellWatch,inventoryOwned}):null;
const saleAtLowest=inventoryOwned>0&&Number.isFinite(market.lowestSellCents)?sellGraphStatsAtPrice(market.sellOrderGraph,market.lowestSellCents):{quantityAtPrice:null,offersAtOrBelowPrice:null,estimateSource:'not-applicable'};
const estimatedSellQueueDaysAtLowest=inventoryOwned>0&&saleAtLowest.offersAtOrBelowPrice!==null&&avgDaily>0?round2((saleAtLowest.offersAtOrBelowPrice+Math.max(1,salePortfolio?.saleableInventoryCopies||inventoryOwned))/avgDaily):null;
const saleAnalysis=totalPositionCopies>0?{
ownedCopies:inventoryOwned,
activeSellListingCopies:salePortfolio?.activeSellListingCount??0,
marketHoldListingCopies:salePortfolio?.marketHoldListingCount??0,
awaitingConfirmationListingCopies:salePortfolio?.awaitingConfirmationListingCount??0,
totalSellListingCopies:activeSellListings.length,
totalPositionCopies,
inventoryMatched:Boolean(card.inventoryMatch),
inventoryMarketHashName:card.marketHashFromInventory||null,
inventoryMarketableCopies:card.inventoryMarketableCopies??null,
inventoryTradableCopies:card.inventoryTradableCopies??null,
lowestSellCents:market.lowestSellCents,lowestSell:market.lowestSell,highestBuyCents:market.highestBuyCents,highestBuy:market.highestBuy,spreadCents:market.spreadCents,
quantityAlreadyAtLowestSell:saleAtLowest.quantityAtPrice,offersAtOrBelowLowestSell:saleAtLowest.offersAtOrBelowPrice,estimatedDaysToSellIfJoiningLowestLevel:estimatedSellQueueDaysAtLowest,
avgDailyVolume7CalendarDays:history?.d7?.avgDailyVolume??0,avgDailyVolume30CalendarDays:history?.d30?.avgDailyVolume??0,activeTradingDays30d:history?.d30?.activeTradingDays??0,
marketRegime:saleRegime(history),suggestedRecheckDays:suggestedSaleRecheckDays(avgDaily),marketHealth:health,portfolio:salePortfolio,
note:'Verkauf wird als Portfolio-Position analysiert. Current-Craft-Reserve, Future-Craft-Reserve und echter Überschuss richten sich nach dem gespeicherten Badge-Ziel; ohne Ziel wird vorsorglich bis Level 5 geschützt.'
}:null;
const buyPriceAnalysis=activeOrder?analyzeActiveBuyPrice({
activeOrder,
market,
history,
marketStatus,
suppressLowerReason:group.badgeMaxed
?'Normales Badge ist bereits Level 5; Auftrag eher stornieren als preislich optimieren.'
:card.owned>=CFG.targetCopiesPerCard
?'Benötigte Karte ist bereits im Inventar; Auftrag auf echten Zusatzbedarf prüfen.'
:null
}):null;

const flags=[];
if(group.badgeMaxed&&activeOrder)flags.push('BADGE_ALREADY_MAXED');
if(group.badgeMaxed&&totalPositionCopies>0)flags.push('MAXED_BADGE_OWNED_CARD');
if(!group.badgeMaxed&&salePortfolio?.excessActiveListings>0)flags.push('BADGE_RESERVE_LISTED_FOR_SALE');
if(salePortfolio?.futureCraftReserveCopies>0)flags.push('FUTURE_CRAFT_RESERVE');
if(salePortfolio?.tacticalFutureSaleCopies>0)flags.push('TACTICAL_FUTURE_SELL_CANDIDATE');
if(card.owned>=CFG.targetCopiesPerCard&&activeOrder)flags.push('ORDER_FOR_ALREADY_OWNED_CARD');
if(activeOrder&&Number(activeOrder.quantity||0)>Math.max(1,card.needed||0))flags.push('ORDER_QUANTITY_EXCEEDS_NEED');
const ownListedBase=activeSellListings.length>0&&totalPositionCopies>=CFG.targetCopiesPerCard;
if(!group.badgeMaxed&&card.needed>0&&!activeOrder&&!ownListedBase)flags.push('MISSING_WITHOUT_BUY_ORDER');
if(marketStatus==='UNMARKETABLE')flags.push('UNMARKETABLE');
if(marketStatus==='NO_SELLERS')flags.push('NO_SELLERS');
if(marketStatus==='NO_RECENT_TRADES')flags.push('NO_RECENT_TRADES');
if(activeOrder&&orderWatch?.observedDays>=CFG.staleDaysReview)flags.push(orderWatch.observedDays>=CFG.veryStaleDaysReview?'VERY_OLD_OPEN_ORDER':'OLD_OPEN_ORDER');
if(activeOrder&&Number.isFinite(market.highestBuyCents)&&Number.isFinite(activeOrder.ownBidCents)&&market.highestBuyCents>activeOrder.ownBidCents)flags.push('BID_BELOW_CURRENT_TOP');
if(activeOrder&&estimatedQueueDays===null&&market.buyOrderCount>0)flags.push('QUEUE_ESTIMATE_UNAVAILABLE');
if(activeOrder&&estimatedQueueDays!==null&&estimatedQueueDays>=CFG.crowdedQueueDays)flags.push('CROWDED_OWN_PRICE_LEVEL');
if(buyPriceAnalysis?.action==='LOWER')flags.push('BUY_LOWER_CANDIDATE');
if(buyPriceAnalysis?.action==='REVIEW')flags.push('BUY_PRICE_REVIEW');
if(buyPriceAnalysis?.action==='CANCEL_REVIEW')flags.push('BUY_CANCEL_REVIEW');
if(card.needed>0||activeOrder)flags.push(...health.flags);
for(const rec of salePortfolio?.listingRecommendations||[]){
if(rec.action==='SELLRAISE')flags.push('ACTIVE_SELL_RAISE_CANDIDATE');
if(rec.action==='SELLLOWER')flags.push('ACTIVE_SELL_LOWER_CANDIDATE');
if(rec.action==='SELLCANCEL')flags.push('ACTIVE_SELL_CANCEL_CANDIDATE');
if(rec.action==='SELLHOLD')flags.push('SELL_LISTING_ON_HOLD');
if(rec.action==='SELLCONFIRM')flags.push('SELL_CONFIRMATION_REQUIRED');
}
if(salePortfolio?.newSaleRecommendation?.action==='SELL')flags.push('NEW_SELL_CANDIDATE');

return{
isBadgeCard:true,badgeName:card.badgeName,owned:card.owned,inventoryOwned,totalPositionCopies,inventoryMatch:card.inventoryMatch||null,
inventoryMarketHashName:card.marketHashFromInventory||null,inventoryMarketableCopies:card.inventoryMarketableCopies??null,inventoryTradableCopies:card.inventoryTradableCopies??null,
needed:group.badgeMaxed?0:card.needed,effectiveNeededForNextCraft:group.badgeMaxed?0:Math.max(0,CFG.targetCopiesPerCard-totalPositionCopies),activeOrder,activeSellListings,marketHashName:listing.hash,resolvedMarketName:listing.resolvedMarketName,resolution:listing.resolution,resolutionScore:listing.resolutionScore,
marketUrl:listing.marketUrl,itemNameId:listing.itemNameId,marketStatus,marketStatusReason,
market:{lowestSellCents:market.lowestSellCents,lowestSell:market.lowestSell,highestBuyCents:market.highestBuyCents,highestBuy:market.highestBuy,spreadCents:market.spreadCents,sellOrderCount:market.sellOrderCount,buyOrderCount:market.buyOrderCount,sellLevels:market.sellLevels,buyLevels:market.buyLevels},
history,historyError,
ownQueue:activeOrder?{quantityAtOwnPrice:ownQueue.quantityAtPrice,ordersAtOrAboveOwnPrice:ownQueue.ordersAtOrAbovePrice,queueUnitsUsedForEstimate:queueUnitsAhead,avgDailyVolume30CalendarDays:round2(avgDaily),estimatedQueueDaysAtOwnPrice:estimatedQueueDays,estimateSource:ownQueue.estimateSource,estimateMethod:'orders at/above own bid divided by strict 30-calendar-day average transaction volume; throughput proxy only'}:null,
marketHealth:health,saleAnalysis,buyPriceAnalysis,orderWatch,flags:[...new Set(flags)]
};
}

async function analyzeStandaloneOrder({
order,
cache,
watch,
extraFlags=[]
}){
let listing=
await listingForExistingOrder(
order,
cache,
false
);

const market=
await fetchHistogram(
listing.itemNameId,
listing.marketUrl
);

let history;
let historyError=null;

try{
history=
await fetchHistory(
listing.hash,
listing.marketUrl,
order.itemName
);

}catch(error){
historyError=
String(
error?.message||
error
);

history=
emptyHistory();
}

if(
listing
.marketability
.status===
'NOT_CHECKED_YET'&&
(
market
.sellOrderCount===
0||
market
.lowestSellCents===
null||
(
history?.d30
?.volume||
0
)===
0
)
){
listing={
...listing,

...await listingForExistingOrder(
order,
cache,
true
)
};
}

let marketStatus=
listing
.marketability
.status;

let marketStatusReason=
listing
.marketability
.reason;

if(
marketStatus!==
'UNMARKETABLE'
){
if(
market
.sellOrderCount===
0||
market
.lowestSellCents===
null
){
marketStatus=
'NO_SELLERS';

marketStatusReason=
marketStatusReason||
'Aktuell keine Verkaufsangebote vorhanden.';

}else if(
(
history?.d30
?.volume||
0
)===
0
){
marketStatus=
'NO_RECENT_TRADES';

marketStatusReason=
'Keine Verkäufe in den letzten 30 Tagen.';

}else{
marketStatus=
'ACTIVE';

marketStatusReason=
'Markt aktiv.';
}
}

const ownQueue=
graphStatsAtPrice(
market
.buyOrderGraph,
order.ownBidCents,
market
.buyOrderCount
);

const orderWatch=
watchInfoFor(
order,
watch
);

const avgDaily=
Number(
history?.d30
?.avgDailyVolume||
0
);

const queueUnitsAhead=
ownQueue
.ordersAtOrAbovePrice??
ownQueue
.quantityAtPrice;

const estimatedQueueDays=
queueUnitsAhead!==
null&&
avgDaily>0
?round2(
queueUnitsAhead/
avgDaily
)
:null;

const health=
marketHealth(
{
needed:1
},
market,
history
);

const buyPriceAnalysis=
analyzeActiveBuyPrice({
activeOrder:order,
market,
history,
marketStatus
});

const flags=[
...extraFlags
];

if(
marketStatus===
'UNMARKETABLE'
){
flags.push(
'UNMARKETABLE'
);
}

if(
marketStatus===
'NO_SELLERS'
){
flags.push(
'NO_SELLERS'
);
}

if(
marketStatus===
'NO_RECENT_TRADES'
){
flags.push(
'NO_RECENT_TRADES'
);
}

if(
orderWatch
?.observedDays>=
CFG.staleDaysReview
){
flags.push(
orderWatch
.observedDays>=
CFG
.veryStaleDaysReview
?'VERY_OLD_OPEN_ORDER'
:'OLD_OPEN_ORDER'
);
}

if(
Number.isFinite(
market
.highestBuyCents
)&&
Number.isFinite(
order.ownBidCents
)&&
market
.highestBuyCents>
order.ownBidCents
){
flags.push(
'BID_BELOW_CURRENT_TOP'
);
}

if(
estimatedQueueDays===
null&&
market
.buyOrderCount>0
){
flags.push(
'QUEUE_ESTIMATE_UNAVAILABLE'
);
}

if(
estimatedQueueDays!==
null&&
estimatedQueueDays>=
CFG.crowdedQueueDays
){
flags.push(
'CROWDED_OWN_PRICE_LEVEL'
);
}

if(buyPriceAnalysis?.action==='LOWER')flags.push('BUY_LOWER_CANDIDATE');
if(buyPriceAnalysis?.action==='REVIEW')flags.push('BUY_PRICE_REVIEW');

flags.push(
...health.flags
);

return{
isBadgeCard:false,
badgeName:order.itemName,
owned:null,
needed:null,
activeOrder:order,
orderMatch:null,
marketHashName:listing.hash,
resolvedMarketName:listing.resolvedMarketName,
resolution:listing.resolution,
resolutionScore:listing.resolutionScore,
marketUrl:listing.marketUrl,
itemNameId:listing.itemNameId,
marketStatus,
marketStatusReason,

market:{
lowestSellCents:market.lowestSellCents,
lowestSell:market.lowestSell,
highestBuyCents:market.highestBuyCents,
highestBuy:market.highestBuy,
spreadCents:market.spreadCents,
sellOrderCount:market.sellOrderCount,
buyOrderCount:market.buyOrderCount,
sellLevels:market.sellLevels,
buyLevels:market.buyLevels
},

history,
historyError,
marketHealth:health,
buyPriceAnalysis,

ownQueue:{
quantityAtOwnPrice:ownQueue.quantityAtPrice,
ordersAtOrAboveOwnPrice:ownQueue.ordersAtOrAbovePrice,
queueUnitsUsedForEstimate:queueUnitsAhead,
avgDailyVolume30CalendarDays:round2(avgDaily),
estimatedQueueDaysAtOwnPrice:estimatedQueueDays,
estimateSource:ownQueue.estimateSource,
estimateMethod:'orders at/above own bid divided by strict 30-calendar-day average transaction volume; throughput proxy only'
},

orderWatch,
flags:[...new Set(flags)]
};
}

async function analyzeStandaloneSellListing({listing,cache,sellWatch,extraFlags=[]}){
const marketListing=await listingForMarketHash(listing.marketHashName,listing.itemName,cache);
const market=await fetchHistogram(marketListing.itemNameId,marketListing.marketUrl);
let history,historyError=null;
try{history=await fetchHistory(listing.marketHashName,marketListing.marketUrl,listing.itemName);}catch(error){historyError=String(error?.message||error);history=emptyHistory();}
let marketStatus=marketListing.marketability.status;
let marketStatusReason=marketListing.marketability.reason;
if(marketStatus!=='UNMARKETABLE'){
if(market.sellOrderCount===0||market.lowestSellCents===null){marketStatus='NO_SELLERS';marketStatusReason='Aktuell keine anderen Verkaufsangebote erkannt.';}
else if((history?.d30?.volume||0)===0){marketStatus='NO_RECENT_TRADES';marketStatusReason='Keine Verkäufe in den letzten 30 Tagen.';}
else{marketStatus='ACTIVE';marketStatusReason='Markt aktiv.';}
}
const pseudoGroup={badgeMaxed:true};
const portfolio=buildSalePortfolioAnalysis({group:pseudoGroup,card:{},market,history,activeSellListings:[listing],sellWatch,inventoryOwned:0});
const flags=[...extraFlags];
for(const rec of portfolio.listingRecommendations||[]){if(rec.action==='SELLRAISE')flags.push('ACTIVE_SELL_RAISE_CANDIDATE');if(rec.action==='SELLLOWER')flags.push('ACTIVE_SELL_LOWER_CANDIDATE');if(rec.action==='SELLCANCEL')flags.push('ACTIVE_SELL_CANCEL_CANDIDATE');if(rec.action==='SELLHOLD')flags.push('SELL_LISTING_ON_HOLD');if(rec.action==='SELLCONFIRM')flags.push('SELL_CONFIRMATION_REQUIRED');}
if(marketStatus==='UNMARKETABLE')flags.push('UNMARKETABLE');
return{
isBadgeCard:false,badgeName:listing.itemName,owned:null,inventoryOwned:0,totalPositionCopies:1,needed:null,activeOrder:null,activeSellListings:[listing],
marketHashName:listing.marketHashName,resolvedMarketName:listing.itemName,resolution:'active-sell-listing',resolutionScore:null,marketUrl:listing.marketUrl,itemNameId:marketListing.itemNameId,
marketStatus,marketStatusReason,
market:{lowestSellCents:market.lowestSellCents,lowestSell:market.lowestSell,highestBuyCents:market.highestBuyCents,highestBuy:market.highestBuy,spreadCents:market.spreadCents,sellOrderCount:market.sellOrderCount,buyOrderCount:market.buyOrderCount,sellLevels:market.sellLevels,buyLevels:market.buyLevels},
history,historyError,ownQueue:null,marketHealth:marketHealth({needed:0},market,history),saleAnalysis:{ownedCopies:0,activeSellListingCopies:portfolio.activeSellListingCount,totalSellListingCopies:portfolio.totalSellListingCount,totalPositionCopies:1,portfolio,note:'Aktives, gehaltenes oder unbestätigtes Verkaufsangebot ohne sicheren normalen Badge-Bezug separat verwaltet.'},orderWatch:null,flags:[...new Set(flags)]
};
}

function inventoryCardForBadgeCard(
discoveredMeta,
card,
gameAppId
){
const inventoryCards=
Array.isArray(
discoveredMeta
?.inventoryCards
)
?discoveredMeta
.inventoryCards
:[];

if(
!inventoryCards.length
){
return null;
}

if(
card
.marketHashFromBadge
){
const exactHash=
inventoryCards.find(
item=>
item
.marketHashName===
card
.marketHashFromBadge
);

if(
exactHash
){
return exactHash;
}
}

const wanted=
normalizeName(
card.badgeName
);

const exactName=
inventoryCards.filter(
item=>
normalizeName(
item.cardName
)===
wanted||
normalizeName(
nameFromHash(
item
.marketHashName,
gameAppId
)
)===
wanted
);

if(
exactName.length===
1
){
return exactName[0];
}

let best=null;
let bestScore=0;

for(const item of inventoryCards){
const score=
Math.max(
nameScore(
card.badgeName,
item.cardName
),
nameScore(
card.badgeName,
nameFromHash(
item
.marketHashName,
gameAppId
)
)
);

if(
score>
bestScore
){
bestScore=score;
best=item;
}
}

return bestScore>=
0.92
?best
:null;
}

const REVIEW_FLAGS=
new Set([
'BADGE_ALREADY_MAXED',
'ORDER_FOR_ALREADY_OWNED_CARD',
'ORDER_QUANTITY_EXCEEDS_NEED',
'MISSING_WITHOUT_BUY_ORDER',
'UNMARKETABLE',
'NO_SELLERS',
'NO_RECENT_TRADES',

// 90 Tage = Info. Erst 180 Tage Alter wird selbst zum Review-Grund.
'VERY_OLD_OPEN_ORDER',

'QUEUE_ESTIMATE_UNAVAILABLE',
'ORDER_NOT_MATCHED_TO_BADGE_CARD',
'BADGE_PAGE_UNAVAILABLE',
'ANALYSIS_ERROR',
'VERY_FEW_SELLERS',
'VERY_LOW_LIQUIDITY',
'VERY_SPORADIC_TRADING',
'NEW_SELL_CANDIDATE',
'BADGE_RESERVE_LISTED_FOR_SALE',
'TACTICAL_FUTURE_SELL_CANDIDATE',
'ACTIVE_SELL_RAISE_CANDIDATE',
'ACTIVE_SELL_LOWER_CANDIDATE',
'ACTIVE_SELL_CANCEL_CANDIDATE',
'SELL_CONFIRMATION_REQUIRED',
'BUY_LOWER_CANDIDATE',
'BUY_PRICE_REVIEW',
'BUY_CANCEL_REVIEW'
]);

function cardNeedsReview(
card
){
return(
card.flags||
[]
)
.some(
flag=>
REVIEW_FLAGS
.has(
flag
)
);
}

function setEconomicsPrecheck(
group,
actualBadgeCards,
missing,
owned,
instantKnown,
instantComplete
){
const missingCount=
missing.length;

const cardCount=
actualBadgeCards.length;

const ownedCount=
owned.length;

const missingRatio=
cardCount
?missingCount/
cardCount
:0;

const highRisk=
missing.filter(
card=>
card
.marketHealth
?.severity===
'high'
)
.length;

const mediumOrHigh=
missing.filter(
card=>
[
'medium',
'high'
]
.includes(
card
.marketHealth
?.severity
)
)
.length;

const expensiveCards=
missing.filter(
card=>
card.flags
?.includes(
'EXPENSIVE_MISSING_CARD'
)
)
.length;

const blocked=
missing.some(
card=>
[
'UNMARKETABLE',
'NO_SELLERS'
]
.includes(
card.marketStatus
)
);

const reasons=[];

let status=
'green';

if(
blocked
){
status=
'stop-candidate';

reasons.push(
'Mindestens eine fehlende Karte ist aktuell nicht normal kaufbar.'
);
}

if(
instantComplete&&
instantKnown>=
CFG
.veryExpensiveSetCents&&
ownedCount<=
CFG
.stopCandidateOwnedMax&&
missingRatio>=
CFG
.stopCandidateMissingRatio
){
status=
'stop-candidate';

reasons.push(
`Du hast erst ${ownedCount}/${cardCount} Karten und der Sofortkauf der fehlenden Karten liegt bei ${euro(instantKnown)}.`
);

}else if(
instantComplete&&
instantKnown>=
CFG
.expensiveSetCents
){
if(
status===
'green'
){
status=
'review';
}

reasons.push(
`Sofortkauf der fehlenden Karten: ${euro(instantKnown)}.`
);
}

if(
missingCount>0&&
highRisk>=
Math.max(
1,
Math.ceil(
missingCount/
2
)
)&&
ownedCount<=
CFG
.stopCandidateOwnedMax&&
missingRatio>=
CFG
.stopCandidateMissingRatio
){
status=
'stop-candidate';

reasons.push(
'Mindestens die Hälfte der fehlenden Karten hat hohes Markt-Risiko (knappe Sell-Seite, sehr niedrige Liquidität oder sehr sporadischen Handel).'
);

}else if(
mediumOrHigh>0
){
if(
status===
'green'
){
status=
'review';
}

reasons.push(
`${mediumOrHigh} fehlende Karte(n) haben mindestens mittleres Markt-/Liquiditätsrisiko.`
);
}

if(
expensiveCards
){
if(
status===
'green'
){
status=
'review';
}

reasons.push(
`${expensiveCards} fehlende Karte(n) liegen einzeln bei mindestens ${euro(CFG.expensiveCardCents)} Sofortkauf.`
);
}

if(
!reasons.length
){
reasons.push(
'Preis, Sell-Depth, Handelsfrequenz und Liquidität wirken für einen normalen nächsten Badge-Schritt unauffällig.'
);
}

return{
status,
reasons,
cardCount,
ownedCount,
missingCount,
missingRatio:
round2(
missingRatio
),
highRiskMissingCount:
highRisk,
mediumOrHighRiskMissingCount:
mediumOrHigh,
expensiveMissingCardCount:
expensiveCards,

instantBuyMissingTotalCents:
instantComplete
?instantKnown
:null,

instantBuyMissingTotal:
instantComplete
?euro(
instantKnown
)
:null,

important:
'Automatische Vorprüfung. Die spätere fundierte Auswertung soll zusätzlich Preisverlauf, Queues, konkrete Sell-Level und persönliche Badge-Ziele berücksichtigen.'
};
}

function finalizeGroup(group){
const actualBadgeCards=group.cards.filter(card=>!card.flags?.includes('ORDER_NOT_MATCHED_TO_BADGE_CARD'));
const furtherNormalCraftPossible=!group.badgeMaxed;
const effectiveNeed=card=>Number.isFinite(Number(card.effectiveNeededForNextCraft))?Number(card.effectiveNeededForNextCraft):Math.max(0,CFG.targetCopiesPerCard-Number(card.totalPositionCopies??card.inventoryOwned??card.owned??0));
const missing=furtherNormalCraftPossible?actualBadgeCards.filter(card=>effectiveNeed(card)>0):[];
const owned=furtherNormalCraftPossible?actualBadgeCards.filter(card=>effectiveNeed(card)<=0):[];
const portfolioCards=actualBadgeCards.filter(card=>Number(card.totalPositionCopies??card.inventoryOwned??card.owned??0)>0);
const saleAnalyzedCards=portfolioCards.filter(card=>card.saleAnalysis);
const saleAnalysisErrors=portfolioCards.filter(card=>!card.saleAnalysis&&card.marketStatus==='ERROR');
const missingWithoutOrder=missing.filter(card=>!card.activeOrder && !(card.activeSellListings?.length&&Number(card.totalPositionCopies||0)>=CFG.targetCopiesPerCard));
const redundantOrders=actualBadgeCards.filter(card=>card.activeOrder&&(group.badgeMaxed||card.owned>=CFG.targetCopiesPerCard));
const unmarketableMissing=missing.filter(card=>card.marketStatus==='UNMARKETABLE');
const noSellerMissing=missing.filter(card=>card.marketStatus==='NO_SELLERS');
const noRecentMissing=missing.filter(card=>card.marketStatus==='NO_RECENT_TRADES');
const analysisErrors=actualBadgeCards.filter(card=>card.marketStatus==='ERROR');
const unmatchedOrders=group.cards.filter(card=>card.flags?.includes('ORDER_NOT_MATCHED_TO_BADGE_CARD'));
const reviewFlaggedCards=group.cards.filter(cardNeedsReview);
const infoBelowTop=actualBadgeCards.filter(card=>card.flags?.includes('BID_BELOW_CURRENT_TOP'));
const allFlaggedCards=group.cards.filter(card=>(card.flags||[]).length);
const activeSellListingsCount=group.cards.reduce((sum,card)=>sum+(card.activeSellListings?.length||0),0);
const marketActiveSellListingsCount=group.cards.reduce((sum,card)=>sum+Number(card.saleAnalysis?.portfolio?.activeSellListingCount||0),0);
const marketHoldListingsCount=group.cards.reduce((sum,card)=>sum+Number(card.saleAnalysis?.portfolio?.marketHoldListingCount||0),0);
const awaitingConfirmationListingsCount=group.cards.reduce((sum,card)=>sum+Number(card.saleAnalysis?.portfolio?.awaitingConfirmationListingCount||0),0);
const newSellCandidates=group.cards.reduce((sum,card)=>sum+Number(card.saleAnalysis?.portfolio?.newSaleRecommendation?.quantity||0),0);
const sellAdjustments=group.cards.reduce((sum,card)=>sum+(card.saleAnalysis?.portfolio?.listingRecommendations||[]).filter(r=>!['SELLKEEP','SELLHOLD'].includes(r.action)).length,0);
const buyLowerCandidates=group.cards.filter(card=>card.buyPriceAnalysis?.action==='LOWER').length;
const buyPriceReviews=group.cards.filter(card=>card.buyPriceAnalysis?.action==='REVIEW').length;
const currentCraftReserveCopies=group.cards.reduce((sum,card)=>sum+Number(card.saleAnalysis?.portfolio?.currentCraftReserveCopies||0),0);
const futureCraftReserveCopies=group.cards.reduce((sum,card)=>sum+Number(card.saleAnalysis?.portfolio?.futureCraftReserveCopies||0),0);
const protectedFutureCraftReserveCopies=group.cards.reduce((sum,card)=>sum+Number(card.saleAnalysis?.portfolio?.protectedFutureCraftReserveCopies||0),0);
const trueSurplusCopies=group.cards.reduce((sum,card)=>sum+Number(card.saleAnalysis?.portfolio?.trueSurplusCopies||0),0);
const tacticalFutureSaleCopies=group.cards.reduce((sum,card)=>sum+Number(card.saleAnalysis?.portfolio?.tacticalFutureSaleCopies||0),0);
const goalNeedsDecision=group.badgeGoal?.status==='UNDECIDED'&&futureCraftReserveCopies>0;
const instantKnown=missing.filter(card=>Number.isFinite(card.market?.lowestSellCents)).reduce((sum,card)=>sum+card.market.lowestSellCents,0);
const instantComplete=missing.length===0||missing.every(card=>Number.isFinite(card.market?.lowestSellCents));
const economics=furtherNormalCraftPossible?setEconomicsPrecheck(group,actualBadgeCards,missing,owned,instantKnown,instantComplete):null;
const reasons=[];
let status='green';
if(group.badgeMaxed){
if(group.activeOrders.length){status='red';reasons.push(`Normales Badge Level 5; ${group.activeOrders.length} Kaufauftrag/Kaufaufträge laufen noch und müssen geprüft werden.`);}
else reasons.push('Normales Badge Level 5: kein weiterer normaler Badge-Kauf; Restkarten sind Verkaufsportfolio.');
if(portfolioCards.length)reasons.push(`${portfolioCards.length} Kartensorte(n) im Bestand/Verkauf wurden als Level-5-Portfolio geprüft.`);
}
if(unmarketableMissing.length){status='red';reasons.push(`${unmarketableMissing.length} fehlende Karte(n) nicht handelbar.`);}
if(missingWithoutOrder.length){status='red';reasons.push(`${missingWithoutOrder.length} fehlende Karte(n) ohne Kaufauftrag.`);}
if(redundantOrders.length&&!group.badgeMaxed){status='red';reasons.push(`${redundantOrders.length} Auftrag/Aufträge für bereits im Inventar vorhandene Karten.`);}
if(analysisErrors.length||saleAnalysisErrors.length){status='red';reasons.push(`${analysisErrors.length+saleAnalysisErrors.length} Analysefehler.`);}
if(noSellerMissing.length){status='red';reasons.push(`${noSellerMissing.length} fehlende Karte(n) ohne Verkäufer.`);}
if(noRecentMissing.length){status='red';reasons.push(`${noRecentMissing.length} fehlende Karte(n) ohne 30T-Handel.`);}
if(unmatchedOrders.length){status='red';reasons.push(`${unmatchedOrders.length} Kaufauftrag/Kaufaufträge keiner Badge-Karte sicher zugeordnet.`);}
if(economics?.status==='stop-candidate'){status='red';reasons.push('Set-Vorprüfung: 🔴 Stop-/Pausen-Kandidat wegen Preis/Knappheit/Liquidität.');}
else if(economics?.status==='review'&&status!=='red'){status='red';reasons.push('Set-Vorprüfung: Marktstruktur vor weiteren Geboten genauer prüfen.');}
if(reviewFlaggedCards.length&&status!=='red'){status='red';reasons.push(`${reviewFlaggedCards.length} Karte(n) brauchen echte Prüfung.`);}
if(goalNeedsDecision){status='red';reasons.push(`Badge-Ziel ist ungeklärt. ${futureCraftReserveCopies} vorhandene Future-Craft-Kopie(n) bleiben vorsorglich geschützt; Ziel-Level im Wächter festlegen.`);}
if(sellAdjustments)reasons.push(`${sellAdjustments} Verkaufsangebot(e) brauchen Bestätigung, Preis- oder Reserve-Anpassung.`);
if(marketHoldListingsCount)reasons.push(`${marketHoldListingsCount} Verkaufsangebot(e) im Steam-Market-Hold; Hold-Zeit zählt nicht als aktive Verkaufsqueue.`);
if(awaitingConfirmationListingsCount)reasons.push(`${awaitingConfirmationListingsCount} Verkaufsangebot(e) warten auf Steam-Bestätigung.`);
if(buyLowerCandidates)reasons.push(`${buyLowerCandidates} Kaufauftrag/Kaufaufträge sind nach Herausrechnen der eigenen Menge materielle SENKEN-Kandidaten.`);
if(buyPriceReviews)reasons.push(`${buyPriceReviews} Kaufpreisposition(en) brauchen wegen unvollständiger Konkurrenz-/Liquiditätsdaten eine manuelle Prüfung.`);
if(newSellCandidates)reasons.push(`${newSellCandidates} Inventarkopie(n) sind echte Verkaufskandidaten.`);
if(tacticalFutureSaleCopies)reasons.push(`${tacticalFutureSaleCopies} Future-Craft-Kopie(n) erfüllen den strengen Netto-Rückkauf-Filter und dürfen taktisch verkauft werden.`);
if(!reasons.length)reasons.push(infoBelowTop.length?`Aktuell okay. Bei ${infoBelowTop.length} Karte(n) bietet jemand höher; allein das ist kein Änderungsgrund.`:'Aktuell okay: Kauf- und Verkaufsportfolio ohne kritischen Eingriff.');

const finalized={
...group,groupKind:group.groupKind||'badge',normalBadgeFurtherCraftPossible:furtherNormalCraftPossible,cardCount:actualBadgeCards.length,
badgeGoal:group.badgeGoal||resolveBadgeGoal(group),plannedBadgeTargetLevel:(group.badgeGoal||resolveBadgeGoal(group)).targetLevel,badgeGoalNeedsDecision:goalNeedsDecision,
ownedForNextCraftCount:furtherNormalCraftPossible?owned.length:0,missingForNextCraftCount:furtherNormalCraftPossible?missing.length:0,
ownedInventoryCardKindsCount:portfolioCards.filter(card=>Number(card.inventoryOwned||0)>0).length,
ownedInventoryCopiesAnalyzed:portfolioCards.reduce((sum,card)=>sum+Number(card.inventoryOwned||0),0),
saleCandidateCount:portfolioCards.filter(card=>Number(card.saleAnalysis?.portfolio?.saleableTotalCopies||0)>0).length,
saleAnalyzedCount:saleAnalyzedCards.length,saleAnalysisErrorCount:saleAnalysisErrors.length,saleCandidateCards:portfolioCards.filter(card=>Number(card.saleAnalysis?.portfolio?.saleableTotalCopies||0)>0).map(card=>card.badgeName),
activeSellListingsCount,marketActiveSellListingsCount,marketHoldListingsCount,awaitingConfirmationListingsCount,newSellCandidateCopies:newSellCandidates,sellAdjustmentCount:sellAdjustments,buyLowerCandidateCount:buyLowerCandidates,buyPriceReviewCount:buyPriceReviews,currentCraftReserveCopies,futureCraftReserveCopies,protectedFutureCraftReserveCopies,trueSurplusCopies,tacticalFutureSaleCopies,
activeOrdersCount:group.activeOrders.length,missingWithoutOrderCount:missingWithoutOrder.length,missingWithoutOrder:missingWithoutOrder.map(card=>card.badgeName),redundantOrdersCount:redundantOrders.length,redundantOrders:redundantOrders.map(card=>card.badgeName),
unmarketableMissingCount:unmarketableMissing.length,unmarketableMissing:unmarketableMissing.map(card=>card.badgeName),noSellerMissingCount:noSellerMissing.length,noRecentTradeMissingCount:noRecentMissing.length,unmatchedOrdersCount:unmatchedOrders.length,
flaggedCardsCount:allFlaggedCards.length,actionRequiredCardsCount:reviewFlaggedCards.length,informationalBelowTopCount:infoBelowTop.length,
instantBuyComplete:furtherNormalCraftPossible?instantComplete:null,instantBuyMissingTotalCents:furtherNormalCraftPossible&&instantComplete?instantKnown:null,instantBuyMissingTotal:furtherNormalCraftPossible&&instantComplete?euro(instantKnown):null,
instantBuyKnownSubtotalCents:furtherNormalCraftPossible?instantKnown:null,instantBuyKnownSubtotal:furtherNormalCraftPossible?euro(instantKnown):null,setEconomicsPrecheck:economics,
reinvestmentNote:group.badgeMaxed?'Normales Badge Level 5; normale Karten sind kein weiterer Badge-Level-Kauf, sondern Rest-/Verkaufsportfolio.':'Das gespeicherte Badge-Ziel steuert die Reserve. Ohne Ziel schützt der Wächter vorsorglich bis Level 5; SETSTOP/SETWAIT bleibt später änderbar.',technicalSetStatus:status,technicalReasons:reasons
};

updateSharedIntel(group.gameAppId,{normalBadge:{level:group.badgeLevel,maxLevel:5,maxed:group.badgeMaxed,checkedAt:Date.now(),checkedBy:'badge-watcher'},badgeGoal:finalized.badgeGoal,lastWatcher:{version:'3.2.1',generated:STATE.generated||new Date().toISOString(),gameName:group.gameName,technicalSetStatus:finalized.technicalSetStatus,setEconomicsPrecheck:finalized.setEconomicsPrecheck,instantBuyMissingTotalCents:finalized.instantBuyMissingTotalCents,cardCount:finalized.cardCount,ownedForNextCraftCount:finalized.ownedForNextCraftCount,missingForNextCraftCount:finalized.missingForNextCraftCount,activeSellListingsCount:finalized.marketActiveSellListingsCount,totalSellListingsCount:finalized.activeSellListingsCount,marketHoldListingsCount:finalized.marketHoldListingsCount,awaitingConfirmationListingsCount:finalized.awaitingConfirmationListingsCount,buyLowerCandidateCount:finalized.buyLowerCandidateCount,newSellCandidateCopies:finalized.newSellCandidateCopies,currentCraftReserveCopies:finalized.currentCraftReserveCopies,futureCraftReserveCopies:finalized.futureCraftReserveCopies,trueSurplusCopies:finalized.trueSurplusCopies,tacticalFutureSaleCopies:finalized.tacticalFutureSaleCopies,cards:finalized.cards.map(c=>({name:c.badgeName,owned:c.owned,needed:c.needed,inventoryOwned:c.inventoryOwned??null,activeSellListings:(c.activeSellListings||[]).filter(x=>(x.listingState||'ACTIVE')==='ACTIVE').length,marketHoldListings:(c.activeSellListings||[]).filter(x=>x.listingState==='MARKET_HOLD').length,awaitingConfirmationListings:(c.activeSellListings||[]).filter(x=>x.listingState==='AWAITING_CONFIRMATION').length,buyPriceAnalysis:c.buyPriceAnalysis||null,lowestSellCents:c.market?.lowestSellCents??null,sellOrderCount:c.market?.sellOrderCount??null,volume30d:c.history?.d30?.volume??null,avgDailyVolume30d:c.history?.d30?.avgDailyVolume??null,activeDays30d:c.history?.d30?.activeTradingDays??null,marketHealth:c.marketHealth||null,salePortfolio:c.saleAnalysis?.portfolio||null,flags:c.flags||[]}))}});
return finalized;
}

function finalizeStandaloneGroup({
gameAppId,
gameName,
cards,
groupKind='other-market-orders',
forceReviewReason=null,
discoveredFromInventory=false,
discoveryOnly=false,
inventoryOwnedCopies=0
}){
const reviewCards=
cards.filter(
cardNeedsReview
);

const infoBelowTop=
cards.filter(
card=>
card.flags
?.includes(
'BID_BELOW_CURRENT_TOP'
)
);

const status=
reviewCards.length||
forceReviewReason
?'red'
:'green';

const reasons=[];

if(
forceReviewReason
){
reasons.push(
forceReviewReason
);
}

if(
reviewCards.length
){
reasons.push(
`${reviewCards.length} Kaufauftrag/Kaufaufträge brauchen eine echte Marktprüfung.`
);
}

if(
!reasons.length
){
reasons.push(
infoBelowTop.length
?`Marktaufträge okay; bei ${infoBelowTop.length} bietet jemand höher.`
:'Marktaufträge ohne Badge-Bezug aktuell okay.'
);
}

return{
groupKind,
gameAppId,
gameName,
badgeUrl:null,
badgeLevel:null,
badgeMaxed:false,
targetCopiesPerCard:null,
discoveredFromInventory:Boolean(discoveredFromInventory),
discoveryOnly:Boolean(discoveryOnly),
inventoryOwnedCopies:Number(inventoryOwnedCopies||0),
cardCount:cards.length,
ownedForNextCraftCount:null,
missingForNextCraftCount:null,
activeOrders:cards.map(card=>card.activeOrder).filter(Boolean),
activeOrdersCount:cards.filter(card=>card.activeOrder).length,
activeSellListingsCount:cards.reduce((sum,card)=>sum+(card.activeSellListings?.length||0),0),
marketActiveSellListingsCount:cards.reduce((sum,card)=>sum+Number(card.saleAnalysis?.portfolio?.activeSellListingCount||0),0),
marketHoldListingsCount:cards.reduce((sum,card)=>sum+Number(card.saleAnalysis?.portfolio?.marketHoldListingCount||0),0),
awaitingConfirmationListingsCount:cards.reduce((sum,card)=>sum+Number(card.saleAnalysis?.portfolio?.awaitingConfirmationListingCount||0),0),
newSellCandidateCopies:cards.reduce((sum,card)=>sum+Number(card.saleAnalysis?.portfolio?.newSaleRecommendation?.quantity||0),0),
sellAdjustmentCount:cards.reduce((sum,card)=>sum+(card.saleAnalysis?.portfolio?.listingRecommendations||[]).filter(r=>!['SELLKEEP','SELLHOLD'].includes(r.action)).length,0),
buyLowerCandidateCount:cards.filter(card=>card.buyPriceAnalysis?.action==='LOWER').length,
buyPriceReviewCount:cards.filter(card=>card.buyPriceAnalysis?.action==='REVIEW').length,
missingWithoutOrderCount:0,
missingWithoutOrder:[],
redundantOrdersCount:0,
redundantOrders:[],
unmarketableMissingCount:0,
unmarketableMissing:[],
noSellerMissingCount:0,
noRecentTradeMissingCount:0,
unmatchedOrdersCount:0,
flaggedCardsCount:cards.filter(card=>(card.flags||[]).length).length,
actionRequiredCardsCount:reviewCards.length,
informationalBelowTopCount:infoBelowTop.length,
instantBuyComplete:null,
instantBuyMissingTotalCents:null,
instantBuyMissingTotal:null,
instantBuyKnownSubtotalCents:null,
instantBuyKnownSubtotal:null,
setEconomicsPrecheck:null,
technicalSetStatus:status,
technicalReasons:reasons,
cards
};
}

async function buildGroups(orders,cache,watch,discoveredApps=new Map(),sellListings=[],sellWatch={}){
const byApp=new Map();
const ensure=key=>{if(!byApp.has(key))byApp.set(key,{orders:[],sells:[]});return byApp.get(key);};
for(const order of orders)ensure(order.gameAppId||'__unknown__').orders.push(order);
for(const sale of sellListings)ensure(sale.gameAppId||'__unknown__').sells.push(sale);
for(const[gameAppId]of discoveredApps.entries())ensure(String(gameAppId));
const groups=[];
let completedGroups=0;
const totalGroups=byApp.size;
for(const[appKey,bucket]of byApp.entries()){
if(STATE.stopRequested)break;
const gameOrders=bucket.orders;
const gameSells=bucket.sells;
const gameAppId=appKey==='__unknown__'?null:appKey;
const discoveredMeta=gameAppId?(discoveredApps.get(String(gameAppId))||null):null;
const discoveryOnly=Boolean(discoveredMeta)&&gameOrders.length===0&&gameSells.length===0;
const fallbackName=gameOrders[0]?.gameName||gameSells[0]?.gameName||discoveredMeta?.gameName||(gameAppId?`App ${gameAppId}`:'Andere Marktobjekte');
updateMainStatus(`Gruppe ${completedGroups+1}/${totalGroups}: ${fallbackName} wird geprüft …`);

if(!gameAppId){
const records=[];
for(const order of gameOrders){try{records.push(await analyzeStandaloneOrder({order,cache,watch}));}catch(error){records.push({isBadgeCard:false,badgeName:order.itemName,owned:null,needed:null,activeOrder:order,activeSellListings:[],marketStatus:'ERROR',marketStatusReason:String(error?.message||error),flags:['ANALYSIS_ERROR'],error:String(error?.message||error)});}}
for(const sale of gameSells){try{records.push(await analyzeStandaloneSellListing({listing:sale,cache,sellWatch}));}catch(error){records.push({isBadgeCard:false,badgeName:sale.itemName,owned:null,needed:null,activeOrder:null,activeSellListings:[sale],marketStatus:'ERROR',marketStatusReason:String(error?.message||error),flags:['ANALYSIS_ERROR'],error:String(error?.message||error)});}}
groups.push(finalizeStandaloneGroup({gameAppId:null,gameName:fallbackName,cards:records,groupKind:'other-market-portfolio'}));
completedGroups++;setProgress(completedGroups,totalGroups);continue;
}

let badge=null,badgeError=null;
try{badge=await fetchBadgeState(gameAppId,fallbackName);}catch(error){badgeError=String(error?.message||error);}

if(badge){
badge.badgeGoal=resolveBadgeGoal(badge);
badge.plannedBadgeTargetLevel=badge.badgeGoal.targetLevel;
badge.cards=badge.cards.map(card=>{
const inventoryMatch=inventoryCardForBadgeCard(discoveredMeta,card,gameAppId);
const inventoryOwned=inventoryMatch?Number(inventoryMatch.quantity||0):Number(card.owned||0);
return{...card,inventoryOwned:Math.max(Number(card.owned||0),inventoryOwned),inventoryMatch:inventoryMatch?{cardName:inventoryMatch.cardName,marketHashName:inventoryMatch.marketHashName,quantity:inventoryMatch.quantity,marketableCopies:inventoryMatch.marketableCopies,tradableCopies:inventoryMatch.tradableCopies}:null,marketHashFromInventory:inventoryMatch?.marketHashName||null,inventoryMarketableCopies:inventoryMatch?.marketableCopies??null,inventoryTradableCopies:inventoryMatch?.tradableCopies??null};
});
const{assignments,matchedOrderIds}=assignOrdersToBadgeCards(badge.cards,gameOrders);
const sellAssigned=assignSellListingsToBadgeCards(badge.cards,gameSells);
const cardRecords=[];
for(let cardIndex=0;cardIndex<badge.cards.length;cardIndex++){
const card=badge.cards[cardIndex];
const assignment=assignments.get(cardIndex)||null;
const activeOrder=assignment?.order||null;
const activeSellListings=sellAssigned.assignments.get(cardIndex)||[];
const orderMatch=assignment?{method:assignment.method,score:assignment.score}:null;
const inventoryOwned=Math.max(0,Number(card.inventoryOwned??card.owned??0)||0);
const totalPosition=inventoryOwned+activeSellListings.length;
const preliminaryReserve=badgeReservePlan(badge,totalPosition);
const copiesBeyondCurrentCraft=Math.max(0,totalPosition-preliminaryReserve.currentCraftReserveCopies);
const protectedCopyIsListed=!badge.badgeMaxed&&activeSellListings.length>preliminaryReserve.trueSurplusCopies;
const shouldAnalyzeOwned=(badge.badgeMaxed?CFG.scanMaxedBadgesForSale:CFG.scanOwnedCardsForSale)&&copiesBeyondCurrentCraft>0;
const shouldAnalyzeSale=activeSellListings.length>0||shouldAnalyzeOwned||protectedCopyIsListed;

if(badge.badgeMaxed&&!activeOrder&&!shouldAnalyzeSale){
cardRecords.push({isBadgeCard:true,badgeName:card.badgeName,owned:card.owned,inventoryOwned,totalPositionCopies:totalPosition,inventoryMatch:card.inventoryMatch||null,needed:0,effectiveNeededForNextCraft:0,activeOrder:null,activeSellListings:[],orderMatch:null,marketStatus:'BADGE_MAXED',marketStatusReason:'Normales Badge bereits Level 5; keine vorhandene/gelistete Kopie und kein Kaufziel.',saleAnalysis:null,flags:[]});continue;
}
if(!badge.badgeMaxed&&card.needed<=0&&!activeOrder&&!shouldAnalyzeSale){
cardRecords.push({isBadgeCard:true,badgeName:card.badgeName,owned:card.owned,inventoryOwned,totalPositionCopies:totalPosition,inventoryMatch:card.inventoryMatch||null,needed:card.needed,effectiveNeededForNextCraft:0,activeOrder:null,activeSellListings:[],orderMatch:null,marketStatus:'BADGE_BASE_RESERVED',marketStatusReason:'Current-Craft-Reserve für den nächsten Craft; keine weitere Kopie vorhanden, die eine Marktanalyse benötigt.',saleAnalysis:{portfolio:{inventoryOwnedCopies:inventoryOwned,activeSellListingCount:0,totalPositionCopies:totalPosition,badgeGoal:preliminaryReserve.goal,plannedBadgeTargetLevel:preliminaryReserve.goal.targetLevel,remainingCraftsToGoal:preliminaryReserve.remainingCrafts,reserveCapacityCopies:preliminaryReserve.reserveCapacity,plannedReserveCopies:preliminaryReserve.plannedReserveCopies,reserveCopiesForNextBadge:preliminaryReserve.currentCraftReserveCopies,currentCraftReserveCopies:preliminaryReserve.currentCraftReserveCopies,futureCraftReserveCopies:preliminaryReserve.futureCraftReserveCopies,protectedFutureCraftReserveCopies:preliminaryReserve.futureCraftReserveCopies,trueSurplusCopies:preliminaryReserve.trueSurplusCopies,tacticalFutureSaleCopies:0,saleableTotalCopies:preliminaryReserve.trueSurplusCopies,saleableInventoryCopies:Math.min(inventoryOwned,preliminaryReserve.trueSurplusCopies),listingRecommendations:[],newSaleRecommendation:null,note:'Current-Craft-Reserve geschützt; kein Verkaufsjob.'}},flags:[]});continue;
}
try{
const analyzed=await analyzeMarketCard({group:badge,card,activeOrder,activeSellListings,cache,watch,sellWatch});
analyzed.orderMatch=orderMatch;cardRecords.push(analyzed);
}catch(error){cardRecords.push({isBadgeCard:true,badgeName:card.badgeName,owned:card.owned,inventoryOwned,totalPositionCopies:totalPosition,needed:card.needed,effectiveNeededForNextCraft:badge.badgeMaxed?0:Math.max(0,CFG.targetCopiesPerCard-totalPosition),activeOrder,activeSellListings,orderMatch,marketStatus:'ERROR',marketStatusReason:String(error?.message||error),flags:['ANALYSIS_ERROR'],error:String(error?.message||error)});}
}

const unmatchedCardLike=[];const standaloneOrders=[];
for(const order of gameOrders){if(matchedOrderIds.has(order.orderId))continue;(order.likelyTradingCard&&!order.isFoil?unmatchedCardLike:standaloneOrders).push(order);}
for(const order of unmatchedCardLike){try{const extra=await analyzeStandaloneOrder({order,cache,watch,extraFlags:['ORDER_NOT_MATCHED_TO_BADGE_CARD']});extra.isBadgeCard=true;extra.owned=0;extra.needed=0;extra.orderMatch={method:'unmatched',score:null};extra.activeSellListings=[];cardRecords.push(extra);}catch(error){cardRecords.push({isBadgeCard:true,badgeName:order.itemName,owned:0,needed:0,activeOrder:order,activeSellListings:[],orderMatch:{method:'unmatched',score:null},marketStatus:'ERROR',marketStatusReason:String(error?.message||error),flags:['ORDER_NOT_MATCHED_TO_BADGE_CARD','ANALYSIS_ERROR'],error:String(error?.message||error)});}}

const unmatchedSells=gameSells.filter(s=>!sellAssigned.matchedListingIds.has(String(s.listingId)));
for(const sale of unmatchedSells){
try{const extra=await analyzeStandaloneSellListing({listing:sale,cache,sellWatch,extraFlags:[sale.isFoil?'FOIL_SELL_LISTING':'SELL_LISTING_NOT_MATCHED_TO_BADGE_CARD']});extra.isBadgeCard=false;cardRecords.push(extra);}catch(error){cardRecords.push({isBadgeCard:false,badgeName:sale.itemName,owned:null,needed:null,activeOrder:null,activeSellListings:[sale],marketStatus:'ERROR',marketStatusReason:String(error?.message||error),flags:['ANALYSIS_ERROR'],error:String(error?.message||error)});}
}

const badgeOrderIds=new Set([...assignments.values()].map(x=>x.order.orderId));unmatchedCardLike.forEach(order=>badgeOrderIds.add(order.orderId));
groups.push(finalizeGroup({...badge,groupKind:'badge',discoveredFromInventory:Boolean(discoveredMeta),discoveryOnly,inventoryOwnedCopies:discoveredMeta?.ownedInventoryCopies||0,inventoryCards:discoveredMeta?.inventoryCards||[],activeOrders:gameOrders.filter(order=>badgeOrderIds.has(order.orderId)),activeSellListings:gameSells,cards:cardRecords}));

if(standaloneOrders.length){
const records=[];for(const order of standaloneOrders){try{records.push(await analyzeStandaloneOrder({order,cache,watch}));}catch(error){records.push({isBadgeCard:false,badgeName:order.itemName,owned:null,needed:null,activeOrder:order,activeSellListings:[],marketStatus:'ERROR',marketStatusReason:String(error?.message||error),flags:['ANALYSIS_ERROR'],error:String(error?.message||error)});}}
groups.push(finalizeStandaloneGroup({gameAppId,gameName:`${badge.gameName} – andere Kaufaufträge`,cards:records}));
}
}else{
const allMarketCards=[];
for(const order of gameOrders){try{const record=await analyzeStandaloneOrder({order,cache,watch,extraFlags:order.likelyTradingCard?['BADGE_PAGE_UNAVAILABLE']:[]});record.isBadgeCard=Boolean(order.likelyTradingCard&&!order.isFoil);record.activeSellListings=[];allMarketCards.push(record);}catch(error){allMarketCards.push({isBadgeCard:Boolean(order.likelyTradingCard&&!order.isFoil),badgeName:order.itemName,owned:null,needed:null,activeOrder:order,activeSellListings:[],marketStatus:'ERROR',marketStatusReason:String(error?.message||error),flags:['BADGE_PAGE_UNAVAILABLE','ANALYSIS_ERROR'],error:String(error?.message||error)});}}
for(const sale of gameSells){try{allMarketCards.push(await analyzeStandaloneSellListing({listing:sale,cache,sellWatch,extraFlags:sale.likelyTradingCard&&!sale.isFoil?['BADGE_PAGE_UNAVAILABLE']:[]}));}catch(error){allMarketCards.push({isBadgeCard:false,badgeName:sale.itemName,owned:null,needed:null,activeOrder:null,activeSellListings:[sale],marketStatus:'ERROR',marketStatusReason:String(error?.message||error),flags:['ANALYSIS_ERROR'],error:String(error?.message||error)});}}
const force=discoveryOnly?`Über eigene Sammelkarte entdeckt, aber Badge-Seite konnte nicht gelesen werden: ${badgeError}`:`Badge-Seite konnte nicht gelesen werden: ${badgeError}`;
groups.push(finalizeStandaloneGroup({gameAppId,gameName:fallbackName,cards:allMarketCards,groupKind:'badge-error',forceReviewReason:force,discoveredFromInventory:Boolean(discoveredMeta),discoveryOnly,inventoryOwnedCopies:discoveredMeta?.ownedInventoryCopies||0}));
}
completedGroups++;setProgress(completedGroups,totalGroups);
}
return groups;
}

function injectStyle(){
if(
document.getElementById(
'sbw-style'
)
){
return;
}

const style=
document.createElement(
'style'
);

style.id=
'sbw-style';

style.textContent=`
#sbw-launch{position:fixed;right:20px;bottom:20px;z-index:999999;border:0;border-radius:4px;padding:11px 15px;background:#1a9fff;color:#fff;font-weight:700;cursor:pointer;box-shadow:0 4px 15px rgba(0,0,0,.35)}
#sbw-overlay,#sbw-plan-overlay{position:fixed;inset:0;z-index:1000000;background:rgba(0,0,0,.82);display:flex;align-items:center;justify-content:center;padding:20px}
.sbw-modal{width:min(1160px,96vw);max-height:92vh;overflow:auto;background:#1b2a3a;color:#d6d7d8;border:1px solid #35536e;border-radius:5px;padding:18px;box-shadow:0 14px 60px rgba(0,0,0,.65);font-family:Arial,Helvetica,sans-serif}
.sbw-toolbar{position:sticky;top:-18px;z-index:10;display:flex;flex-wrap:wrap;gap:8px;padding:11px 0;margin:8px 0 12px;background:#1b2a3a;border-bottom:1px solid #35536e}
.sbw-muted{color:#9fb0bf}.sbw-green{color:#8bcf5b}.sbw-red{color:#ff7777}.sbw-warn{color:#ffcf70}.sbw-info{color:#c4d4e2}
#sbw-progress-wrap{height:7px;background:#101923;margin:12px 0;overflow:hidden;border-radius:3px}
#sbw-progress{width:0;height:100%;background:#1a9fff;transition:width .2s ease}
.sbw-group{background:#26394c;border-left:4px solid #1a9fff;padding:10px;margin:8px 0;font-size:12px}
.sbw-group.green{border-left-color:#75b022}.sbw-group.red{border-left-color:#e05252}
.sbw-card{margin:5px 0 0 12px;padding:7px 8px;background:#1d3042;line-height:1.45}
.sbw-card-title{font-weight:700;color:#fff}.sbw-card-note{margin-top:3px}
.sbw-goal{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:8px 0;padding:7px 8px;background:#1d3042}
.sbw-goal select{background:#101923;color:#fff;border:1px solid #4b6b88;border-radius:3px;padding:6px}
.sbw-goal-note{color:#c4d4e2}
.sbw-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}
.sbw-actions button,.sbw-toolbar button,.sbw-small{border:0;border-radius:3px;padding:8px 11px;font-weight:700;cursor:pointer}
button:disabled{opacity:.45;cursor:not-allowed}
.sbw-blue{background:#1a9fff;color:#fff}.sbw-good{background:#75b022;color:#fff}.sbw-gray{background:#ddd;color:#111}.sbw-danger{background:#b74747;color:#fff}
#sbw-plan{width:100%;height:230px;background:#101923;color:#fff;border:1px solid #35536e;padding:10px;box-sizing:border-box;font-family:monospace;margin-top:10px}
.sbw-set-verdict{padding:10px;margin:7px 0;background:#1d3042;border-left:4px solid #75b022}
.sbw-set-verdict.red{border-left-color:#e05252}
.sbw-plan-row{display:grid;grid-template-columns:minmax(250px,1.35fr) minmax(210px,.9fr) minmax(330px,1.4fr);gap:8px;align-items:center;background:#26394c;padding:9px;margin:5px 0;font-size:12px}
.sbw-plan-reason{margin-top:4px;color:#c4d4e2}.sbw-done{opacity:.55}
@media(max-width:760px){.sbw-plan-row{grid-template-columns:1fr}}
`;

document.head.appendChild(
style
);
}

function queueText(
card
){
const queue=
card?.ownQueue
?.estimatedQueueDaysAtOwnPrice;

return Number.isFinite(
queue
)
?`${queue.toFixed(2).replace('.',',')} Tage`
:null;
}

function friendlyCardMessage(
card
){
if(
card.marketStatus===
'BADGE_BASE_RESERVED'
){
const portfolio=card.saleAnalysis?.portfolio;
return{review:false,text:`🟢 CURRENT-CRAFT-RESERVE – ${portfolio?.currentCraftReserveCopies||1}× für den nächsten Craft behalten. Badge-Ziel: ${portfolio?.badgeGoal?.label||'nicht bekannt'}. Kein Verkaufsjob.`};
}

if(
card.marketStatus===
'NOT_NEEDED'
){
return{
review:false,
text:'🟢 Schon vorhanden – kein weiterer Kaufauftrag nötig.'
};
}

if(
card.marketStatus===
'BADGE_MAXED'
){
return{
review:false,
text:'🟢 Normales Badge Level 5 – nicht besessene Karte kein Kaufziel.'
};
}

const flags=
new Set(
card.flags||
[]
);

const parts=[];

const queue=
queueText(
card
);

if(
flags.has(
'MAXED_BADGE_OWNED_CARD'
)
){
const sale=
card.saleAnalysis;

parts.push(
`🟠 Level-5-Restkarte: ${Number(card.inventoryOwned ?? card.owned ?? 0)} Exemplar(e). SELL/HOLD-Daten vorhanden.`
);

if(
Number.isFinite(
sale
?.estimatedDaysToSellIfJoiningLowestLevel
)
){
parts.push(
`Grobe Sell-Queue am Lowest: ${sale.estimatedDaysToSellIfJoiningLowestLevel.toFixed(2).replace('.', ',')} Tage.`
);
}
}

if(
flags.has(
'BADGE_ALREADY_MAXED'
)
){
parts.push(
'🔴 Badge Level 5, aber Kaufauftrag läuft noch.'
);
}

if(flags.has('FUTURE_CRAFT_RESERVE')){
const portfolio=card.saleAnalysis?.portfolio;
parts.push(`🟢 FUTURE-CRAFT-RESERVE: ${portfolio?.protectedFutureCraftReserveCopies??portfolio?.futureCraftReserveCopies??0}× für spätere Crafts geschützt · Ziel ${portfolio?.plannedBadgeTargetLevel??'—'}/5${portfolio?.badgeGoal?.confirmed?'':' (noch nicht bestätigt)'}.`);
}

if(flags.has('TACTICAL_FUTURE_SELL_CANDIDATE')){
const tactical=card.saleAnalysis?.portfolio?.tacticalFutureSale;
parts.push(`🟠 VERKAUF TROTZ SPÄTEREM BEDARF: ${tactical?.quantity||0}× erfüllt Preis-, Gebühren-, Rückkauf- und Liquiditätsfilter. Erwarteter Rückkaufanker ${euro(tactical?.expectedRebuyCents)}, geschätzter Nettopuffer ${euro(tactical?.estimatedNetGainCents)}.`);
}

if(flags.has('BADGE_RESERVE_LISTED_FOR_SALE')){
parts.push('🔴 Mindestens eine geschützte Current-/Future-Craft-Kopie ist noch zum Verkauf gelistet und sollte zurückgeholt werden.');
}

if(
flags.has(
'ORDER_FOR_ALREADY_OWNED_CARD'
)
){
parts.push(
'🔴 Karte schon vorhanden, Kaufauftrag noch offen.'
);
}

if(
flags.has(
'MISSING_WITHOUT_BUY_ORDER'
)
){
parts.push(
'🔴 Karte fehlt, aber kein Kaufauftrag vorhanden.'
);
}

if(
flags.has(
'ORDER_QUANTITY_EXCEEDS_NEED'
)
){
parts.push(
'🔴 Bestellmenge größer als Bedarf.'
);
}

if(
flags.has(
'UNMARKETABLE'
)
){
parts.push(
'🔴 Nicht mehr handelbar.'
);
}

if(
flags.has(
'NO_SELLERS'
)
){
parts.push(
'🔴 Aktuell keine Verkäufer.'
);
}

if(
flags.has(
'NO_RECENT_TRADES'
)
){
parts.push(
'🔴 30 Tage ohne erkannten Handel.'
);
}

if(
flags.has(
'VERY_FEW_SELLERS'
)
){
parts.push(
`🔴 Sehr wenige Verkäufer (≤ ${CFG.veryFewSellers}).`
);

}else if(
flags.has(
'FEW_SELLERS'
)
){
parts.push(
`🟡 Wenige Verkäufer (≤ ${CFG.fewSellers}).`
);
}

if(
flags.has(
'VERY_LOW_LIQUIDITY'
)
){
parts.push(
`🔴 Sehr geringe Liquidität (≤ ${CFG.veryLowDailyVolume}/Tag).`
);

}else if(
flags.has(
'LOW_LIQUIDITY'
)
){
parts.push(
`🟡 Niedrige Liquidität (≤ ${CFG.lowDailyVolume}/Tag).`
);
}

if(
flags.has(
'VERY_SPORADIC_TRADING'
)
){
parts.push(
`🔴 Sehr sporadisch (≤ ${CFG.veryLowActiveDays30d} aktive Tage/30).`
);

}else if(
flags.has(
'SPORADIC_TRADING'
)
){
parts.push(
`🟡 Sporadisch (≤ ${CFG.lowActiveDays30d} aktive Tage/30).`
);
}

if(
flags.has(
'THIN_CHEAPEST_SELL_TIER'
)
){
parts.push(
'🟡 Günstigstes Sell-Level sehr dünn.'
);
}

if(
flags.has(
'THIN_FIRST_TWO_SELL_TIERS'
)
){
parts.push(
'🟡 Erste zwei Sell-Level zusammen dünn; 1–2 Verkäufe können den Preis sichtbar hochschieben.'
);
}

if(
flags.has(
'ORDER_NOT_MATCHED_TO_BADGE_CARD'
)
){
parts.push(
'🔴 Auftrag keiner Badge-Karte sicher zugeordnet.'
);
}

if(
flags.has(
'BADGE_PAGE_UNAVAILABLE'
)
){
parts.push(
'🔴 Badge-Seite nicht verfügbar; Besitz unbekannt.'
);
}

if(
flags.has(
'ANALYSIS_ERROR'
)
){
parts.push(
'🔴 Analysefehler.'
);
}

if(
flags.has(
'VERY_OLD_OPEN_ORDER'
)
){
parts.push(
`🟡 Langzeitauftrag seit mindestens ${CFG.veryStaleDaysReview} Tagen beobachtet – jetzt Markt/Preis neu bewerten, aber nicht automatisch erhöhen.`
);

}else if(
flags.has(
'OLD_OPEN_ORDER'
)
){
parts.push(
`Info: Langzeitauftrag seit mindestens ${CFG.staleDaysReview} Tagen beobachtet. Alter allein ist kein Änderungsgrund.`
);
}

if(
flags.has(
'QUEUE_ESTIMATE_UNAVAILABLE'
)
){
parts.push(
'🔴 Queue nicht verlässlich berechenbar.'
);
}

if(
flags.has(
'CROWDED_OWN_PRICE_LEVEL'
)&&
queue
){
parts.push(
`🟢 Gedulds-Queue etwa ${queue}. Für die Low-Bid-Strategie allein kein Grund, mehr zu zahlen.`
);

}else if(
queue
){
parts.push(
`🟢 Queue-Proxy etwa ${queue}.`
);
}

if(
flags.has(
'BID_BELOW_CURRENT_TOP'
)
){
parts.push(
`Info: dein Gebot ${card.activeOrder?.ownBid || '—'}, aktueller Top-Buy ${card.market?.highestBuy || '—'}. Allein das ist kein Erhöhungsgrund.`
);
}

const buyPrice=card.buyPriceAnalysis;
if(flags.has('BUY_LOWER_CANDIDATE')&&buyPrice){
parts.push(`🟠 KAUFGEBOT SENKEN PRÜFEN: ${buyPrice.currentBid} → ${buyPrice.recommendedTarget}. Höchste fremde Stufe nach Abzug der eigenen Menge: ${buyPrice.externalTop}; mögliche Ersparnis ${buyPrice.savings}. Achtung: Preisänderung verliert die bisherige Steam-Priorität. ${buyPrice.reason}`);
}else if(flags.has('BUY_PRICE_REVIEW')&&buyPrice){
parts.push(`🟡 KAUFPREIS MANUELL PRÜFEN: ${buyPrice.reason}`);
}

const salePortfolio=card.saleAnalysis?.portfolio;
if(salePortfolio){
for(const rec of salePortfolio.listingRecommendations||[]){
const age=rec.watch?.ageDays;
const ageText=Number.isFinite(age)?` · Alter ≈ ${age.toFixed(0)} Tage`:'';
const queue=rec.queue?.estimatedDays;
const queueInfo=Number.isFinite(queue)?` · Sell-Queue ≈ ${queue.toFixed(1)} Tage`:'';
if(rec.action==='SELLKEEP')parts.push(`🟢 VERKAUF LIEGEN LASSEN ${rec.currentBuyerPay}${ageText}${queueInfo}. ${rec.reason}`);
if(rec.action==='SELLRAISE')parts.push(`🔵 VERKAUF HÖHER SETZEN ${rec.currentBuyerPay} → ${rec.target}${ageText}${queueInfo}. ${rec.reason}`);
if(rec.action==='SELLLOWER')parts.push(`🟠 VERKAUF REALISTISCHER SETZEN ${rec.currentBuyerPay} → ${rec.target}${ageText}${queueInfo}. ${rec.reason}`);
if(rec.action==='SELLCANCEL')parts.push(`🔴 VERKAUF ZURÜCKHOLEN ${rec.currentBuyerPay}. ${rec.reason}`);
if(rec.action==='SELLCONFIRM')parts.push(`🟡 STEAM-BESTÄTIGUNG AUSSTEHEND ${rec.currentBuyerPay}. ${rec.reason}`);
if(rec.action==='SELLHOLD')parts.push(`🟣 STEAM-MARKET-HOLD ${rec.currentBuyerPay}. ${rec.reason}`);
}
if(salePortfolio.newSaleRecommendation){const rec=salePortfolio.newSaleRecommendation;if(rec.action==='HOLD')parts.push(`🟡 HALTEN: ${rec.quantity}× aktuell nicht billig abgeben.${rec.target?` Trigger etwa ${rec.target}.`:''} ${rec.reason}`);else parts.push(`${rec.reserveClass==='TACTICAL_FUTURE_SALE'||rec.reserveClass==='MIXED'?'🟠 TAKTISCH VERKAUFEN':'🟠 ECHTER ÜBERSCHUSS'}: ${rec.quantity}× bei Käuferpreis ${rec.target}. ${rec.reason}`);}
if(salePortfolio.temporarilyUnmarketableInventoryCopies>0)parts.push(`🟡 ${salePortfolio.temporarilyUnmarketableInventoryCopies} potenzielle Verkaufskopie(n) sind aktuell nicht als marketable erkannt – später erneut prüfen.`);
if((salePortfolio.currentCraftReserveCopies>0||salePortfolio.protectedFutureCraftReserveCopies>0)&&!salePortfolio.newSaleRecommendation&&(salePortfolio.listingRecommendations||[]).length===0){parts.push(`🟢 RESERVE BEHALTEN: ${salePortfolio.currentCraftReserveCopies||0}× Current-Craft + ${salePortfolio.protectedFutureCraftReserveCopies||0}× Future-Craft; nicht verkaufen.`);}
}

if(
!card.isBadgeCard
){
parts.unshift(
'Kein Badge-Bezug erkannt – Marktauftrag separat geprüft.'
);
}

if(
!parts.length
){
parts.push(
'🟢 Markt aktiv – aktuell kein Eingriff nötig.'
);
}

return{
review:
cardNeedsReview(
card
),

text:
parts.join(
' '
)
};
}

function economicsText(
group
){
const economics=
group
.setEconomicsPrecheck;

if(
!economics
){
return'';
}

const lead=
economics.status===
'stop-candidate'
?'🔴 SET-STOP-/PAUSEN-KANDIDAT'
:economics.status===
'review'
?'🟡 SET GENAUER PRÜFEN'
:'🟢 SET-VORPRÜFUNG OK';

return(
`${lead}: `+
economics.reasons
.join(
' '
)
);
}

function createModal(){
document
.getElementById(
'sbw-overlay'
)
?.remove();

const overlay=
document.createElement(
'div'
);

overlay.id=
'sbw-overlay';

overlay.innerHTML=`
<div class="sbw-modal">
<h2>🧹 Portfolio-Wächter 3.2.1: Kaufen + Badges + Verkaufsstatus</h2>

<div id="sbw-sub" class="sbw-muted">
Kaufaufträge sowie aktive, gehaltene und unbestätigte Verkaufsangebote werden eingelesen …
</div>

<div class="sbw-info" style="margin-top:8px">
<b>Wichtig:</b>
Die Kernanalyse holt Badge-Besitz, aktive Kauf- und Verkaufspositionen, Orderbuch, Sell-Depth und Historie selbst frisch von Steam.
Shared-Intel wird nur als Bonus zwischen den Tools gespeichert, nicht als Ersatz für aktuelle Marktdaten.
Zurückgehaltene Listings werden zusätzlich aus der vollständigen Marktübersicht gelesen und mit dem aktiven Listing-Endpunkt abgeglichen. Eine erkennbare Zähldifferenz wird als Warnung ausgegeben.
<br>
<b>Strategie:</b>
Lange günstige Kaufaufträge sind ausdrücklich okay.
Queue und Alter allein sind kein Grund für +0,01 €; KEEP ist der Standard.
Materiell überhöhte eigene Buy-Stufen werden erst nach Herausrechnen der eigenen Menge als mögliche SENKEN-Kandidaten markiert.
Steam-Bestätigung und Market Hold zählen nicht als aktive Verkaufszeit.
</div>

<div class="sbw-toolbar">
<button id="sbw-plan-open" class="sbw-blue" disabled>🛠 Aktionsplan</button>
<button id="sbw-copy" class="sbw-good" disabled>📋 Audit kopieren</button>
<button id="sbw-copy-red" class="sbw-blue" disabled>📋 Nur rote Gruppen</button>
<button id="sbw-stop" class="sbw-danger">■ Stoppen</button>
<button id="sbw-close" class="sbw-gray">Schließen</button>
</div>

<div id="sbw-progress-wrap">
<div id="sbw-progress"></div>
</div>

<div id="sbw-summary" class="sbw-muted"></div>
<div id="sbw-list"></div>

<div class="sbw-actions">
<button id="sbw-clear" class="sbw-gray">🧹 Lokale Hilfsdaten löschen</button>
</div>
</div>`;

document.body.appendChild(
overlay
);

STATE.modal=
overlay;

overlay
.querySelector(
'#sbw-stop'
)
.onclick=
()=>{
STATE.stopRequested=
true;

const button=
overlay
.querySelector(
'#sbw-stop'
);

button.disabled=
true;

button.textContent=
'Stop wird ausgeführt …';
};

overlay
.querySelector(
'#sbw-close'
)
.onclick=
()=>{
if(
STATE.running&&
!confirm(
'Prüfung läuft noch. Wirklich schließen? Steam-Aufträge werden nicht verändert.'
)
){
return;
}

if(
STATE.running
){
STATE.stopRequested=
true;
}

overlay.remove();
};

overlay
.querySelector(
'#sbw-copy'
)
.onclick=
()=>
copyAudit(
false
);

overlay
.querySelector(
'#sbw-copy-red'
)
.onclick=
()=>
copyAudit(
true
);

overlay
.querySelector(
'#sbw-plan-open'
)
.onclick=
openActionPlan;

overlay
.querySelector(
'#sbw-clear'
)
.onclick=
()=>{
if(
!confirm(
'Item-ID-Cache, Beobachtungsalter und gespeicherten Aktionsplan löschen? Steam-Aufträge selbst werden NICHT verändert.'
)
){
return;
}

try{
Object.values(
KEYS
)
.forEach(
key=>
localStorage.removeItem(
key
)
);
}catch{}

alert(
'Lokale Hilfsdaten gelöscht. Auf Steam wurde nichts geändert.'
);
};
}

function updateMainStatus(
text
){
const sub=
STATE.modal
?.querySelector(
'#sbw-sub'
);

if(
sub
){
sub.textContent=
text;
}
}

function setProgress(
done,
total
){
const bar=
STATE.modal
?.querySelector(
'#sbw-progress'
);

if(
bar
){
bar.style.width=
`${total
?Math.round(
done/
total*
100
)
:0}%`;
}

const summary=
STATE.modal
?.querySelector(
'#sbw-summary'
);

if(
summary
){
summary.textContent=
`${done}/${total}`;
}
}

function renderGroups(){
const list=
STATE.modal
?.querySelector(
'#sbw-list'
);

if(
!list
){
return;
}

list.innerHTML=
'';

for(const group of
STATE.groups
){
const div=
document.createElement(
'div'
);

div.className=
`sbw-group ${
group
.technicalSetStatus===
'red'
?'red'
:'green'
}`;

const statusText=
group
.technicalSetStatus===
'red'
?'🔴 wirklich prüfen'
:'🟢 aktuell okay';

const reasons=
(
group
.technicalReasons||
[]
)
.join(
' · '
);

let cardsHtml=
'';

for(const card of
group.cards||
[]
){
const message=
friendlyCardMessage(
card
);

const orderText=
card.activeOrder
?`Gebot ${card.activeOrder.ownBid}`
:'kein Gebot';

const cardSellStates=sellListingStateCounts(card.activeSellListings||[]);
const sellText=cardSellStates.total
?` · Verkäufe aktiv ${cardSellStates.active}${cardSellStates.hold?` / Hold ${cardSellStates.hold}`:''}${cardSellStates.awaiting?` / Bestätigung ${cardSellStates.awaiting}`:''}`
:'';
const contextText=
card.isBadgeCard
?`Besitz ${card.inventoryOwned ?? card.owned ?? '?'} · ${orderText}${sellText}`
:`${orderText}${sellText}`;

cardsHtml+=`
<div class="sbw-card ${message.review ? 'sbw-red' : 'sbw-muted'}">
<div class="sbw-card-title">${escapeHtml(card.badgeName)}</div>
<div>${escapeHtml(contextText)}</div>
<div class="sbw-card-note">${escapeHtml(message.text)}</div>
</div>`;
}

let headline;
let badgeGoalHtml='';

if(
group.groupKind===
'badge'
){
const goal=group.badgeGoal||resolveBadgeGoal(group);
if(group.badgeMaxed){
badgeGoalHtml=`<div class="sbw-goal"><b>🎯 Badge-Ziel:</b> Level 5/5 erreicht</div>`;
}else{
const current=Math.max(0,Number(group.badgeLevel)||0);
let options=`<option value=""${goal.confirmed?'':' selected'}>ungeklärt – Reserve bis Level 5 schützen</option>`;
for(let level=current;level<=CFG.normalBadgeMaxLevel;level++){
const selected=goal.confirmed&&Number(goal.targetLevel)===level?' selected':'';
const label=level===current?`bei Level ${level} stoppen`:`bis Level ${level} weiterbauen`;
options+=`<option value="${level}"${selected}>${label}</option>`;
}
badgeGoalHtml=`
<div class="sbw-goal">
<b>🎯 Badge-Ziel:</b>
<select data-sbw-goal-appid="${escapeHtml(group.gameAppId)}">${options}</select>
<span class="sbw-goal-note">${escapeHtml(goal.label)}. Änderung gilt ab der nächsten Prüfung.</span>
</div>`;
}
headline=
group.badgeMaxed
?(
`${statusText} · `+
`Badge-Level ${group.badgeLevel ?? 5}/5 MAX · `+
`normaler Kauf beendet · `+
`${group.saleCandidateCount ?? 0} Verkaufs-Kandidat(en) · `+
`${group.marketActiveSellListingsCount ?? 0} aktive Verkäufe · `+
`${group.marketHoldListingsCount ?? 0} Hold · `+
`${group.awaitingConfirmationListingsCount ?? 0} unbestätigt · `+
`${group.activeOrdersCount ?? 0} Kaufaufträge`
)
:(
`${statusText} · `+
`Badge-Level ${group.badgeLevel ?? '—'} · `+
`Ziel ${group.plannedBadgeTargetLevel ?? '—'}/5${group.badgeGoal?.confirmed?'':'?'} · `+
`${group.missingForNextCraftCount ?? '—'} fehlend · `+
`${group.futureCraftReserveCopies ?? 0} Future-Reserve · `+
`${group.trueSurplusCopies ?? 0} echter Überschuss · `+
`${group.tacticalFutureSaleCopies ?? 0} taktischer Verkauf · `+
`${group.marketActiveSellListingsCount ?? 0} aktive Verkäufe · `+
`${group.marketHoldListingsCount ?? 0} Hold · `+
`${group.awaitingConfirmationListingsCount ?? 0} unbestätigt · `+
`${group.buyLowerCandidateCount ?? 0} Buy-Senkung(en) · `+
`${group.activeOrdersCount ?? 0} Kaufaufträge`
);

}else if(
group.groupKind===
'badge-error'
){
headline=
`${statusText} · `+
`Badge-Zustand unbekannt · `+
`${group.activeOrdersCount ?? 0} Kaufaufträge · `+
`${group.marketActiveSellListingsCount ?? 0} aktive Verkäufe · `+
`${group.marketHoldListingsCount ?? 0} Hold · `+
`${group.awaitingConfirmationListingsCount ?? 0} unbestätigt`;

}else{
headline=
`${statusText} · `+
`kein Badge-Bezug · `+
`${group.activeOrdersCount ?? 0} Kaufaufträge · `+
`${group.marketActiveSellListingsCount ?? 0} aktive Verkäufe · `+
`${group.marketHoldListingsCount ?? 0} Hold · `+
`${group.awaitingConfirmationListingsCount ?? 0} unbestätigt`;
}

div.innerHTML=`
<b>${escapeHtml(group.gameName || group.gameAppId)}</b>
<div class="${group.technicalSetStatus === 'red' ? 'sbw-red' : 'sbw-green'}">${escapeHtml(headline)}</div>
<div class="sbw-muted">${escapeHtml(reasons)}</div>
${badgeGoalHtml}
${
group.setEconomicsPrecheck
?`
<div class="${group.setEconomicsPrecheck.status === 'green' ? 'sbw-green' : 'sbw-warn'}" style="margin-top:5px">
${escapeHtml(economicsText(group))}
</div>
`
:''
}
${cardsHtml}
`;

list.appendChild(
div
);

const goalSelect=div.querySelector('[data-sbw-goal-appid]');
if(goalSelect){
goalSelect.onchange=()=>{
const value=goalSelect.value;
setBadgeGoal(group.gameAppId,value===''?null:Number(value),group.gameName);
const note=goalSelect.parentElement?.querySelector('.sbw-goal-note');
if(note)note.textContent=value===''?'Ziel gelöscht. Bis zur Klärung wird vorsorglich bis Level 5 geschützt. Prüfung bitte neu starten.':`Ziel Level ${value}/5 gespeichert. Prüfung bitte neu starten.`;
};
}
}
}

async function runAudit(){
if(STATE.running)return;
STATE.running=true;STATE.stopRequested=false;STATE.generated=null;STATE.groups=[];STATE.ownedCardApps=new Map();STATE.sellListings=[];STATE.marketOverviewHtml=null;STATE.sellListingCoverage=null;STATE.steamId64=null;STATE.discoveryWarning=null;STATE.sellListingWarning=null;resetStats();createModal();
try{
STATE.profileBase=detectProfileBase();
if(!STATE.profileBase)throw new Error('Dein Steam-Profil-Link konnte auf der Marktseite nicht erkannt werden.');
updateMainStatus('Aktive Kaufaufträge werden eingelesen …');
STATE.orders=await loadAllBuyOrders();
const watch=updateOrderWatch(STATE.orders);
const cache=loadItemIdCache();
if(CFG.scanActiveSellListings){
try{updateMainStatus('Verkaufsangebote einschließlich Steam-Bestätigung und Market Hold werden vollständig eingelesen …');STATE.sellListings=await loadAllSellListings();}
catch(error){STATE.sellListingWarning=String(error?.message||error);STATE.sellListings=[];}
}
const sellWatch=updateSellWatch(STATE.sellListings);
const sellStates=sellListingStateCounts();
if(CFG.discoverOwnedCardSets){try{STATE.ownedCardApps=await loadOwnedNormalTradingCardApps();}catch(error){STATE.discoveryWarning=String(error?.message||error);STATE.ownedCardApps=new Map();}}
const orderApps=new Set(STATE.orders.map(order=>order.gameAppId).filter(Boolean));
const sellApps=new Set(STATE.sellListings.map(s=>s.gameAppId).filter(Boolean));
const candidateApps=new Set([...orderApps,...sellApps,...STATE.ownedCardApps.keys()]);
const hasUnknownBucket=STATE.orders.some(order=>!order.gameAppId)||STATE.sellListings.some(s=>!s.gameAppId);
const buckets=candidateApps.size+(hasUnknownBucket?1:0);
if(!STATE.orders.length&&!STATE.sellListings.length&&!STATE.ownedCardApps.size){throw new Error((STATE.discoveryWarning||STATE.sellListingWarning)?`Keine Position erkannt. Hinweise: ${[STATE.discoveryWarning,STATE.sellListingWarning].filter(Boolean).join(' · ')}`:'Keine aktiven Kaufaufträge, Verkaufsangebote oder eigenen normalen Sammelkarten erkannt.');}
updateMainStatus(`${STATE.orders.length} Kaufaufträge · Verkäufe: ${sellStates.active} aktiv, ${sellStates.hold} Hold, ${sellStates.awaiting} unbestätigt · ${STATE.ownedCardApps.size} Apps mit normalen Inventarkarten. Badge-Ziele, Reserven, konkurrenzbereinigte Buy-Preise, Sell-Nachfrage und Historien werden geprüft …`);
setProgress(0,Math.max(1,buckets));
STATE.groups=await buildGroups(STATE.orders,cache,watch,STATE.ownedCardApps,STATE.sellListings,sellWatch);
STATE.generated=new Date().toISOString();renderGroups();setProgress(Math.max(1,buckets),Math.max(1,buckets));
}catch(error){updateMainStatus(`Fehler: ${String(error?.message||error)}`);}finally{STATE.running=false;finishAudit();}
}

function finishAudit(){
const red=
STATE.groups.filter(
group=>
group
.technicalSetStatus===
'red'
)
.length;

const green=
STATE.groups.filter(
group=>
group
.technicalSetStatus===
'green'
)
.length;

const title=
STATE.modal
?.querySelector(
'h2'
);

const sub=
STATE.modal
?.querySelector(
'#sbw-sub'
);

if(
title
){
title.textContent=
STATE.stopRequested
?`■ Prüfung gestoppt – ${STATE.groups.length} Prüfgruppen ausgewertet`
:`✅ ${STATE.groups.length} Prüfgruppen ausgewertet`;
}

if(
sub
){
const sellStates=sellListingStateCounts();
sub.textContent=
`🟢 ${green} aktuell okay · `+
`🔴 ${red} wirklich prüfen · `+
`${STATE.ownedCardApps.size} App(s) über Inventar · Verkäufe ${sellStates.active} aktiv / ${sellStates.hold} Hold / ${sellStates.awaiting} unbestätigt`+
(
STATE.discoveryWarning
?` · ⚠ Inventar-Hinweis: ${STATE.discoveryWarning}`
:''
)+(STATE.sellListingWarning?` · ⚠ Verkauf-Hinweis: ${STATE.sellListingWarning}`:'');
}

const stop=
STATE.modal
?.querySelector(
'#sbw-stop'
);

if(
stop
){
stop.style.display=
'none';
}

for(const selector of[
'#sbw-copy',
'#sbw-copy-red',
'#sbw-plan-open'
]){
const button=
STATE.modal
?.querySelector(
selector
);

if(
button
){
button.disabled=
false;
}
}
}

function compactCard(card){
return{
isBadgeCard:
card.isBadgeCard!==
false,

badgeName:
card.badgeName,

owned:
card.owned,

inventoryOwned:
card.inventoryOwned??
null,

inventoryMatch:
card.inventoryMatch||
null,

inventoryMarketHashName:
card
.inventoryMarketHashName||
null,

inventoryMarketableCopies:
card
.inventoryMarketableCopies??
null,

inventoryTradableCopies:
card
.inventoryTradableCopies??
null,

needed:
card.needed,

effectiveNeededForNextCraft:
card.effectiveNeededForNextCraft??null,

activeOrder:
card.activeOrder
?{
orderId:
card
.activeOrder
.orderId,

quantity:
card
.activeOrder
.quantity,

ownBidCents:
card
.activeOrder
.ownBidCents,

ownBid:
card
.activeOrder
.ownBid,

marketHashName:
card
.activeOrder
.marketHashName,

likelyTradingCard:
card
.activeOrder
.likelyTradingCard??
null
}
:null,

activeSellListings:
Array.isArray(card.activeSellListings)
?card.activeSellListings.map(listing=>({
listingId:listing.listingId,
buyerPayCents:listing.buyerPayCents,
buyerPay:listing.buyerPay,
sellerReceivesCents:listing.sellerReceivesCents,
sellerReceives:listing.sellerReceives,
listedDateText:listing.listedDateText,
listedAt:listing.listedAt,
listedAgeDays:listing.listedAgeDays,
listingState:listing.listingState||'ACTIVE',
needConfirmation:Boolean(listing.needConfirmation),
marketHold:Boolean(listing.marketHold),
holdUntil:listing.holdUntil||null,
holdRemainingDays:listing.holdRemainingDays??null,
listingStatusText:listing.listingStatusText||'',
listingSource:listing.listingSource||null,
listingSources:Array.isArray(listing.listingSources)?listing.listingSources:listing.listingSource?[listing.listingSource]:[],
stateDetectionSource:listing.stateDetectionSource||null,
stateDetectionEvidence:listing.stateDetectionEvidence||'',
marketHashName:listing.marketHashName,
marketUrl:listing.marketUrl,
isFoil:listing.isFoil
}))
:[],

totalPositionCopies:
card.totalPositionCopies??null,

orderMatch:
card.orderMatch||
null,

marketHashName:
card.marketHashName||
null,

resolvedMarketName:
card
.resolvedMarketName||
null,

resolution:
card.resolution||
null,

resolutionScore:
card.resolutionScore??
null,

marketStatus:
card.marketStatus,

marketStatusReason:
card
.marketStatusReason,

market:
card.market||
null,

history:
card.history||
null,

historyError:
card.historyError||
null,

ownQueue:
card.ownQueue||
null,

marketHealth:
card.marketHealth||
null,

buyPriceAnalysis:
card.buyPriceAnalysis||
null,

saleAnalysis:
card.saleAnalysis||
null,

orderWatch:
card.orderWatch||
null,

flags:
card.flags||
[],

error:
card.error||
null
};
}

function compactGroup(group){
return{
groupKind:
group.groupKind||
'badge',

gameAppId:
group.gameAppId,

gameName:
group.gameName,

badgeUrl:
group.badgeUrl,

badgeLevel:
group.badgeLevel,

badgeMaxed:
group.badgeMaxed,

badgeGoal:
group.badgeGoal||
null,

plannedBadgeTargetLevel:
group.plannedBadgeTargetLevel??
null,

badgeGoalNeedsDecision:
Boolean(group.badgeGoalNeedsDecision),

normalBadgeFurtherCraftPossible:
group
.normalBadgeFurtherCraftPossible??
null,

targetCopiesPerCard:
group
.targetCopiesPerCard,

discoveredFromInventory:
Boolean(
group
.discoveredFromInventory
),

discoveryOnly:
Boolean(
group.discoveryOnly
),

inventoryOwnedCopies:
group
.inventoryOwnedCopies||
0,

inventoryCards:
Array.isArray(
group.inventoryCards
)
?group.inventoryCards.map(
item=>({
cardName:
item.cardName,

marketHashName:
item
.marketHashName,

quantity:
item.quantity,

marketableCopies:
item
.marketableCopies,

tradableCopies:
item
.tradableCopies
})
)
:[],

cardCount:
group.cardCount,

ownedForNextCraftCount:
group
.ownedForNextCraftCount,

missingForNextCraftCount:
group
.missingForNextCraftCount,

ownedInventoryCardKindsCount:
group
.ownedInventoryCardKindsCount??
null,

ownedInventoryCopiesAnalyzed:
group
.ownedInventoryCopiesAnalyzed??
null,

saleCandidateCount:
group
.saleCandidateCount??
null,

saleAnalyzedCount:
group
.saleAnalyzedCount??
null,

saleAnalysisErrorCount:
group
.saleAnalysisErrorCount??
null,

saleCandidateCards:
group
.saleCandidateCards||
[],

activeSellListingsCount:
group.activeSellListingsCount??0,

marketActiveSellListingsCount:
group.marketActiveSellListingsCount??0,

marketHoldListingsCount:
group.marketHoldListingsCount??0,

awaitingConfirmationListingsCount:
group.awaitingConfirmationListingsCount??0,

newSellCandidateCopies:
group.newSellCandidateCopies??0,

sellAdjustmentCount:
group.sellAdjustmentCount??0,

buyLowerCandidateCount:
group.buyLowerCandidateCount??0,

buyPriceReviewCount:
group.buyPriceReviewCount??0,

currentCraftReserveCopies:
group.currentCraftReserveCopies??0,

futureCraftReserveCopies:
group.futureCraftReserveCopies??0,

protectedFutureCraftReserveCopies:
group.protectedFutureCraftReserveCopies??0,

trueSurplusCopies:
group.trueSurplusCopies??0,

tacticalFutureSaleCopies:
group.tacticalFutureSaleCopies??0,

activeOrdersCount:
group
.activeOrdersCount,

missingWithoutOrderCount:
group
.missingWithoutOrderCount,

missingWithoutOrder:
group
.missingWithoutOrder,

redundantOrdersCount:
group
.redundantOrdersCount,

redundantOrders:
group
.redundantOrders,

unmarketableMissingCount:
group
.unmarketableMissingCount,

unmarketableMissing:
group
.unmarketableMissing,

noSellerMissingCount:
group
.noSellerMissingCount,

noRecentTradeMissingCount:
group
.noRecentTradeMissingCount,

unmatchedOrdersCount:
group
.unmatchedOrdersCount,

flaggedCardsCount:
group
.flaggedCardsCount,

actionRequiredCardsCount:
group
.actionRequiredCardsCount,

informationalBelowTopCount:
group
.informationalBelowTopCount,

instantBuyComplete:
group
.instantBuyComplete,

instantBuyMissingTotalCents:
group
.instantBuyMissingTotalCents,

instantBuyMissingTotal:
group
.instantBuyMissingTotal,

instantBuyKnownSubtotalCents:
group
.instantBuyKnownSubtotalCents,

instantBuyKnownSubtotal:
group
.instantBuyKnownSubtotal,

setEconomicsPrecheck:
group
.setEconomicsPrecheck||
null,

reinvestmentNote:
group
.reinvestmentNote||
null,

technicalSetStatus:
group
.technicalSetStatus,

technicalReasons:
group
.technicalReasons,

badgeError:
group.badgeError||
null,

cards:
(
group.cards||
[]
)
.map(
compactCard
)
};
}

function makeAuditOutput(
onlyRed=false
){
const groups=
onlyRed
?STATE.groups
.filter(
group=>
group
.technicalSetStatus===
'red'
)
:STATE.groups;

return{
schemaVersion:
14,

analyzerVersion:
'3.2.1',

watcherVersion:
'3.2.1',

generated:
STATE.generated||
new Date()
.toISOString(),

sourcePage:
location.href,

profileBase:
STATE.profileBase,

ordersDetected:
STATE.orders.length,

sellListingsDetected:
STATE.sellListings.length,

activeSellListingsDetected:
STATE.sellListings.filter(listing=>(listing.listingState||'ACTIVE')==='ACTIVE').length,

marketHoldListingsDetected:
STATE.sellListings.filter(listing=>listing.listingState==='MARKET_HOLD').length,

awaitingConfirmationListingsDetected:
STATE.sellListings.filter(listing=>listing.listingState==='AWAITING_CONFIRMATION').length,

uniqueAppIdsDetected:
new Set(
STATE.orders
.map(
order=>
order.gameAppId
)
.filter(
Boolean
)
)
.size,

ownedNormalTradingCardAppIdsDetected:
STATE
.ownedCardApps
.size,

badgeCandidateAppIdsDetected:
new Set([
...STATE.orders.map(order=>order.gameAppId).filter(Boolean),
...STATE.sellListings.map(listing=>listing.gameAppId).filter(Boolean),
...STATE.ownedCardApps.keys()
]).size,

activeSellAppIdsDetected:
new Set(STATE.sellListings.filter(listing=>(listing.listingState||'ACTIVE')==='ACTIVE').map(listing=>listing.gameAppId).filter(Boolean)).size,

ownedCardDiscoveryEnabled:
Boolean(
CFG
.discoverOwnedCardSets
),

ownedCardSaleScanEnabled:
Boolean(
CFG
.scanOwnedCardsForSale
),

maxedBadgeSaleScanEnabled:
Boolean(
CFG
.scanMaxedBadgesForSale
),

ownedCardDiscoveryWarning:
STATE
.discoveryWarning,

activeSellListingWarning:
STATE.sellListingWarning,

activeSellListingCoverage:
STATE.sellListingCoverage,

groupsDetected:
STATE.groups.length,

badgeGroupsDetected:
STATE.groups
.filter(
group=>
group.groupKind===
'badge'
)
.length,

maxedBadgeGroupsDetected:
STATE.groups
.filter(
group=>
group.groupKind===
'badge'&&
group.badgeMaxed
)
.length,

saleCandidatesDetected:
STATE.groups
.reduce(
(
sum,
group
)=>
sum+
Number(
group
.saleCandidateCount||
0
),
0
),

badgeGoalsNeedingDecision:
STATE.groups.filter(group=>group.badgeGoalNeedsDecision).length,

currentCraftReserveCopiesDetected:
STATE.groups.reduce((sum,group)=>sum+Number(group.currentCraftReserveCopies||0),0),

futureCraftReserveCopiesDetected:
STATE.groups.reduce((sum,group)=>sum+Number(group.futureCraftReserveCopies||0),0),

trueSurplusCopiesDetected:
STATE.groups.reduce((sum,group)=>sum+Number(group.trueSurplusCopies||0),0),

tacticalFutureSaleCopiesDetected:
STATE.groups.reduce((sum,group)=>sum+Number(group.tacticalFutureSaleCopies||0),0),

newSellCandidateCopiesDetected:
STATE.groups.reduce((sum,group)=>sum+Number(group.newSellCandidateCopies||0),0),

activeSellAdjustmentsDetected:
STATE.groups.reduce((sum,group)=>sum+Number(group.sellAdjustmentCount||0),0),

buyLowerCandidatesDetected:
STATE.groups.reduce((sum,group)=>sum+Number(group.buyLowerCandidateCount||0),0),

buyPriceReviewsDetected:
STATE.groups.reduce((sum,group)=>sum+Number(group.buyPriceReviewCount||0),0),

queueEstimateVersion:
'v3.2.1-own-order-adjusted-buy-plus-demand-aware-sell-hold-portfolio',

marketRiskVersion:
'v3.2.1-buy-competition-sell-demand-listing-state-reserves-net-rebuy',

historyAnalysisVersion:
'v3.2-all-365-90-30-7-plus-exact-calendar-series',

queueEstimateNote:
'Queue-Tage sind nur ein Durchsatz-Proxy: Aufträge auf/über eigenem Preis geteilt durch 30-Kalendertage-Handelsvolumen. Nicht jeder Marktverkauf trifft den Buy-Order-Book-Level.',

historyAnalysisNote:
'Steam-Preisverlaufswerte sind Marktpreis-/Medianpunkte und beweisen nicht, zu welchem Buy-Order-Preis einzelne Verkäufe ausgeführt wurden.',

coverageNote:
'Aktive Kaufaufträge + von Steams My-Listings-Endpunkt gelieferte aktive, gehaltene oder unbestätigte Community-Market-Verkaufsangebote für App 753 + normale Inventarkarten. Bei Badge-Level 0–4 werden Kopien bis zum gespeicherten Badge-Ziel in Current- und Future-Craft-Reserve getrennt. Ohne Ziel wird vorsorglich bis Level 5 geschützt. Nur echter Überschuss oder ein streng positiver Netto-Rückkauffall wird zum Verkauf freigegeben. Nicht-753-Marktobjekte wie CS2-Skins werden bewusst nicht in die Karten-Portfolioanalyse gezogen.',

strategyProfile:{
name:
'patient-low-bid-high-patience-sell-efficiency',

priority:
'maximale Badge-Fortschritte pro Euro statt maximale Geschwindigkeit je Einzelorder',

orderAgeInfoDays:
CFG.staleDaysReview,

orderAgeReviewDays:
CFG.veryStaleDaysReview,

queueInfoDays:
CFG.crowdedQueueDays,

rule:
'BUY: KEEP ist Standard; eigenes Gebot vor einer Senkung aus der Buy-Stufe herausrechnen, mindestens 0,02 EUR und 20 Prozent materielle Ersparnis verlangen und Prioritätsverlust nennen. SELL: Badge-Ziel vor Duplikatverkauf beachten; Nachfrage, Sell-Queue und Historie gemeinsam prüfen. Steam-Bestätigung und Market Hold nicht als aktive Verkaufszeit behandeln.',

buyStrategy:{lowerMinimumSavingsCents:CFG.buyLowerMinSavingsCents,lowerMinimumSavingsPct:CFG.buyLowerMinSavingsPct*100,targetStepAboveExternalCents:CFG.buyLowerStepAboveExternalCents,maxTargetQueueDays:CFG.buyLowerMaxTargetQueueDays,minimumDailyVolume30d:CFG.buyLowerMinDailyVolume,minimumActiveTradingDays30d:CFG.buyLowerMinActiveDays30d,priorityWarning:'Jede Preisänderung kann die bisherige Steam-Queue-Priorität verlieren.'},

sellStrategy:{preferredQueueDays:CFG.preferredSellQueueDays,reviewAgeDays:CFG.sellAgeReviewDays,hardReviewAgeDays:CFG.sellAgeHardReviewDays,hardQueueDays:CFG.hardSellQueueDays,absurdQueueDays:CFG.absurdSellQueueDays,priceField:'Käufer zahlt',demandNearLevels:CFG.sellDemandNearLevels,listingStates:['ACTIVE','AWAITING_CONFIRMATION','MARKET_HOLD'],pendingUnderpriceMinimumCents:CFG.sellPendingUnderpriceMinCents,pendingUnderpriceMinimumPct:CFG.sellPendingUnderpriceMinPct*100,futureReserve:{unknownGoalPolicy:'protect-to-level-5',minimumPremiumPct:CFG.futureReserveSellPremiumPct*100,minimumGrossGapCents:CFG.futureReserveSellMinGrossGapCents,minimumEstimatedNetGainCents:CFG.futureReserveSellMinNetGainCents,minimumNetRoiPct:CFG.futureReserveSellMinNetRoiPct*100,minimumDailyVolume30d:CFG.futureReserveSellMinDailyVolume,minimumActiveTradingDays30d:CFG.futureReserveSellMinActiveDays30d,maxTacticalCopiesPerCard:CFG.futureReserveMaxTacticalCopiesPerCard,historyWindowsDays:[7,30,90,365]}}
},

automationNote:
'Das Skript kauft, storniert und verkauft niemals automatisch.',

requestStats:
STATE.stats,

groups:
groups.map(
compactGroup
)
};
}

async function copyAudit(
onlyRed
){
const output=
JSON.stringify(
makeAuditOutput(
onlyRed
),
null,
2
);

const button=
STATE.modal
?.querySelector(
onlyRed
?'#sbw-copy-red'
:'#sbw-copy'
);

try{
await navigator.clipboard
.writeText(
output
);

if(
button
){
const old=
button.textContent;

button.textContent=
'✓ Kopiert';

setTimeout(
()=>{
if(
button.isConnected
){
button.textContent=
old;
}
},
1200
);
}

}catch{
prompt(
'Audit kopieren:',
output
);
}
}

function actionLookupItems(){
const items=[];

for(const group of
STATE.groups
){
for(const card of
group.cards||
[]
){
items.push({
group,
card,
gameName:
group.gameName||
group.gameAppId,
cardName:
card.badgeName,
marketUrl:
card.marketUrl||
(
card.marketHashName
?marketUrl(
card
.marketHashName
)
:null
),
activeOrder:
card.activeOrder
});
}
}

return items;
}

function normalizeKey(
value
){
return clean(
value
)
.toLowerCase();
}

function parseActionPlan(
text
){
const items=
actionLookupItems();

const byName=
new Map();

const byGame=
new Map();

for(const item of items){
byName.set(
`${normalizeKey(item.gameName)}||${normalizeKey(item.cardName)}`,
item
);

if(
item.group
?.groupKind===
'badge'&&
!byGame.has(
normalizeKey(
item.gameName
)
)
){
byGame.set(
normalizeKey(
item.gameName
),
item.group
);
}
}

const actions=[];
const setVerdicts=[];
const invalid=[];

for(const raw of
String(
text||
''
)
.split(
/\r?\n/
)
){
const line=
raw.trim();

if(
!line||
line.startsWith(
'#'
)
){
continue;
}

const parts=
line
.split(
'|'
)
.map(
clean
);

const action=
String(
parts[0]||
''
)
.toUpperCase();

if(action==='SETGOAL'&&parts.length>=3){
const group=byGame.get(normalizeKey(parts[1]));
const targetLevel=Number(parts[2]);
const currentLevel=Number(group?.badgeLevel||0);
if(!group||!Number.isInteger(targetLevel)||targetLevel<currentLevel||targetLevel>CFG.normalBadgeMaxLevel){invalid.push(line);continue;}
setVerdicts.push({action,group,targetLevel,reason:parts.slice(3).join(' | '),raw:line});
continue;
}

if(
[
'SETOK',
'SETSTOP',
'SETWAIT',
'SETPASSIVE'
]
.includes(
action
)&&
parts.length>=
2
){
const group=
byGame.get(
normalizeKey(
parts[1]
)
);

if(
!group
){
invalid.push(
line
);

continue;
}

setVerdicts.push({
action,
group,
reason:
parts
.slice(
2
)
.join(
' | '
),
raw:
line
});

continue;
}

if(
[
'KEEP',
'CANCEL',
'HOLD',
'SELLKEEP',
'SELLCANCEL',
'SELLHOLD',
'SELLCONFIRM'
]
.includes(
action
)&&
parts.length>=
3
){
const item=
byName.get(
`${normalizeKey(parts[1])}||${normalizeKey(parts[2])}`
);

if(
!item
){
invalid.push(
line
);

continue;
}

const listingStates=sellListingStateCounts(item.card?.activeSellListings||[]);
if(action==='SELLHOLD'&&listingStates.hold<=0){invalid.push(line);continue;}
if(action==='SELLCONFIRM'&&listingStates.awaiting<=0){invalid.push(line);continue;}
if(action==='SELLKEEP'&&listingStates.active<=0){invalid.push(line);continue;}

actions.push({
action,
item,
quantity:
null,
targetCents:
null,
reason:
parts
.slice(
3
)
.join(
' | '
),
raw:
line
});

continue;
}

if(
[
'SET',
'ADD'
]
.includes(
action
)&&
parts.length>=
4
){
const item=
byName.get(
`${normalizeKey(parts[1])}||${normalizeKey(parts[2])}`
);

const cents=
moneyToCents(
parts[3]
);

if(
!item||
cents===
null
){
invalid.push(
line
);

continue;
}

actions.push({
action,
item,
quantity:
null,
targetCents:
cents,
reason:
parts
.slice(
4
)
.join(
' | '
),
raw:
line
});

continue;
}

if(
[
'SELLRAISE',
'SELLLOWER'
]
.includes(action)&&
parts.length>=5
){
const item=byName.get(`${normalizeKey(parts[1])}||${normalizeKey(parts[2])}`);
const quantity=Number(parts[3]);
const cents=moneyToCents(parts[4]);
const activeListingCount=(item?.card?.activeSellListings||[]).filter(listing=>(listing.listingState||'ACTIVE')==='ACTIVE').length;
if(!item||!Number.isInteger(quantity)||quantity<=0||cents===null||activeListingCount<=0||quantity>activeListingCount){invalid.push(line);continue;}
actions.push({action,item,quantity,targetCents:cents,reason:parts.slice(5).join(' | '),raw:line});
continue;
}

if(
action===
'SELL'&&
parts.length>=
5
){
const item=
byName.get(
`${normalizeKey(parts[1])}||${normalizeKey(parts[2])}`
);

const quantity=
Number(
parts[3]
);

const cents=
moneyToCents(
parts[4]
);

const owned=
Number(
item?.card
?.saleAnalysis
?.portfolio
?.saleableInventoryCopies??
item?.card
?.inventoryOwned??
item?.card
?.owned??
0
);

if(
!item||
!Number.isInteger(
quantity
)||
quantity<=
0||
cents===
null||
owned<=0||
quantity>
owned
){
invalid.push(
line
);

continue;
}

actions.push({
action,
item,
quantity,
targetCents:
cents,
reason:
parts
.slice(
5
)
.join(
' | '
),
raw:
line
});

continue;
}

invalid.push(
line
);
}

return{
actions,
setVerdicts,
invalid
};
}

function publishSetVerdicts(
parsed
){
for(const verdict of
parsed.setVerdicts
){
const group=
verdict.group;

if(
!group
?.gameAppId
){
continue;
}

if(verdict.action==='SETGOAL'){
setBadgeGoal(group.gameAppId,verdict.targetLevel,group.gameName);
}else if(verdict.action==='SETSTOP'){
setBadgeGoal(group.gameAppId,Number(group.badgeLevel||0),group.gameName);
}else if(verdict.action==='SETOK'){
const stored=loadBadgeGoals()[String(group.gameAppId)];
if(Number(stored?.targetLevel)<=Number(group.badgeLevel||0))setBadgeGoal(group.gameAppId,null,group.gameName);
}

updateSharedIntel(
group.gameAppId,
{
lastSetDecision:{
action:
verdict.action,

reason:
verdict.reason||
'',

at:
Date.now(),

gameName:
group.gameName,

source:
'badge-watcher-action-plan',

targetLevel:
verdict.targetLevel??null
}
}
);
}
}

function loadDoneActions(){
try{
return new Set(
JSON.parse(
localStorage.getItem(
KEYS.actionDone
)||
'[]'
)
);

}catch{
return new Set();
}
}

function saveDoneActions(
set
){
try{
localStorage.setItem(
KEYS.actionDone,
JSON.stringify([
...set
])
);
}catch{}
}

async function copyPriceAndOpenSteam(
item,
cents
){
const price=
(
cents/
100
)
.toFixed(
2
)
.replace(
'.',
','
);

try{
await navigator.clipboard
.writeText(
price
);

}catch{
prompt(
'Preis:',
price
);
}

if(
!item.marketUrl
){
return alert(
'Für diese Karte ist keine sichere Marktseite bekannt.'
);
}

window.location.href=
`steam://openurl/${item.marketUrl}`;
}

function openExistingOrderInSteam(
item
){
const orderId=
item.activeOrder
?.orderId;

if(
!orderId
){
if(
item.marketUrl
){
window.location.href=
`steam://openurl/${item.marketUrl}`;

return;
}

return alert(
'Für diese Karte gibt es keinen aktiven Kaufauftrag und keine sichere Marktseite.'
);
}

const orderUrl=
`https://steamcommunity.com/market/#mybuyorder_${encodeURIComponent(orderId)}`;

window.location.href=
`steam://openurl/${orderUrl}`;
}

function openExistingSellListingInSteam(item,listingId=null){
const listings=Array.isArray(item?.card?.activeSellListings)?item.card.activeSellListings:[];
const chosen=listingId?listings.find(x=>String(x.listingId)===String(listingId)):listings[0];
if(!chosen){return openMarketOnly(item);}
const url=`https://steamcommunity.com/market/#mylisting_${encodeURIComponent(chosen.listingId)}`;
window.location.href=`steam://openurl/${url}`;
}

async function copyPriceAndOpenExistingSell(item,cents,listingId=null){
const price=(Number(cents)/100).toFixed(2).replace('.',',');
try{await navigator.clipboard.writeText(price);}catch{prompt('Käufer-zahlt-Preis:',price);}
openExistingSellListingInSteam(item,listingId);
}

function sellQueueEstimateForPlan(
item,
targetCents,
quantity=1,
alreadyListed=false
){
const levels=
Array.isArray(
item?.card
?.market
?.sellLevels
)
?item.card
.market
.sellLevels
:[];

const avgDaily=
Number(
item?.card
?.history
?.d30
?.avgDailyVolume||
0
);

if(
!Number.isFinite(
Number(
targetCents
)
)||
!levels.length||
avgDaily<=0
){
return{
offersAhead:
null,

estimatedDays:
null,

avgDaily,

partialDepth:
false
};
}

const target=
Number(
targetCents
);

const sorted=
[
...levels
]
.sort(
(a,b)=>
a.priceCents-
b.priceCents
);

const atOrBelow=
sorted.filter(
level=>
Number(
level.priceCents
)<=
target
);

const offersAhead=
atOrBelow.length
?Number(
atOrBelow
.at(-1)
.cumulativeQuantity||
0
)
:0;

const maxVisiblePrice=
Number(
sorted
.at(-1)
?.priceCents
);

return{
offersAhead,

estimatedDays:
round2(
(
offersAhead+
(alreadyListed?0:Math.max(
1,
Number(
quantity||
1
)
))
)/
avgDaily
),

avgDaily:
round2(
avgDaily
),

partialDepth:
Number.isFinite(
maxVisiblePrice
)&&
target>
maxVisiblePrice
};
}

function openMarketOnly(
item
){
if(
!item.marketUrl
){
return alert(
'Für diese Karte ist keine sichere Marktseite bekannt.'
);
}

window.location.href=
`steam://openurl/${item.marketUrl}`;
}

function planRecommendationLabel(
action,
item,
targetCents,
quantity=null
){
const current=
item.activeOrder
?.ownBidCents;

if(
action===
'KEEP'
){
return{
className:
'sbw-green',

text:
`🟢 BEHALTEN – ${item.activeOrder?.ownBid || 'aktueller Zustand'} passt`
};
}

if(
action===
'HOLD'
){
return{
className:
'sbw-warn',

text:
'🟡 HALTEN – später/bei Trigger erneut prüfen'
};
}

if(action==='SELLKEEP'){
const listings=item?.card?.activeSellListings||[];
return{className:'sbw-green',text:`🟢 VERKAUF LIEGEN LASSEN – ${listings[0]?.buyerPay||'aktiver Preis'} passt`};
}
if(action==='SELLHOLD')return{className:'sbw-info',text:'🟣 STEAM-MARKET-HOLD – nach Freigabe neu prüfen'};
if(action==='SELLCONFIRM')return{className:'sbw-warn',text:'🟡 STEAM-BESTÄTIGUNG AUSSTEHEND – in der App prüfen'};
if(action==='SELLRAISE')return{className:'sbw-info',text:`🔵 VERKAUF HÖHER SETZEN – Ziel ${euro(targetCents)}`};
if(action==='SELLLOWER')return{className:'sbw-warn',text:`🟠 VERKAUF REALISTISCHER SETZEN – Ziel ${euro(targetCents)}`};
if(action==='SELLCANCEL')return{className:'sbw-red',text:'🔴 VERKAUF ZURÜCKHOLEN / Listing entfernen'};

if(
action===
'SELL'
){
const reserveClass=item?.card?.saleAnalysis?.portfolio?.newSaleRecommendation?.reserveClass;
return{
className:
'sbw-warn',

text:
`${reserveClass==='TACTICAL_FUTURE_SALE'||reserveClass==='MIXED'?'🟠 TAKTISCH VERKAUFEN':'🟠 ÜBERSCHUSS VERKAUFEN'} – ${quantity || 1}× · Käuferpreis ${euro(targetCents)}`
};
}

if(
action===
'CANCEL'
){
return{
className:
'sbw-red',

text:
'🔴 STORNIEREN – Kaufauftrag entfernen'
};
}

if(
action===
'ADD'
){
return{
className:
'sbw-red',

text:
`🔴 NEU ANLEGEN – ${euro(targetCents)}`
};
}

if(
action===
'SET'
){
if(
Number.isFinite(
current
)&&
current===
targetCents
){
return{
className:
'sbw-green',

text:
`🟢 BEHALTEN – ${euro(targetCents)} passt`
};
}

if(
Number.isFinite(
current
)&&
targetCents>
current
){
return{
className:
'sbw-red',

text:
`🔴 ERHÖHEN – ${euro(current)} → ${euro(targetCents)}`
};
}

if(
Number.isFinite(
current
)&&
targetCents<
current
){
return{
className:
'sbw-red',

text:
`🔴 SENKEN – ${euro(current)} → ${euro(targetCents)}`
};
}

return{
className:
'sbw-red',

text:
`🔴 PREIS ÄNDERN – Ziel ${euro(targetCents)}`
};
}

return{
className:
'sbw-red',

text:
action
};
}

function openActionPlan(){
document
.getElementById(
'sbw-plan-overlay'
)
?.remove();

const overlay=
document.createElement(
'div'
);

overlay.id=
'sbw-plan-overlay';

overlay.innerHTML=`
<div class="sbw-modal">
<h2>🛠 Aktionsplan – Kaufen, Badge-Ziel, Reserven & aktive Verkäufe</h2>

<div class="sbw-muted">
SETGOAL | Spiel | 5 | Gewünschtes normales Badge-Ziel (aktuelles Level bis 5)<br>
SETOK | Spiel | Grund (hebt ein zuvor gespeichertes Stopp-Ziel auf)<br>
SETWAIT | Spiel | Grund / Trigger<br>
SETPASSIVE | Spiel | Grund / Trigger (günstige bestehende Orders liegen lassen)<br>
SETSTOP | Spiel | Grund (setzt Badge-Ziel auf das aktuelle Level)<br>
KEEP | Spiel | Karte | Grund<br>
SET | Spiel | Karte | 0,05 | Grund<br>
ADD | Spiel | Karte | 0,05 | Grund<br>
CANCEL | Spiel | Karte | Grund<br>
HOLD | Spiel | Karte | Grund / Zeitpunkt / Trigger<br>
SELL | Spiel | Karte | Menge | 0,08 | Grund / Trigger<br>
SELLKEEP | Spiel | Karte | Grund<br>
SELLRAISE | Spiel | Karte | Menge | 0,12 | Grund / Trigger<br>
SELLLOWER | Spiel | Karte | Menge | 0,09 | Grund / Trigger<br>
SELLCANCEL | Spiel | Karte | Grund<br>
SELLHOLD | Spiel | Karte | Grund / Freigabedatum<br>
SELLCONFIRM | Spiel | Karte | Grund
<br><br>
Keine Aktion wird automatisch auf Steam ausgeführt.
SET-Entscheidungen werden als Shared-Intel gespeichert,
damit der Scout sie später als Kontext anzeigen kann;
sie ersetzen dort keine frischen Marktpreise.
</div>

<textarea id="sbw-plan"></textarea>

<div class="sbw-actions">
<button id="sbw-plan-apply" class="sbw-good">Plan übernehmen</button>
<button id="sbw-plan-clear-done" class="sbw-gray">Erledigt-Markierungen löschen</button>
<button id="sbw-plan-close" class="sbw-gray">Schließen</button>
</div>

<div id="sbw-plan-warn" class="sbw-red" style="margin-top:10px"></div>
<div id="sbw-plan-summary" class="sbw-muted" style="margin-top:10px"></div>
<div id="sbw-set-verdicts"></div>
<div id="sbw-plan-list"></div>
</div>`;

document.body.appendChild(
overlay
);

const textarea=
overlay
.querySelector(
'#sbw-plan'
);

try{
textarea.value=
localStorage.getItem(
KEYS.actionPlan
)||
'';
}catch{}

const repaint=(
publishDecisions=false
)=>{
try{
localStorage.setItem(
KEYS.actionPlan,
textarea.value
);
}catch{}

const parsed=
parseActionPlan(
textarea.value
);

if(
publishDecisions
){
publishSetVerdicts(
parsed
);
}

const done=
loadDoneActions();

overlay
.querySelector(
'#sbw-plan-warn'
)
.textContent=
parsed.invalid.length
?(
'Nicht erkannt: '+
parsed.invalid.join(
' | '
)
)
:'';

overlay
.querySelector(
'#sbw-plan-summary'
)
.textContent=
`${parsed.setVerdicts.length} Set-Entscheidung(en) · `+
`${parsed.actions.length} Karten-/Marktentscheidung(en)`;

const verdictBox=
overlay
.querySelector(
'#sbw-set-verdicts'
);

verdictBox.innerHTML=
'';

for(const verdict of
parsed.setVerdicts
){
const isGoal=verdict.action==='SETGOAL';
const isStop=
verdict.action===
'SETSTOP';

const isPassive=
verdict.action===
'SETPASSIVE';

const isWait=
verdict.action===
'SETWAIT'||
isPassive;

const div=
document.createElement(
'div'
);

div.className=
`sbw-set-verdict${isStop ? ' red' : ''}`;

const verdictClass=
isStop
?'sbw-red'
:isWait
?'sbw-warn'
:'sbw-green';

const notStarted=
Number(
verdict.group
?.badgeLevel||
0
)===
0&&
Number(
verdict.group
?.ownedForNextCraftCount||
0
)===
0;

const verdictText=
isGoal
?`🎯 BADGE-ZIEL LEVEL ${verdict.targetLevel}/5 SPEICHERN`
:isStop
?(
notStarted
?'🔴 SET NICHT ANFANGEN'
:'🔴 SETSTOP / NICHT WEITERVERFOLGEN'
)
:isWait
?(
isPassive
?(
notStarted
?'🟡 SET PASSIV BEOBACHTEN / NUR SEHR GÜNSTIG EINSTEIGEN'
:'🟡 SET PASSIV SAMMELN – GÜNSTIGE ORDERS LIEGEN LASSEN'
)
:(
notStarted
?'🟡 SET VORERST NICHT ANFANGEN / SPÄTER PRÜFEN'
:'🟡 SET PAUSIEREN / SPÄTER REINVEST PRÜFEN'
)
)
:(
notStarted
?'🟢 SET ANFANGEN'
:'🟢 SET WEITERVERFOLGEN'
);

div.innerHTML=`
<b class="${verdictClass}">
${verdictText}
</b>

<div>
<b>
${escapeHtml(
verdict.group
.gameName
)}
</b>
</div>

<div class="sbw-plan-reason">
Grund:
${escapeHtml(
verdict.reason||
'Kein Grund im Plan angegeben.'
)}
</div>`;

verdictBox.appendChild(
div
);
}

const list=
overlay
.querySelector(
'#sbw-plan-list'
);

list.innerHTML=
'';

for(const entry of
parsed.actions
){
const{
action,
item,
quantity,
targetCents,
reason
}=
entry;

const doneKey=
`${normalizeKey(item.gameName)}`+
`||${normalizeKey(item.cardName)}`+
`||${action}`+
`||${quantity ?? ''}`+
`||${targetCents ?? ''}`;

const currentBidCents=
item.activeOrder
?.ownBidCents;

const setAlreadyMatches=
action===
'SET'&&
Number.isFinite(
currentBidCents
)&&
currentBidCents===
targetCents;

const canMarkDone=
action===
'ADD'||
action===
'CANCEL'||
action===
'SELL'||
action===
'SELLRAISE'||
action===
'SELLLOWER'||
action===
'SELLCANCEL'||
action===
'SELLCONFIRM'||
(
action===
'SET'&&
!setAlreadyMatches
);

const isDone=
canMarkDone&&
done.has(
doneKey
);

const recommendation=
planRecommendationLabel(
action,
item,
targetCents,
quantity
);

const row=
document.createElement(
'div'
);

row.className=
`sbw-plan-row${isDone ? ' sbw-done' : ''}`;

const buyQueue=
item.card
?.ownQueue
?.estimatedQueueDaysAtOwnPrice;

const sellQueue=
[
'SELL',
'SELLRAISE',
'SELLLOWER'
].includes(action)
?sellQueueEstimateForPlan(
item,
targetCents,
quantity,
action==='SELLRAISE'||action==='SELLLOWER'
)
:null;

const inventoryOwned=
Number(
item.card
?.inventoryOwned??
item.card
?.owned??
0
);

const actionSellStates=sellListingStateCounts(item.card?.activeSellListings||[]);
const activeSellCount=actionSellStates.active;
const sellStateContext=actionSellStates.total
?` · Verkäufe ${actionSellStates.active} aktiv${actionSellStates.hold?` / ${actionSellStates.hold} Hold`:''}${actionSellStates.awaiting?` / ${actionSellStates.awaiting} unbestätigt`:''}`
:'';
const portfolio=item.card?.saleAnalysis?.portfolio;
const reserveText=portfolio
?` · Reserve ${portfolio.currentCraftReserveCopies||0}+${portfolio.protectedFutureCraftReserveCopies||0} · Überschuss ${portfolio.trueSurplusCopies||0}${portfolio.tacticalFutureSaleCopies?` · taktisch frei ${portfolio.tacticalFutureSaleCopies}`:''}`
:'';
const context=
item.card?.isBadgeCard===false
?`kein Badge-Bezug${sellStateContext}`
:`Besitz ${inventoryOwned}${sellStateContext}${reserveText}`;

const currentState=
item.activeOrder?.ownBid||
item.card?.activeSellListings?.[0]?.buyerPay||
(Number.isFinite(item.card?.market?.lowestSellCents)?`Lowest Sell ${item.card.market.lowestSell}`:'kein Gebot/Listing');

const sellQueueText=
sellQueue&&
Number.isFinite(
sellQueue
.estimatedDays
)
?(
` · Sell-Queue Ziel ≈ `+
`${sellQueue.estimatedDays.toFixed(2).replace('.', ',')} Tage`+
(
sellQueue.partialDepth
?' (sichtbare Tiefe nur teilweise)'
:''
)
)
:'';

row.innerHTML=`
<div>
<b>${escapeHtml(item.cardName)}</b>

<div class="sbw-muted">
${escapeHtml(item.gameName)}
· ${escapeHtml(context)}
· aktuell ${escapeHtml(currentState)}
${
Number.isFinite(
buyQueue
)&&
![
'SELL',
'SELLKEEP',
'SELLRAISE',
'SELLLOWER',
'SELLCANCEL',
'SELLHOLD',
'SELLCONFIRM',
'HOLD'
]
.includes(
action
)
?` · Buy-Queue ≈ ${buyQueue.toFixed(2).replace('.', ',')} Tage`
:''
}
${escapeHtml(sellQueueText)}
</div>

<div class="sbw-plan-reason">
<b>Grund / Trigger:</b>
${escapeHtml(reason || 'Kein Grund angegeben.')}
</div>
</div>

<div class="${recommendation.className}">
<b>${escapeHtml(recommendation.text)}</b>
</div>

<div class="sbw-actions"></div>`;

const actions=
row.lastElementChild;

const hasExistingOrder=
Boolean(
item.activeOrder
?.orderId
);

if(
hasExistingOrder&&
[
'KEEP',
'SET',
'CANCEL'
]
.includes(
action
)
){
const show=
document.createElement(
'button'
);

show.className=
action===
'KEEP'||
setAlreadyMatches
?'sbw-small sbw-gray'
:'sbw-small sbw-danger';

show.textContent=
'🎮 Auftrag in Steam';

show.onclick=
()=>
openExistingOrderInSteam(
item
);

actions.appendChild(
show
);
}

if(
action===
'ADD'||
(
action===
'SET'&&
!setAlreadyMatches
)
){
const steam=
document.createElement(
'button'
);

steam.className=
'sbw-small sbw-blue';

steam.textContent=
action===
'ADD'
?'🎮 Gebot hinzufügen'
:'🎮 neues Gebot';

steam.onclick=
()=>
copyPriceAndOpenSteam(
item,
targetCents
);

actions.appendChild(
steam
);
}

if(
action===
'SELL'
){
const sell=
document.createElement(
'button'
);

sell.className=
'sbw-small sbw-blue';

sell.textContent=
'💶 Käuferpreis kopieren + Markt in Steam';

sell.onclick=
()=>
copyPriceAndOpenSteam(
item,
targetCents
);

actions.appendChild(
sell
);
}

if(['SELLKEEP','SELLCANCEL','SELLRAISE','SELLLOWER','SELLHOLD','SELLCONFIRM'].includes(action)){
const allListings=item.card?.activeSellListings||[];
const listings=action==='SELLHOLD'
?allListings.filter(listing=>listing.listingState==='MARKET_HOLD')
:action==='SELLCONFIRM'
?allListings.filter(listing=>listing.listingState==='AWAITING_CONFIRMATION')
:action==='SELLKEEP'||action==='SELLRAISE'||action==='SELLLOWER'
?allListings.filter(listing=>(listing.listingState||'ACTIVE')==='ACTIVE')
:allListings;
for(const listing of listings){
const sellButton=document.createElement('button');
sellButton.className=(action==='SELLRAISE'||action==='SELLLOWER')?'sbw-small sbw-blue':'sbw-small sbw-gray';
sellButton.textContent=(action==='SELLRAISE'||action==='SELLLOWER')
?`💶 ${listing.buyerPay||'Verkauf'} → Ziel ${euro(targetCents)}`
:action==='SELLCONFIRM'
?'📱 Bestätigung in Steam prüfen'
:action==='SELLHOLD'
?'🟣 Market Hold in Steam prüfen'
:`🎮 Verkauf ${listing.buyerPay||''} in Steam`;
sellButton.onclick=()=>{if(action==='SELLRAISE'||action==='SELLLOWER')copyPriceAndOpenExistingSell(item,targetCents,listing.listingId);else openExistingSellListingInSteam(item,listing.listingId);};
actions.appendChild(sellButton);
}
}

if(
action===
'HOLD'
){
const market=
document.createElement(
'button'
);

market.className=
'sbw-small sbw-gray';

market.textContent=
'🎮 Markt in Steam';

market.onclick=
()=>
openMarketOnly(
item
);

actions.appendChild(
market
);
}

if(
canMarkDone
){
const doneButton=
document.createElement(
'button'
);

doneButton.className=
'sbw-small sbw-good';

doneButton.textContent=
isDone
?'↩ offen'
:'✓ erledigt';

doneButton.onclick=
()=>{
const fresh=
loadDoneActions();

if(
fresh.has(
doneKey
)
){
fresh.delete(
doneKey
);

}else{
fresh.add(
doneKey
);
}

saveDoneActions(
fresh
);

repaint(
false
);
};

actions.appendChild(
doneButton
);
}

list.appendChild(
row
);
}
};

overlay
.querySelector(
'#sbw-plan-apply'
)
.onclick=
()=>
repaint(
true
);

overlay
.querySelector(
'#sbw-plan-clear-done'
)
.onclick=
()=>{
try{
localStorage.removeItem(
KEYS.actionDone
);
}catch{}

repaint(
false
);
};

overlay
.querySelector(
'#sbw-plan-close'
)
.onclick=
()=>
overlay.remove();

repaint(
false
);
}

function addLaunchButton(){
injectStyle();

if(
document.getElementById(
'sbw-launch'
)
){
return;
}

const button=
document.createElement(
'button'
);

button.id=
'sbw-launch';

button.textContent=
'🧹 Kauf/Badge/Verkauf prüfen';

button.onclick=
runAudit;

document.body.appendChild(
button
);
}

addLaunchButton();
})();
