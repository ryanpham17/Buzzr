require('dotenv').config(); //loads environment variables from .env such as API tokens

const { Client, GatewayIntentBits, SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits, Events } = require('discord.js');
//Client: connect and interact with discord API
//GatewayIntentBits: specify which discord events bot listens to
//SlashCommandBuilder: Define slash commands
//EmbedBuilder: create embed messages
//PermissionFlagBits: manage command perms

const { REST } = require('@discordjs/rest'); //make HTTP requests to discord API
const { Routes } = require('discord-api-types/v9'); //construct discord API URLs
const twilio = require('twilio'); //send SMS through twilio API
const sqlite3 = require('sqlite3').verbose(); //manage local SQLite database
const path = require('path'); //manage file paths across OS

const SESSION_TIMEOUT = 15 * 60 * 1000;

const config = {
    token: process.env.DISCORD_BOT_TOKEN,
    clientId: process.env.BOT_CLIENT_ID,  
    guildId: process.env.GUILD_ID,    
    twilio: {
        account_sid: process.env.TWILIO_ACCOUNT_SID,
        auth_token: process.env.TWILIO_AUTH_TOKEN,
        phone_number: process.env.TWILIO_PHONE_NUMBER
    }
};

const requiredEnvVars = [
    'DISCORD_BOT_TOKEN',
    'BOT_CLIENT_ID',
    'TWILIO_ACCOUNT_SID',
    'TWILIO_AUTH_TOKEN',
    'TWILIO_PHONE_NUMBER'
];

for (const envVar of requiredEnvVars) {
    if (!process.env[envVar]) {
        console.error(`Missing required environment variable: ${envVar}`);
        process.exit(1);
    }
}

const twilioClient = twilio(config.twilio.account_sid, config.twilio.auth_token)

const client = new Client({
    intents:[
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.GuildMembers
    ]
});

const db = new sqlite3.Database(path.join(__dirname, 'sms_announcements.db'));

const pendingSignups = new Map(); // userId -> { guildId, timestamp }

db.serialize(() => {
    //SMS: phone numbers, user id, guild id
    db.run(`CREATE TABLE IF NOT EXISTS users (
        user_id TEXT PRIMARY KEY,
        phone_number TEXT NOT NULL,
        guild_id TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (user_id, guild_id)
    )`);

    //announcements: guild id, channel id
    db.run(`CREATE TABLE IF NOT EXISTS announcements_channels (
        guild_id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        set_by TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
});

//creating slash commands
const commands = [
    new SlashCommandBuilder()
        .setName('sms-signup')
        .setDescription('Sign up to receive SMS announcements'),
    
    new SlashCommandBuilder()
        .setName('sms-remove')
        .setDescription('Remove your phone number and stop SMS announcements'),
    
    new SlashCommandBuilder()
        .setName('set-announcement-channel')
        .setDescription('Set the channel for SMS announcements (Admin only)')
        .addChannelOption(option =>
            option.setName('channel')
                .setDescription('The channel to monitor for announcements')
                .setRequired(true))
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    
    new SlashCommandBuilder()
        .setName('sms-status')
        .setDescription('Check SMS announcement settings (Admin only)')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
];

// Helper function to validate phone number format
function isValidPhoneNumber(phone) {
    const phoneRegex = /^\+?1?[2-9]\d{2}[2-9]\d{2}\d{4}$/;
    return phoneRegex.test(phone.replace(/\D/g, ''));
}

// Helper function to format phone number
function formatPhoneNumber(phone) {
    const digits = phone.replace(/\D/g, '');
    if (digits.length === 10) {
        return `+1${digits}`;
    } else if (digits.length === 11 && digits.startsWith('1')) {
        return `+${digits}`;
    }
    return null;
}

// Helper function to send SMS
async function sendSMS(phoneNumber, message) {
    try {
        let fromNumber = config.twilio.phone_number?.trim() || '';

        fromNumber = fromNumber.replace(/[^+\d]/g, '');

        if (!fromNumber.startsWith('+')) {
            fromNumber = '+' + fromNumber;
        }

        console.log('Sending SMS from number:', JSON.stringify(fromNumber));
        console.log('Sent to:', JSON.stringify(phoneNumber));

        await twilioClient.messages.create({
            body: message,
            from: fromNumber,    
            to: phoneNumber
        });
        return true;
    } catch (error) {
        console.error(`Failed to send SMS to ${phoneNumber}:`, error);
        return false;
    }
}

// Helper function to get users for SMS alerts
function getSMSUsers(guildId) {
    return new Promise((resolve, reject) => {
        db.all(
            'SELECT user_id, phone_number FROM users WHERE guild_id = ?',
            [guildId],
            (err, rows) => {
                if (err) reject(err);
                else resolve(rows);
            }
        );
    });
}

// Helper function to get announcement channel
function getAnnouncementChannel(guildId) {
    return new Promise((resolve, reject) => {
        db.get(
            'SELECT channel_id FROM announcement_channels WHERE guild_id = ?',
            [guildId],
            (err, row) => {
                if (err) reject(err);
                else resolve(row ? row.channel_id : null);
            }
        );
    });
}

// Function to initiate SMS signup
function initiateSMSSignup(interaction) {
    const userId = interaction.user.id;
    const guildId = interaction.guild.id;
    
    // Store the signup context
    pendingSignups.set(userId, {
        guildId: guildId,
        timestamp: Date.now()
    });
    
    const dmEmbed = new EmbedBuilder()
        .setColor(0x0099FF)
        .setTitle('📱 SMS Signup - Send Your Phone Number')
        .setDescription(`Please send your phone number in this DM to complete SMS signup for **${interaction.guild.name}**.`)
        .addFields({
            name: '📞 Accepted Formats',
            value: '• +1-234-567-8900\n• (234) 567-8900\n• 2345678900',
            inline: false
        })
        .addFields({
            name: '⏰ Session Timeout',
            value: 'This session will expire in 15 minutes.',
            inline: false
        })
        .setFooter({ text: 'Your phone number will only be used for server announcements.' });
    
    return dmEmbed;
}

// Clean up expired pending signups periodically
setInterval(() => {
    const now = Date.now();
    const SESSION_TIMEOUT = 15 * 60 * 1000; // 15 minutes
    
    for (const [userId, signup] of pendingSignups.entries()) {
        if (now - signup.timestamp > SESSION_TIMEOUT) {
            pendingSignups.delete(userId);
        }
    }
}, 5 * 60 * 1000); // Check every 5 minutes

client.once('ready', () => {
    console.log(`✅ Logged in as ${client.user.tag}!`);
    console.log(`📱 SMS Bot is ready and monitoring ${client.guilds.cache.size} guild(s)`);
});

// Handle member leaving guild - remove from SMS database
client.on('guildMemberRemove', async member => {
    try {
        db.run(
            'DELETE FROM users WHERE user_id = ? AND guild_id = ?',
            [member.user.id, member.guild.id],
            function(err) {
                if (err) {
                    console.error(`Error removing user ${member.user.tag} from SMS database:`, err);
                } else if (this.changes > 0) {
                    console.log(`📱 Removed ${member.user.tag} from SMS notifications for ${member.guild.name}`);
                }
            }
        );
    } catch (error) {
        console.error('Error handling member leave:', error);
    }
});

client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;

    const { commandName, guildId, user } = interaction;

    try {
        switch (commandName) {
            case 'sms-signup':
                try {
                    const dmEmbed = initiateSMSSignup(interaction);
                    await user.send({ embeds: [dmEmbed] });
                    
                    const replyEmbed = new EmbedBuilder()
                        .setColor(0x0099FF)
                        .setTitle('📱 SMS Signup')
                        .setDescription('Check your DMs to complete SMS signup!')
                        .setFooter({ text: 'Your phone number will be kept secure and only used for announcements.' });

                    await interaction.reply({ embeds: [replyEmbed], ephemeral: true });
                } catch (dmError) {
                    await interaction.reply({ 
                        content: '❌ I couldn\'t send you a DM. Please make sure your DMs are open and try again.', 
                        ephemeral: true 
                    });
                }
                break;

            case 'sms-remove':
                db.run('DELETE FROM users WHERE user_id = ? AND guild_id = ?', [user.id, guildId], function(err) {
                    if (err) {
                        interaction.reply({ content: '❌ Error removing your phone number.', ephemeral: true });
                    } else if (this.changes > 0) {
                        interaction.reply({ content: '✅ Your phone number has been removed. You will no longer receive SMS announcements.', ephemeral: true });
                    } else {
                        interaction.reply({ content: '❌ You don\'t have a phone number registered for this server.', ephemeral: true });
                    }
                });
                break;

            case 'set-announcement-channel':
                const channel = interaction.options.getChannel('channel');
                
                db.run(
                    'INSERT OR REPLACE INTO announcement_channels (guild_id, channel_id, set_by) VALUES (?, ?, ?)',
                    [guildId, channel.id, user.id],
                    function(err) {
                        if (err) {
                            interaction.reply({ content: '❌ Error setting announcement channel.', ephemeral: true });
                        } else {
                            const successEmbed = new EmbedBuilder()
                                .setColor(0x00FF00)
                                .setTitle('✅ Announcement Channel Set')
                                .setDescription(`Messages sent in ${channel} will now be forwarded as SMS announcements to subscribed users.`)
                                .addFields({ name: 'Channel', value: `<#${channel.id}>`, inline: true });

                            interaction.reply({ embeds: [successEmbed] });
                        }
                    }
                );
                break;

            case 'sms-status':
                const announcementChannelId = await getAnnouncementChannel(guildId);
                const smsUsers = await getSMSUsers(guildId);

                const statusEmbed = new EmbedBuilder()
                    .setColor(0x0099FF)
                    .setTitle('📊 SMS Announcement Status')
                    .addFields(
                        { 
                            name: 'Announcement Channel', 
                            value: announcementChannelId ? `<#${announcementChannelId}>` : 'Not set', 
                            inline: true 
                        },
                        { 
                            name: 'Subscribed Users', 
                            value: smsUsers.length.toString(), 
                            inline: true 
                        }
                    );

                await interaction.reply({ embeds: [statusEmbed], ephemeral: true });
                break;
        }
    } catch (error) {
        console.error('Error handling interaction:', error);
        if (!interaction.replied) {
            await interaction.reply({ content: '❌ An error occurred while processing your request.', ephemeral: true });
        }
    }
});

// Handle DM messages for phone number collection - PRODUCTION VERSION
client.on('messageCreate', async message => {
    if (message.author.bot || !message.channel.isDMBased()) return;

    const userId = message.author.id;
    const phoneInput = message.content.trim();

    // Check if user has a pending signup
    const pendingSignup = pendingSignups.get(userId);
    if (!pendingSignup) {
        const helpEmbed = new EmbedBuilder()
            .setColor(0xFFAA00)
            .setTitle('📱 SMS Signup')
            .setDescription('To sign up for SMS announcements, please use the `/sms-signup` command in the server you want to receive notifications from.');
        
        await message.reply({ embeds: [helpEmbed] });
        return;
    }

    // Check if signup session has expired (15 minutes)
    const SESSION_TIMEOUT = 15 * 60 * 1000; // 15 minutes
    if (Date.now() - pendingSignup.timestamp > SESSION_TIMEOUT) {
        pendingSignups.delete(userId);
        const expiredEmbed = new EmbedBuilder()
            .setColor(0xFF0000)
            .setTitle('⏰ Session Expired')
            .setDescription('Your SMS signup session has expired. Please use the `/sms-signup` command again in your desired server.');
        
        await message.reply({ embeds: [expiredEmbed] });
        return;
    }

    // Validate phone number
    const formattedPhone = formatPhoneNumber(phoneInput);
    if (!isValidPhoneNumber(phoneInput)) {
        const errorEmbed = new EmbedBuilder()
            .setColor(0xFF0000)
            .setTitle('❌ Invalid Phone Number')
            .setDescription('Please provide a valid US phone number.\n\n**Format examples:**\n• +1-234-567-8900\n• (234) 567-8900\n• 2345678900\n\n*Session expires in 15 minutes from initial signup command.*');
        
        await message.reply({ embeds: [errorEmbed] });
        return;
    }

    // Get the target guild
    const targetGuild = client.guilds.cache.get(pendingSignup.guildId);
    if (!targetGuild) {
        pendingSignups.delete(userId);
        await message.reply('❌ Error: The server you signed up from is no longer accessible. Please try again.');
        return;
    }

    // Verify user is still in the guild
    const member = targetGuild.members.cache.get(userId);
    if (!member) {
        pendingSignups.delete(userId);
        await message.reply(`❌ You are no longer a member of **${targetGuild.name}**. Please rejoin the server and try again.`);
        return;
    }

    // Save to database
    db.run(
        'INSERT OR REPLACE INTO users (user_id, phone_number, guild_id) VALUES (?, ?, ?)',
        [userId, formattedPhone, targetGuild.id],
        function(err) {
            // Remove pending signup regardless of success/failure
            pendingSignups.delete(userId);
            
            if (err) {
                console.error('Database error during SMS signup:', err);
                const dbErrorEmbed = new EmbedBuilder()
                    .setColor(0xFF0000)
                    .setTitle('❌ Database Error')
                    .setDescription('There was an error saving your phone number. Please try again later.');
                
                message.reply({ embeds: [dbErrorEmbed] });
            } else {
                const successEmbed = new EmbedBuilder()
                    .setColor(0x00FF00)
                    .setTitle('✅ SMS Signup Complete')
                    .setDescription(`Your phone number has been registered for SMS announcements in **${targetGuild.name}**.`)
                    .addFields({
                        name: 'Phone Number',
                        value: formattedPhone.replace(/(\+1)(\d{3})(\d{3})(\d{4})/, '$1-$2-$3-$4'),
                        inline: true
                    })
                    .addFields({
                        name: 'Server',
                        value: targetGuild.name,
                        inline: true
                    })
                    .setFooter({ text: 'You can remove your number anytime using /sms-remove' });
                
                message.reply({ embeds: [successEmbed] });
            }
        }
    );
});

// Handle messages in announcement channels
client.on('messageCreate', async message => {
    if (message.author.bot || message.channel.isDMBased()) return;

    try {
        const announcementChannelId = await getAnnouncementChannel(message.guildId);
        
        if (!announcementChannelId || message.channelId !== announcementChannelId) return;

        // This is a message in the announcement channel
        const smsUsers = await getSMSUsers(message.guildId);
        
        if (smsUsers.length === 0) return;

        const smsMessage = `📢 Announcement from ${message.guild.name}:\n\n${message.content}`;
        
        // Send SMS to all subscribed users
        let successCount = 0;
        for (const user of smsUsers) {
            const success = await sendSMS(user.phone_number, smsMessage);
            if (success) successCount++;
        }

        // Add reaction to indicate SMS was sent
        await message.react('📱');

        // Optional: Send a confirmation message (you can remove this if you don't want it)
        if (message.member.permissions.has(PermissionFlagsBits.Administrator)) {
            const confirmEmbed = new EmbedBuilder()
                .setColor(0x00FF00)
                .setTitle('📱 SMS Sent')
                .setDescription(`Announcement sent via SMS to ${successCount}/${smsUsers.length} subscribed users.`)
                .setFooter({ text: 'This message is only visible to administrators' });

            const confirmMessage = await message.channel.send({ embeds: [confirmEmbed] });
            
            // Delete confirmation message after 10 seconds
            setTimeout(() => {
                confirmMessage.delete().catch(() => {});
            }, 10000);
        }

    } catch (error) {
        console.error('Error processing announcement message:', error);
    }
});

// Register slash commands
async function registerCommands() {
    const rest = new REST({ version: '9' }).setToken(config.token);

    try {
        console.log('🔄 Started refreshing application (/) commands.');

        // Register commands globally or for specific guild
        if (config.guildId) {
            await rest.put(
                Routes.applicationGuildCommands(config.clientId, config.guildId),
                { body: commands }
            );
            console.log(`✅ Successfully reloaded application (/) commands for guild ${config.guildId}.`);
        } else {
            await rest.put(
                Routes.applicationCommands(config.clientId),
                { body: commands }
            );
            console.log('✅ Successfully reloaded global application (/) commands.');
        }
    } catch (error) {
        console.error('❌ Error registering commands:', error);
    }
}

// Start the bot
async function startBot() {
    await registerCommands();
    await client.login(config.token);
}

startBot().catch(console.error);

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\n🔄 Shutting down bot...');
    db.close();
    client.destroy();
    process.exit(0);
});
