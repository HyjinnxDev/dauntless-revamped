type Hunt = {id:string;isRamsgate:boolean;isTrainingDojo:boolean;startTime:Date};
export class HuntLifetime {
    private emptySince = new Map<string,number>();
    constructor(private maxAgeMs=120*60000, private emptyMs=3*60000, private startupGraceMs=5*60000) {}
    prune(ids:Set<string>) {for(const id of this.emptySince.keys())if(!ids.has(id))this.emptySince.delete(id);}
    reason(server:Hunt, connections:number|undefined, now=Date.now()): 'maximum_age'|'empty'|undefined {
        if(server.isRamsgate || server.isTrainingDojo)return;
        const age=now-server.startTime.getTime();
        if(age>=this.maxAgeMs)return 'maximum_age';
        // Missing/stale telemetry is never proof that a hunt is empty.
        if(connections!==0){this.emptySince.delete(server.id);return;}
        if(!this.emptySince.has(server.id))this.emptySince.set(server.id,now);
        if(age>=Math.max(this.emptyMs,this.startupGraceMs) && now-this.emptySince.get(server.id)!>=this.emptyMs)return 'empty';
    }
}
export function HuntLifetimeFromEnv(env:NodeJS.ProcessEnv=process.env) {
    const minutes=(name:string,fallback:number)=>{
        const value=env[name]===undefined?fallback:Number(env[name]);
        if(!Number.isInteger(value)||value<1||value>1440)throw new Error(`Invalid ${name}`);
        return value*60000;
    };
    return new HuntLifetime(minutes('HUNT_MAX_AGE_MINUTES',120),minutes('HUNT_EMPTY_MINUTES',3),minutes('HUNT_STARTUP_GRACE_MINUTES',5));
}
