import {GetDb} from '../db';
import {ClientAddressOf, IsLoopbackAddress, NormalizeAddress} from '../middleware/RequestOrigin';
import type {Request, Response} from 'express';

const playingAddresses=new Map<string,{address:string,last_seen:number}>();
export function ExpirePlayingAddresses(now=Date.now()) {
    for(const [id,row] of playingAddresses) if(now-row.last_seen>=90000) playingAddresses.delete(id);
}
setInterval(ExpirePlayingAddresses,10000).unref();
export function EndPlayingAddress(accountId:string){playingAddresses.delete(accountId);}
export function RecordPlayingAddress(req:Request,accountId:string,now=Date.now()) {
    const address=ClientAddressOf(req);
    if(NormalizeAddress(address) && !IsLoopbackAddress(address)) playingAddresses.set(accountId,{address,last_seen:now});
}
export function BanFor(accountId?: string, address?: string): {reason:string}|undefined {
    return GetDb().$client.prepare('SELECT reason FROM account_bans WHERE active=1 AND (account_id=? OR address=?) LIMIT 1')
        .get(accountId ?? '', address ?? '') as {reason:string}|undefined;
}
export function CheckPlayerAccess(req:Request,res:Response,accountId?:string):boolean {
    const address=ClientAddressOf(req);
    const publicAddress=NormalizeAddress(address) && !IsLoopbackAddress(address) ? address : undefined;
    const ban=BanFor(accountId,publicAddress);
    if(ban){res.status(403).json({error:'account_banned',reason:ban.reason});return false;}
    return true;
}
export function ModerationInfo(accountId:string){
    const db=GetDb().$client;
    ExpirePlayingAddresses();
    const user=db.prepare('SELECT name FROM users WHERE userId=?').get(accountId) as {name:string}|undefined;
    return {username:user?.name ?? null,ban:db.prepare('SELECT reason,address,active,updated_at FROM account_bans WHERE account_id=?').get(accountId) ?? null,
        addresses:playingAddresses.has(accountId)?[playingAddresses.get(accountId)!]:[]};
}
export function SetAccountBan(accountId:unknown,reason:unknown,active:unknown,address:unknown,actor:string){
    if(typeof accountId!=='string' || typeof reason!=='string' || !reason.trim() || reason.length>500 || typeof active!=='boolean') throw Error('invalid_ban');
    const ip=address == null || address==='' ? null : NormalizeAddress(address);
    if(address && (!ip || IsLoopbackAddress(ip))) throw Error('invalid_address');
    const db=GetDb().$client;
    return db.transaction(()=>{
        const user=db.prepare('SELECT isAdmin FROM users WHERE userId=?').get(accountId) as {isAdmin:number}|undefined;
        if(!user)throw Error('account_not_found');
        if(user.isAdmin)throw Error('admin_account_protected');
        ExpirePlayingAddresses();
        if(ip && playingAddresses.get(accountId)?.address!==ip)throw Error('address_not_observed');
        const args=[accountId,reason.trim(),ip,Number(active),Date.now(),actor];
        db.prepare(`INSERT INTO account_bans VALUES (?,?,?,?,?,?) ON CONFLICT(account_id) DO UPDATE SET
            reason=excluded.reason,address=excluded.address,active=excluded.active,updated_at=excluded.updated_at,actor=excluded.actor`).run(...args);
        db.prepare('INSERT INTO moderation_events(account_id,reason,address,active,created_at,actor) VALUES (?,?,?,?,?,?)').run(...args);
        return ModerationInfo(accountId);
    })();
}
