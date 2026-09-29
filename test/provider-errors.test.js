import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {ROOT} from '../src/config.js';

test('provider failures identify retention, access, credentials and transport without exposing raw errors',()=>{
  const script=`import json, sys
sys.path.insert(0, 'src/ai')
from provider_errors import provider_error
class ModelHTTPError(Exception):
 def __init__(self, status, code, text):
  self.status_code=status
  self.body={'Error':{'Code':code,'Message':text}}
errors=[
 (400,'ValidationException',"data retention mode 'default' is not available for this model"),
 (403,'AccessDeniedException','PRIVATE-CREDENTIAL https://private.example/token'),
 (401,'','PRIVATE-KEY'),
 (400,'ExpiredTokenException','expired'),
 (429,'ThrottlingException','PRIVATE-RATE-ERROR'),
 (400,'ValidationException','toolConfig not supported'),
 (400,'ValidationException','on-demand throughput is not supported. Use an inference profile'),
 (404,'ResourceNotFoundException','PRIVATE-MODEL'),
 (500,'InternalServerException','PRIVATE-INTERNAL'),
 (400,'ValidationException','PRIVATE-REQUEST'),
]
results=[provider_error(ModelHTTPError(*e)) for e in errors]
results.append(provider_error(RuntimeError('PRIVATE-UNKNOWN')))
results.append(provider_error(RuntimeError('PRIVATE-EMAIL'),'send'))
results.append(provider_error(type('EndpointConnectionError',(Exception,),{})('PRIVATE-ENDPOINT')))
print(json.dumps(results))`;
  const result=spawnSync('python3',['-c',script],{cwd:ROOT,encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
  const data=JSON.parse(result.stdout);
  assert.deepEqual(data.map(e=>e.error),['model_retention_policy','model_access_denied','model_authentication_failed','model_credentials_expired','model_rate_limited','model_tools_unsupported','model_profile_required','model_not_found','model_service_unavailable','model_request_rejected','model_request_failed','email_delivery_failed','model_connection_failed']);
  assert(!result.stdout.includes('PRIVATE'));assert(!result.stdout.includes('https://'));
  assert(data[0].message.includes('data-retention'));assert.equal(data[0].status,422);
  assert(data.slice(0,-2).every(e=>!e.message.includes('email')));
});
