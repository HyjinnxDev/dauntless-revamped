#!/usr/bin/env node
/*
 * init-replset.cjs - first start of a new mongod: turns it into the one-member replica set rs0 the backend
 * expects (MONGODB_URI ...replicaSet=rs0, transactions need it) and waits until it accepts writes.
 * Safe to run again: an already initiated set is left alone. Used by deploy/install.ps1.
 *   node scripts/init-replset.cjs 127.0.0.1:27018
 */
const { MongoClient } = require("mongodb");

async function Main() {
    const Host = process.argv[2] || "127.0.0.1:27018";
    const Client = await MongoClient.connect(`mongodb://${Host}/?directConnection=true`);
    try {
        const Admin = Client.db("admin");
        try {
            await Admin.command({ replSetInitiate: { _id: "rs0", members: [{ _id: 0, host: Host }] } });
            console.log(`replica set rs0 initiated on ${Host}`);
        } catch (error) {
            if (error.codeName !== "AlreadyInitialized") throw error;
            console.log("replica set already initiated");
        }
        for (let Waited = 0; !(await Admin.command({ hello: 1 })).isWritablePrimary; Waited++) {
            if (Waited >= 60) throw new Error("mongod did not become primary within 60 s");
            await new Promise((resolve) => setTimeout(resolve, 1000));
        }
    } finally {
        await Client.close();
    }
}

Main().catch((error) => { console.error(error.message ?? error); process.exitCode = 1; });
