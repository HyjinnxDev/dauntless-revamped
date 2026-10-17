import './setup';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryAdmission, CapacityUnavailable, HuntAdmission, HuntLimit } from '../src/controllers/capacity';

test('hard hunt slots include pending allocations and release exactly once',()=>{
    let running=4;
    const slots=new HuntAdmission(()=>running,()=>5);
    const release=slots.reserve();
    assert.deepEqual(slots.status(),{running:4,pending:1,limit:5});
    assert.throws(()=>slots.reserve(),CapacityUnavailable);
    running++; release(); release();
    assert.throws(()=>slots.reserve(),CapacityUnavailable);
    running--; slots.reserve();
    assert.throws(()=>slots.reserve(),CapacityUnavailable);
});
test('worker and primary have independent configured hard limits',()=>{
    process.env.MAX_LOCAL_HUNTS='5'; process.env.MAX_HUNTS='3';
    try {
        assert.equal(HuntLimit(),5);
        process.env.HUNT_WORKER='1'; assert.equal(HuntLimit(),3);
        const worker=new HuntAdmission(()=>2); worker.reserve();
        assert.throws(()=>worker.reserve(),CapacityUnavailable);
        process.env.MAX_HUNTS='invalid'; assert.throws(HuntLimit,/Invalid/);
    } finally {delete process.env.HUNT_WORKER; delete process.env.MAX_LOCAL_HUNTS; delete process.env.MAX_HUNTS;}
});

test('automatic capacity uses ports with CPU and memory guards, not a fixed hunt count',()=>{
 const names=['HUNT_WORKER','MAX_HUNTS','PORT_RANGE_BEGIN','PORT_RANGE_END','GAMESERVER_CPU_GUARD','GAMESERVER_MEMORY_GUARD'];
 const old=names.map(n=>process.env[n]);
 try {
  Object.assign(process.env,{HUNT_WORKER:'1',MAX_HUNTS:'auto',PORT_RANGE_BEGIN:'8700',PORT_RANGE_END:'8797',GAMESERVER_CPU_GUARD:'1',GAMESERVER_MEMORY_GUARD:'1'});
  assert.equal(HuntLimit(),96);
  process.env.GAMESERVER_CPU_GUARD='0';assert.throws(HuntLimit,/requires/);
  process.env.GAMESERVER_CPU_GUARD='1';process.env.PORT_RANGE_END='8701';assert.throws(HuntLimit,/port range/);
 } finally {names.forEach((n,i)=>{if(old[i]===undefined)delete process.env[n];else process.env[n]=old[i];});}
});

test('memory floor, startup reservations, release and expiry', () => {
    process.env.GAMESERVER_MEMORY_GUARD = '1';
    let free = 4608 * 1048576, now = 0;
    const admission = new MemoryAdmission(() => free, () => now);
    const release = admission.reserve();
    assert.throws(() => admission.reserve(), CapacityUnavailable);
    release();
    admission.reserve();
    now = 60000;
    admission.reserve();
    now = 120000;
    free--;
    assert.throws(() => admission.reserve(), CapacityUnavailable);
    process.env.GAMESERVER_MIN_FREE_MB = 'invalid';
    assert.throws(() => admission.reserve(), /Invalid/);
    delete process.env.GAMESERVER_MIN_FREE_MB;
    process.env.GAMESERVER_MEMORY_GUARD = '0';
    admission.reserve();
});

test('hunt estimates keep the full floor and correctly sum mixed reservations', () => {
    process.env.GAMESERVER_MEMORY_GUARD = '1';
    process.env.GAMESERVER_MIN_FREE_MB = '1536';
    process.env.GAMESERVER_HUNT_STARTUP_MB = '1024';
    let free = 2800 * 1048576;
    try {
        const admission = new MemoryAdmission(() => free, () => 0);
        assert.throws(() => admission.reserve(), CapacityUnavailable, 'persistent worlds still require 3072 MiB');
        const releaseHunt = admission.reserve(true);
        assert.throws(() => admission.reserve(true), CapacityUnavailable, 'a concurrent hunt cannot spend the same RAM');
        releaseHunt();
        free = 4096 * 1048576;
        const releasePersistent = admission.reserve();
        const releaseSmall = admission.reserve(true);
        assert.throws(() => admission.reserve(true), CapacityUnavailable);
        releasePersistent(); releaseSmall();
        free = 2559 * 1048576;
        assert.throws(() => admission.reserve(true), CapacityUnavailable, 'headroom is never waived');
        process.env.GAMESERVER_HUNT_STARTUP_MB = 'invalid';
        assert.throws(() => admission.reserve(true), /Invalid/);
    } finally {
        delete process.env.GAMESERVER_MIN_FREE_MB;
        delete process.env.GAMESERVER_HUNT_STARTUP_MB;
        delete process.env.GAMESERVER_MEMORY_GUARD;
    }
});

test('launch backlog is bounded independently of free hunt slots',()=>{
    const slots=new HuntAdmission(()=>0,()=>96);
    const first=slots.reserve(), second=slots.reserve();
    assert.throws(()=>slots.reserve(),CapacityUnavailable);
    first(); first();
    const third=slots.reserve();
    assert.equal(slots.pending,2);
    second(); third();
    assert.equal(slots.pending,0);
});
