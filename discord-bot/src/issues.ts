/*
 * Copyright (C) 2026 Hyjinnx (Dauntless Forever)
 *
 * Licensed under the GNU Affero General Public License v3.0.
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// [forever-discord] Issue tickets.
// /issue title description   - anyone, only in channels added with /issue-channel; posts "#<id> <title>".
// /close id [reason]         - Manage Messages by default; marks the ticket closed and edits its post.
// /issue-channel add|remove|log|list - Manage Server by default. log = where tickets are posted (the reporter
// gets a private "logged as #id"); unset = posted where /issue was used.
// Server admins can retarget those defaults in Server Settings > Integrations. DISCORD_GUILD_ID set =
// commands registered in that server (instant); unset = global (up to an hour to appear).
// Tickets live in <BOT_DATA_DIR>/issues.json (the bot keeps no database; tickets made while it lived in the
// backend come over with ParadoxBackend/scripts/export-discord-issues.cjs).

import {
    ChannelType, Client, Events, GatewayIntentBits, InteractionContextType, MessageFlags, PermissionFlagsBits,
    SlashCommandBuilder, type APIEmbed, type APIEmbedField, type ChatInputCommandInteraction,
} from "discord.js";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export interface Issue {
    id: number;
    title: string;
    description: string;
    reporterId: string;
    channelId: string;
    messageId?: string;
    status: "open" | "closed";
    createdAt: string;
    closedBy?: string;
    closeReason?: string | null;
    closedAt?: string;
}

// lastId = the newest ticket number; channels = where /issue is allowed; log = where tickets are posted.
export interface IssueData { lastId: number; channels: string[]; log?: string; issues: Issue[] }

// The whole ticket file, kept in memory; every change rewrites it (write to .tmp, then rename).
export class IssueStore {
    private Data: IssueData | undefined;
    private Loading: Promise<IssueData> | undefined;
    private Saving: Promise<void> = Promise.resolve();
    constructor(readonly file: string) {}

    // A missing file starts empty; an unreadable one throws, so it is never overwritten.
    // One shared read: two commands during the first load each got their own copy, and one ticket was lost.
    async load(): Promise<IssueData> {
        this.Loading ??= readFile(this.file, "utf8").then((Text) => JSON.parse(Text) as IssueData, (error) => {
            if (error.code === "ENOENT") return { lastId: 0, channels: [], issues: [] };
            throw error;
        }).catch((error) => {
            this.Loading = undefined; // retry on the next command
            throw error;
        });
        this.Data ??= await this.Loading;
        return this.Data;
    }

    // One write at a time, each with the data as it is when it runs.
    save(): Promise<void> {
        const Run = async () => {
            await mkdir(path.dirname(this.file), { recursive: true });
            await writeFile(`${this.file}.tmp`, JSON.stringify(this.Data, null, 2));
            await rename(`${this.file}.tmp`, this.file);
        };
        this.Saving = this.Saving.then(Run, Run);
        return this.Saving;
    }
}

const ChannelOption = (o: any) => o.setName("channel").setDescription("Text channel").setRequired(true).addChannelTypes(ChannelType.GuildText);
const Commands = [
    new SlashCommandBuilder().setName("issue").setDescription("Report an issue")
        .addStringOption((o) => o.setName("title").setDescription("Short summary").setRequired(true).setMaxLength(200))
        .addStringOption((o) => o.setName("description").setDescription("What happened and how to reproduce it").setRequired(true).setMaxLength(3500)),
    new SlashCommandBuilder().setName("close").setDescription("Close an issue ticket")
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
        .addIntegerOption((o) => o.setName("id").setDescription("Ticket number").setRequired(true).setMinValue(1))
        .addStringOption((o) => o.setName("reason").setDescription("Resolution note").setMaxLength(500)),
    new SlashCommandBuilder().setName("issue-channel").setDescription("Choose where /issue is allowed")
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .addSubcommand((s) => s.setName("add").setDescription("Allow /issue in a channel").addChannelOption(ChannelOption))
        .addSubcommand((s) => s.setName("remove").setDescription("Stop allowing /issue in a channel").addChannelOption(ChannelOption))
        .addSubcommand((s) => s.setName("log").setDescription("Post issue tickets in this channel instead of where /issue was used").addChannelOption(ChannelOption))
        .addSubcommand((s) => s.setName("list").setDescription("Show channels that allow /issue")),
].map((c) => c.setContexts(InteractionContextType.Guild).toJSON());

export function IssueEmbed(Issue: Issue): APIEmbed {
    const Closed = Issue.status === "closed";
    const Fields: APIEmbedField[] = [
        { name: "Status", value: Closed ? "Closed" : "Open", inline: true },
        { name: "Reported by", value: `<@${Issue.reporterId}>`, inline: true },
    ];
    if (Closed) Fields.push({ name: "Closed by", value: `<@${Issue.closedBy}>`, inline: true });
    if (Issue.closeReason) Fields.push({ name: "Resolution", value: Issue.closeReason });
    return {
        title: `#${Issue.id} ${Issue.title}`,
        description: Issue.description,
        color: Closed ? 0x747f8d : 0xe67e22,
        fields: Fields,
        timestamp: Issue.createdAt,
    };
}

const ChannelList = (Ids: string[]) => Ids.map((Id) => `<#${Id}>`).join(", ");

async function Handle(Store: IssueStore, I: ChatInputCommandInteraction): Promise<unknown> {
    const S = await Store.load();
    const Whisper = (content: string) => I.reply({ content, flags: MessageFlags.Ephemeral });

    if (I.commandName === "issue") {
        if (!S.channels.includes(I.channelId)) {
            return Whisper(S.channels.length ? `Issues can't be reported here. Use ${ChannelList(S.channels)}.` : "Issue reporting isn't set up yet.");
        }
        const Ticket: Issue = {
            id: ++S.lastId, title: I.options.getString("title", true), description: I.options.getString("description", true),
            reporterId: I.user.id, channelId: S.log ?? I.channelId, status: "open", createdAt: new Date().toISOString(),
        };
        S.issues.push(Ticket);
        await Store.save();
        if (!S.log) {
            const Res = await I.reply({ embeds: [IssueEmbed(Ticket)], withResponse: true });
            Ticket.messageId = Res.resource!.message!.id;
            return Store.save();
        }
        try {
            const Post = await ((await I.client.channels.fetch(S.log)) as any).send({ embeds: [IssueEmbed(Ticket)] });
            Ticket.messageId = Post.id;
            await Store.save();
        } catch (error) {
            S.issues = S.issues.filter((T) => T !== Ticket); // no post = no ticket; the reporter gets the error reply
            await Store.save();
            throw error;
        }
        return Whisper(`Thanks! Logged as issue #${Ticket.id} in <#${S.log}>.`);
    }

    if (I.commandName === "close") {
        const Id = I.options.getInteger("id", true);
        const Ticket = S.issues.find((T) => T.id === Id);
        if (!Ticket) return Whisper(`There is no issue #${Id}.`);
        if (Ticket.status === "closed") return Whisper(`Issue #${Id} is already closed.`);
        Object.assign(Ticket, { status: "closed", closedBy: I.user.id, closeReason: I.options.getString("reason"), closedAt: new Date().toISOString() });
        await Store.save();
        const Updated = await I.client.channels.fetch(Ticket.channelId)
            .then((Ch) => (Ch as any).messages.edit(Ticket.messageId, { embeds: [IssueEmbed(Ticket)] }))
            .then(() => true, (error) => { console.warn(`[Issues] post for #${Id} not updated: ${error}`); return false; });
        return Whisper(`Closed issue #${Id}: ${Ticket.title}${Updated ? "" : " (original post could not be updated)"}`);
    }

    if (I.commandName === "issue-channel") {
        const Sub = I.options.getSubcommand();
        if (Sub === "list") {
            return Whisper((S.channels.length ? `/issue is allowed in ${ChannelList(S.channels)}.` : "/issue isn't allowed in any channel yet.")
                + (S.log ? ` Tickets are posted in <#${S.log}>.` : " Tickets are posted where /issue is used."));
        }
        const Id = I.options.getChannel("channel", true).id;
        if (Sub === "log") {
            S.log = Id;
            await Store.save();
            return Whisper(`New issue tickets will be posted in <#${Id}>. Existing tickets stay where they are.`);
        }
        S.channels = Sub === "add" ? [...new Set([...S.channels, Id])] : S.channels.filter((C) => C !== Id);
        await Store.save();
        return Whisper(`/issue is ${Sub === "add" ? "now allowed" : "no longer allowed"} in <#${Id}>.`);
    }
}

// Failures here only lose /issue, never the rest of the bot.
export function StartIssues(client: Client, store: IssueStore, guildId: string | undefined): void {
    client.once(Events.ClientReady, async (Ready) => {
        try {
            // create() upserts by name, so the bot's other commands are left alone.
            for (const Command of Commands) await Ready.application.commands.create(Command, guildId);
            console.log(`[Issues] /issue ready as ${Ready.user.tag}`);
        } catch (error) {
            console.warn(`[Issues] command registration failed: ${error}`);
        }
    });
    client.on(Events.InteractionCreate, async (I) => {
        if (!I.isChatInputCommand()) return;
        try { await Handle(store, I); } catch (error) {
            console.error(`[Issues] /${I.commandName} failed: ${error}`);
            const Msg = { content: "Something went wrong. Please try again.", flags: MessageFlags.Ephemeral } as const;
            await (I.replied || I.deferred ? I.followUp(Msg) : I.reply(Msg)).catch(() => {});
        }
    });
}

export const GatewayIntents = [GatewayIntentBits.Guilds];
