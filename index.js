// ==========================================
// 1. Necessary Imports
// ==========================================
require("dotenv").config();
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers,
} = require("@whiskeysockets/baileys");
const pino = require("pino");
const fs = require("fs");
const { jidDecode } = require("@whiskeysockets/baileys");
//const antiDelete = require("./events/antidelete");

// ==========================================
// 2. Load Database Settings
// ==========================================
const settings = JSON.parse(fs.readFileSync("./settings.json"));
const botName = settings.botName || "Err Loading Database"; // Gets botName from settings.json

// ==========================================
// Opening Port
// ==========================================

const http = require("http");
const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Bot is running!\n");
});

// Port 7860 පාවිච්චි කිරීම
server.listen(7860, () => {
  console.log("Server is running on port 7860");
});

// ==========================================
// 3. Main Bot Logic
// ==========================================
async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState("session");
  const { version } = await fetchLatestBaileysVersion();

  const conn = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: "fatal" }), // Now using the name from your database for the browser info
    browser: ["Ubuntu", "Chrome", "20.0.04"],
    syncFullHistory: false,
  });

  conn.codeRequested = false; // ==========================================
  // 4. Connection and Pairing Management
  // ==========================================

  conn.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === "close") {
      const statusCode = lastDisconnect.error?.output?.statusCode;
      console.log(`Connection closed (Status: ${statusCode}). Retrying...`);

      if (statusCode !== DisconnectReason.loggedOut) {
        setTimeout(() => startBot(), 5000);
      }
    } else if (connection === "open") {
      console.log(`${botName} connected successfully! ✅`);
    } // --- SAFE PAIRING CODE LOGIC ---

    if (!conn.authState.creds.registered && !conn.codeRequested) {
      conn.codeRequested = true;

      const phoneNumber = settings.pairNumber.replace(/[^0-9]/g, "");

      if (phoneNumber) {
        console.log(
          `Requesting code for ${botName} using number: ${phoneNumber}`,
        );

        setTimeout(async () => {
          try {
            let code = await conn.requestPairingCode(phoneNumber);
            code = code?.match(/.{1,4}/g)?.join("-") || code;
            console.log("\n-----------------------------------------");
            console.log(`YOUR VALID PAIRING CODE: ${code}`);
            console.log("-----------------------------------------\n");
          } catch (err) {
            console.log("Pairing Code Error:", err.message);
            conn.codeRequested = false;
          }
        }, 15000);
      }
    } // index.js ඇතුළත conn හැදුවට පස්සේ මේක දාන්න

    conn.decodeJid = (jid) => {
      if (!jid) return jid;
      if (/:\d+@/gi.test(jid)) {
        let decode = jidDecode(jid) || {};
        return (
          (decode.user && decode.server && decode.user + "@" + decode.server) ||
          jid
        );
      } else return jid;
    };
  }); // ==========================================
  // 5. Message Handling (Commands & Menu Replies)
  // ==========================================

  conn.ev.on("messages.upsert", async (chatUpdate) => {
    try {
      const m = chatUpdate.messages[0];
      if (!m.message) return; // Sender Decode

      m.sender = conn.decodeJid(
        m.key.fromMe ? conn.user.id : m.key.participant || m.key.remoteJid,
      ); // Caption එක හෝ Text එක අරගැනීම

      const msgContent =
        m.message.conversation ||
        m.message.extendedTextMessage?.text ||
        m.message.imageMessage?.caption ||
        m.message.videoMessage?.caption ||
        "";

      const isReply = m.message.extendedTextMessage?.contextInfo?.quotedMessage;
      const prefix = settings.prefix || "."; // --- ලොජික් 1: මෙනු රිප්ලයි ---

      if (isReply && !isNaN(msgContent)) {
        const quotedCaption =
          m.message.extendedTextMessage.contextInfo.quotedMessage.imageMessage
            ?.caption || "";
        if (quotedCaption.includes(settings.botName)) {
          // (ඔයාගේ කලින් තිබුණු මෙනු කෝඩ් එක මෙතන තියෙන්න ඕනේ...)
        }
      } // --- ලොජික් 2: කමාන්ඩ් හැන්ඩ්ලර් (Aliases & Caption Support) ---

      if (msgContent.startsWith(prefix)) {
        const args = msgContent.slice(prefix.length).trim().split(/ +/);
        const commandName = args.shift().toLowerCase();

        const cmdFiles = fs
          .readdirSync("./commands")
          .filter((file) => file.endsWith(".js"));
        let foundCommand = null; // Alias එකක්ද නැත්නම් නමද කියලා චෙක් කිරීම

        for (const file of cmdFiles) {
          const cmd = require(`./commands/${file}`);
          if (
            cmd.name === commandName ||
            (cmd.aliases && cmd.aliases.includes(commandName))
          ) {
            foundCommand = cmd;
            break;
          }
        } // .set ලොජික් එක (විශේෂ අවස්ථාවක් නිසා)

        if (
          !foundCommand &&
          commandName.startsWith("set") &&
          commandName !== "set"
        ) {
          try {
            const setCmd = require("./commands/set.js");
            await setCmd.execute(conn, m, commandName);
            return;
          } catch (e) {}
        }

        if (foundCommand) {
          try {
            // ෆයිල් එක Refresh කිරීම (Hot Reload)
            const commandPath = `./commands/${cmdFiles.find((f) => {
              const c = require(`./commands/${f}`);
              return c.name === foundCommand.name;
            })}`;
            delete require.cache[require.resolve(commandPath)];
            const command = require(commandPath);

            await command.execute(conn, m, commandName);
          } catch (err) {
            console.log(`Command Error:`, err);
          }
        }
      } // --- ලොජික් 1: මෙනු එකේ අංක වලට රිප්ලයි කිරීම (Category Menu) ---
      if (isReply && !isNaN(msgContent.trim())) {
        const quotedMsg =
          m.message.extendedTextMessage.contextInfo.quotedMessage;
        const quotedCaption =
          quotedMsg.imageMessage?.caption || quotedMsg.conversation || ""; // බොට්ගේ නම quoted caption එකේ තියෙනවාද කියලා බලනවා

        if (quotedCaption.includes(settings.botName)) {
          const selectedNum = parseInt(msgContent.trim());
          const cmdFiles = fs
            .readdirSync("./commands")
            .filter((file) => file.endsWith(".js"));

          let categories = [];
          let allCmds = {};

          cmdFiles.forEach((file) => {
            const cmd = require(`./commands/${file}`);
            if (cmd.category) {
              if (!categories.includes(cmd.category)) {
                categories.push(cmd.category);
              }
              if (!allCmds[cmd.category]) {
                allCmds[cmd.category] = [];
              } // alias තිබුණත් ප්‍රධාන නම විතරක් මෙනු එකට ගන්නවා
              if (!allCmds[cmd.category].includes(cmd.name)) {
                allCmds[cmd.category].push(cmd.name);
              }
            }
          });

          let responseText = ""; // 1. Category එකක් තෝරාගත් විට

          if (selectedNum > 0 && selectedNum <= categories.length) {
            const selectedCat = categories[selectedNum - 1];
            responseText = `╭──『 *${selectedCat.toUpperCase()} ᴍᴇɴᴜ* 』──⊷\n`;
            allCmds[selectedCat].forEach((c) => {
              responseText += `│ ⚡ ${prefix}${c}\n`;
            });
            responseText += `╰──────────────────⊷`;
          } else if (selectedNum === categories.length + 1) {
            // 2. Full Menu (අන්තිම අංකය) තෝරාගත් විට
            responseText = `╭──『 *ꜰᴜʟʟ ᴍᴇɴᴜ* 』──⊷\n`;
            for (let cat in allCmds) {
              responseText += `\n*${cat.toUpperCase()}*\n`;
              allCmds[cat].forEach((c) => {
                responseText += `│ ⚡ ${prefix}${c}\n`;
              });
            }
            responseText += `\n╰───────────────────⊷`;
          }

          if (responseText) {
            return await conn.sendMessage(
              m.key.remoteJid,
              {
                text: responseText,
              },
              { quoted: m },
            );
          }
        }
      }
    } catch (err) {
      console.log("Error in messages.upsert:", err);
    }
  }); //===========================
  //End
  //===========================

  conn.ev.on("creds.update", saveCreds);
}

startBot();
