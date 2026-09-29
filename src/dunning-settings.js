const fail=(message,status=400)=>Object.assign(new Error(message),{status});
const currencies=new Set(Intl.supportedValuesOf('currency'));
export function currencyDecimals(currency){
  if(!currencies.has(currency))throw fail('Choose a supported currency.');
  return new Intl.NumberFormat('en',{style:'currency',currency}).resolvedOptions().maximumFractionDigits;
}
export function dunningSettings(store,config){
  const saved=store.meta('dunningSettings');
  if(saved)return saved;
  const currency=config.policy.materialityCurrency??'EUR',decimals=currencyDecimals(currency);
  return {currency,amount:(config.policy.materiality/10**decimals).toFixed(decimals),amountMinor:config.policy.materiality,revision:0,updatedAt:null};
}
export function saveDunningSettings(store,config,input){
  const previous=dunningSettings(store,config);
  if(input?.revision!==previous.revision)throw fail('Dunning settings changed. Reopen settings before saving.',409);
  const decimals=currencyDecimals(input.currency);
  const amount=typeof input.amount==='string'?input.amount.trim():'';
  if(!/^\d+(?:\.\d+)?$/.test(amount)||amount.length>25)throw fail('Enter a positive amount, without thousands separators.');
  const [whole,fraction='']=amount.split('.');
  if(fraction.length>decimals)throw fail(`${input.currency} supports ${decimals} decimal places.`);
  const minor=BigInt(whole)*10n**BigInt(decimals)+BigInt(fraction.padEnd(decimals,'0')||'0');
  if(minor<=0n||minor>BigInt(Number.MAX_SAFE_INTEGER))throw fail('Enter a positive amount within the supported range.');
  const next={currency:input.currency,amount:decimals?`${BigInt(whole)}.${fraction.padEnd(decimals,'0')}`:String(BigInt(whole)),amountMinor:Number(minor),revision:previous.revision+1,updatedAt:new Date().toISOString()};
  store.meta('dunningSettings',next);
  return next;
}
