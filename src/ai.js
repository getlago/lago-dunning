import { spawn } from 'node:child_process';
import path from 'node:path';
import { ROOT } from './config.js';

export function pythonCall(config, data, extraEnv={}) {
  if(data.operation==='send') return Promise.reject(new Error('Email sending is disabled. Use workspace drafts.'));
  return new Promise((resolve,reject)=>{
    const permitted=['PATH','HOME','LANG','TMPDIR','SSL_CERT_FILE','SSL_CERT_DIR','MODEL_PROVIDER','ANTHROPIC_API_KEY','ANTHROPIC_MODEL_ID','AWS_BEARER_TOKEN_BEDROCK','AWS_DEFAULT_REGION','BEDROCK_MODEL_ID'];
    const environment=Object.fromEntries(permitted.filter(key=>process.env[key]!==undefined).map(key=>[key,process.env[key]]));
    // Resolve model selection per call; an environment default must not override saved settings.
    const selection={MODEL_PROVIDER:config.modelProvider,BEDROCK_MODEL_ID:config.modelName,ANTHROPIC_MODEL_ID:config.modelName,
      AWS_DEFAULT_REGION:config.modelRegion??'us-east-1',...(config.bedrockApiKey?{AWS_BEARER_TOKEN_BEDROCK:config.bedrockApiKey}:{})};
    const child=spawn(config.python,[path.join(ROOT,'src/ai/bridge.py')],{cwd:ROOT,env:{...environment,...extraEnv,...selection},stdio:['pipe','pipe','pipe']});
    let output='',done=false;
    const timer=setTimeout(()=>{child.kill('SIGKILL');finish(new Error('The provider took too long. Please try again.'));},180000);
    function finish(error,value){if(done)return;done=true;clearTimeout(timer);error?reject(error):resolve(value);}
    child.on('error',()=>finish(new Error('The Python AI runtime is unavailable. Run the AI setup described in the README.')));
    child.stdout.on('data',chunk=>{output+=chunk;if(output.length>4_000_000){child.kill();finish(new Error('AI response exceeded the size limit.'));}});
    child.stderr.on('data',()=>{});
    child.on('close',()=>{try{const value=JSON.parse(output);value.error?finish(Object.assign(new Error(value.message),{code:value.error,status:[422,429,502,503].includes(value.status)?value.status:502})):finish(null,value);}catch{finish(new Error('The AI runtime did not return a valid response. Check the installed AI dependencies.'));}});
    child.stdin.on('error',()=>{});
    child.stdin.end(JSON.stringify({...data,instructions:config.agentInstructions??''}));
  });
}
