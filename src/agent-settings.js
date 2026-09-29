import { pythonCall } from './ai.js';

const fail=(message,status=400)=>Object.assign(new Error(message),{status});
const modelId=value=>typeof value==='string'&&value.length<=2048&&/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(value);

export class AgentSettings {
  constructor(store,config,{fetcher=fetch,call=pythonCall}={}) {
    this.store=store;this.config=config;this.fetcher=fetcher;this.call=call;this.checking=false;
  }
  current() {
    const saved=this.store.meta('agentSettings');
    // Settings for another configured provider must never override the active provider.
    return saved?.provider===this.config.modelProvider?saved:{provider:this.config.modelProvider,
      model:this.config.modelName,instructions:'',revision:0,checkedAt:null};
  }
  status() {
    return {...this.current(),ready:this.config.modelReady,region:this.config.modelRegion,checking:this.checking,lastModelCheck:this.store.meta('agentModelCheck')};
  }
  runtime() {
    const settings=this.current();
    return {...this.config,modelName:settings.model,agentInstructions:settings.instructions,agentRevision:settings.revision};
  }
  async catalog() {
    const current=this.current();
    const models=new Map([[current.model,{id:current.model,name:current.model,provider:'Current selection',kind:'current'}]]);
    if(current.provider!=='bedrock')return {models:[...models.values()],notice:'Enter the model ID supported by your configured provider.'};
    if(!this.config.modelReady)return {models:[...models.values()],notice:'An AI connection needs to be configured on the server first.'};
    const region=this.config.modelRegion;
    if(!/^[a-z]{2}(?:-[a-z]+)+-\d$/.test(region))throw fail('The configured Bedrock region is invalid.');
    const base=`https://bedrock.${region}.amazonaws.com`;
    const request=async route=>{
      let response;
      try {response=await this.fetcher(base+route,{headers:{Authorization:`Bearer ${this.config.bedrockApiKey}`},redirect:'error',signal:AbortSignal.timeout(12000)});}
      catch {throw fail('Bedrock model discovery is unavailable. Try again or enter a model ID.',502);}
      if(!response.ok)throw fail([401,403].includes(response.status)?'This key cannot list Bedrock models. You can still check a model by its ID.':'Bedrock model discovery is unavailable. Try again or enter a model ID.',502);
      return response.json();
    };
    const results=await Promise.allSettled([
      request('/foundation-models'),
      (async()=>{const profiles=[];let token;for(let page=0;page<20;page++){
        const result=await request('/inference-profiles'+(token?'?nextToken='+encodeURIComponent(token):''));
        profiles.push(...(result.inferenceProfileSummaries??[]));token=result.nextToken;if(!token)return profiles;
      }throw fail('The inference profile list is too large. Enter the profile ID directly.');})()
    ]);
    const [foundations,profiles]=results;
    const details=new Map();
    if(foundations.status==='fulfilled')for(const m of foundations.value.modelSummaries??[]){
      details.set(m.modelId,m);
      if(!modelId(m.modelId)||!m.outputModalities?.includes('TEXT')||!m.inputModalities?.includes('TEXT')||/embed|rerank/i.test(m.modelId)||m.modelLifecycle?.status==='LEGACY'||!m.inferenceTypesSupported?.includes('ON_DEMAND'))continue;
      models.set(m.modelId,{id:m.modelId,name:m.modelName,provider:m.providerName,kind:'model'});
    }
    if(profiles.status==='fulfilled')for(const p of profiles.value){
      if(p.status!=='ACTIVE'||!modelId(p.inferenceProfileId))continue;
      const known=p.models?.map(m=>details.get(m.modelArn?.split('foundation-model/')[1])).filter(Boolean)??[];
      // Unknown profiles may be image/embedding models. Keep those out of the
      // agent picker; users can still check a specific profile through its ID.
      if(!known.some(m=>m.outputModalities?.includes('TEXT')&&m.inputModalities?.includes('TEXT')&&!/embed|rerank/i.test(m.modelId)&&m.modelLifecycle?.status!=='LEGACY'))continue;
      models.set(p.inferenceProfileId,{id:p.inferenceProfileId,name:p.inferenceProfileName,provider:known[0]?.providerName??'Inference profiles',kind:'profile'});
    }
    const errors=results.filter(r=>r.status==='rejected');
    const check=this.store.meta('agentModelCheck');
    if(check&&models.has(check.model))models.get(check.model).lastCheckFailed=true;
    return {models:[...models.values()].sort((a,b)=>String(a.provider).localeCompare(String(b.provider))||String(a.name).localeCompare(String(b.name))),
      notice:errors.length?(errors[0].reason.status?errors[0].reason.message:'Some models could not be listed. Enter a model ID if it is missing.'):'Models are listed for your configured region. Access and tool support are checked before saving.'};
  }
  async save(data) {
    if(!data||!modelId(data.model))throw fail('Choose a model or enter a valid model ID.');
    if(typeof data.instructions!=='string'||data.instructions.length>2000)throw fail('Keep assistant preferences under 2,000 characters.');
    const previous=this.current();
    if(data.revision!==previous.revision)throw fail('Agent settings changed. Reopen settings before saving.',409);
    if(this.checking)throw fail('A model check is already in progress.',409);
    if(!this.config.modelReady)throw fail('An AI connection needs to be configured on the server first.',409);
    this.checking=true;
    try {
      const result=await this.call({...this.config,modelName:data.model},{operation:'check_model'});
      if(result?.verified!==true)throw fail('This model could not use the agent’s tools. Choose another model.',422);
      const next={provider:previous.provider,model:data.model,instructions:data.instructions.trim(),revision:previous.revision+1,checkedAt:new Date().toISOString()};
      this.store.meta('agentSettings',next);
      if(this.store.meta('agentModelCheck')?.model===data.model)this.store.meta('agentModelCheck',null);
      return {...this.status(),checking:false};
    } catch(error) {
      if(error.code==='model_retention_policy')this.store.meta('agentModelCheck',{
        model:data.model,code:error.code,message:error.message,checkedAt:new Date().toISOString()});
      throw error;
    } finally {this.checking=false;}
  }
}
