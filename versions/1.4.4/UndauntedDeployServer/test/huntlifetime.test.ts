import assert from 'node:assert/strict';
import {test} from 'node:test';
import {HuntLifetime,HuntLifetimeFromEnv} from '../src/controllers/huntlifetime';
const hunt={id:'h',isRamsgate:false,isTrainingDojo:false,startTime:new Date(0)};
test('hard limit stops hunts even with unknown occupancy, never persistent worlds',()=>{
 const policy=new HuntLifetime(120000,10000,0);
 assert.equal(policy.reason(hunt,4,119999),undefined);
 assert.equal(policy.reason(hunt,undefined,120000),'maximum_age');
 assert.equal(policy.reason({...hunt,isRamsgate:true},0,999999),undefined);
 assert.equal(policy.reason({...hunt,isTrainingDojo:true},0,999999),undefined);
});
test('empty cleanup requires continuous fresh zero readings and resets on arrivals or missing data',()=>{
 const policy=new HuntLifetime(120000,10000,0);
 assert.equal(policy.reason(hunt,0,10000),undefined);
 assert.equal(policy.reason(hunt,1,19000),undefined);
 assert.equal(policy.reason(hunt,0,20000),undefined);
 assert.equal(policy.reason(hunt,undefined,29000),undefined);
 assert.equal(policy.reason(hunt,0,30000),undefined);
 assert.equal(policy.reason(hunt,0,39999),undefined);
 assert.equal(policy.reason(hunt,0,40000),'empty');
 policy.prune(new Set());
 assert.equal(policy.reason(hunt,0,41000),undefined);
});
test('invalid lifetime configuration fails instead of silently disabling cleanup',()=>{
 assert.throws(()=>HuntLifetimeFromEnv({HUNT_MAX_AGE_MINUTES:'0'}));
 assert.throws(()=>HuntLifetimeFromEnv({HUNT_EMPTY_MINUTES:'NaN'}));
});
test('default empty cleanup gives slow clients five minutes to arrive',()=>{
 const policy=HuntLifetimeFromEnv({});
 assert.equal(policy.reason(hunt,0,0),undefined);
 assert.equal(policy.reason(hunt,0,180000),undefined);
 assert.equal(policy.reason(hunt,0,300000),'empty');
});
