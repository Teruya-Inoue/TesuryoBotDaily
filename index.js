// Require
const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  Events,
  Partials,
} = require("discord.js");

const http = require("http");
const cron = require("node-cron");
const config = require("./config.json");
const memberJson = require("./db/member.json");
let leagueFixtureJson = require("./db/leagueFixture.json");

//わかりやすく
const Members = memberJson.members;
//botのdiscordユーザーID
const botID = "991590117036806234";

//メンバーリスト
const MemberIdList = []; //アクティブメンバーID
const SMemberIdList = []; //サポメンID
const MemberNameList = []; //アクティブメンバーの名前
const SMemberNameList = []; //サポメンの名前

const guildId = "961573520855425074";
const roleMaruId = "1252875531612065823";
const roleNotAnsId = "1252875758406336552";

let keeperId = "";

for (let member of Members) {
  //アクティブメンバー
  if (member.active) {
    MemberIdList.push(member.id);
    MemberNameList.push(member.name);
    if (member.keeper) keeperId = member.id;
    //サポートメンバー
  } else {
    SMemberIdList.push(member.id);
    SMemberNameList.push(member.name);
  }
}

//チャンネル
const myChannels = {
  ProClubVoteCh: "972816498215227402", //プロクラブ出欠確認
  WeekVoteCh: "1138445755619758150",
  General: "1004623298107281409",
  ProClubInfo: "1004308042009038848",
};

// Create a new client instance
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});

// When the client is ready, run this code (only once)
client.once("ready", async () => {
  console.log("Botの準備が完了しました");
});

//メッセージを受け取ったときの挙動
client.on(Events.MessageCreate, async (message) => {
  //プロクラブ出欠確認用
  //リアクションしやすいように選択肢でリアクション
  if (
    message.author.id == botID &&
    message.content == "" &&
    message.channelId == myChannels.ProClubVoteCh
  ) {
    message.react("⭕");
    message.react("❌");
    if (await isMatchDay()) message.react("🚫");
    return;
  }
});

//リアクションが発生したときの挙動
client.on(Events.MessageReactionAdd, async (reaction, user) => {
  //過去のメッセージ取得
  if (reaction.partial) {
    // If the message this reaction belongs to was removed, the fetching might result in an API error which should be handled
    try {
      await reaction.fetch();
    } catch (error) {
      console.error("Something went wrong when fetching the message:", error);
      // Return as `reaction.message.author` may be undefined/null
      return;
    }
  }

  //botによるリアクションなら何もしない
  if (user.bot) return;

  //リアクションされたメッセージが手数料botのメッセージでないなら何もしない
  if (reaction.message.author.id != botID) return;

  //手数料botへの固定・サポメン以外のリアクションは消す
  if (!MemberIdList.includes(user.id) && !SMemberIdList.includes(user.id)) {
    reaction.users.remove(user.id);
  }

  //当日出欠，リーグ出欠の手数料botへの固定・サポメンのリアクションは単一にする
  if (
    (reaction.message.channelId == myChannels.ProClubVoteCh) |
    (reaction.message.channelId == myChannels.WeekVoteCh)
  ) {
    const userReactions = reaction.message.reactions.cache;
    for (const r of userReactions.values()) {
      if (r.emoji.name != reaction.emoji.name) {
        r.users.remove(user.id);
      }
    }
  }
});

//httpサーバー立ち上げ
http
  .createServer(function (req, res) {
    if (req.method == "POST") {
      let data = "";
      req.on("data", function (chunk) {
        data += chunk;
      });
      req.on("end", function () {
        if (!data) {
          console.log("No post data");
          res.end();
          return;
        }
        res.end();
      });
    } else if (req.method == "GET") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("Discord Bot is active now\n");
    }
  })
  .listen(3000);

//cron:プロクラブ出欠確認に投票投稿
cron.schedule(config.VoteTime, async () => {
  //今日がオフじゃないなら出欠確認を出す
  let embed;
  let matchday = await isMatchDay();
  let booleanVote = await BooleanVoteMessageExist();

  if (!booleanVote) {
    if (matchday) {
      let title = "公式戦出欠";
      let description = matchday;

      embed = new EmbedBuilder()
        .setTitle(title)
        .setDescription(description)
        .setColor(0xff4500);
    } else {
      let title = "練習出欠";
      let description =
        "⭕ : 出席\n❌ : 欠席\n締め切り原則20時\n事前に出欠がわかる日は<#1138445755619758150>へ\n報連相は<#1004308042009038848>へ";
      embed = new EmbedBuilder()
        .setTitle(title)
        .setDescription(description)
        .setColor(0xff4500);
    }
    if (!isOff()) {
      client.channels.cache
        .get(myChannels.ProClubVoteCh)
        .send({ embeds: [embed] });
    }
  }
});

//cron:プロクラブ出欠追跡メッセージ送信
cron.schedule(config.TrackerTime, async () => {
  //今日がオフじゃないなら
  const booleanVote = await BooleanVoteMessageExist();
  const booleanTracker = await BooleanTrackerMessageExist();

  if (booleanVote && !booleanTracker && !isOff()) {
    client.channels.cache.get(myChannels.ProClubVoteCh).send("Tracker");
  }
});

//cron:プロクラブ出欠追跡テキスト更新
cron.schedule(config.UpdateTime, async () => {
  if (!isOff()) {
    //リアクション取得
    const reactionsPromise = GetAllTodayVoteReaction();
    const booleanJudgePromise = BooleanJudgeMessageExist();
    const booleanMatchDayPromise = isMatchDay();

    //出欠チャンネルからメッセージ取得
    const msg = await client.channels.cache
      .get(myChannels.ProClubVoteCh)
      .messages.fetch({ limit: 5 });

    //Trackerメッセージを探す
    for (const m of msg.values()) {
      if (
        m.content.match("Tracker") &&
        m.createdAt.getDay() == new Date().getDay()
      ) {
        const trackerMsg = m;

        //時間
        const now = new Date();
        const Hour = now.getHours();
        const Min = now.getMinutes();
        const Sec = now.getSeconds();
        let trackerText = "Tracker";

        const reactions = await reactionsPromise;
        //答えた人の集合を作る
        let all = [];
        for (const r of reactions) {
          all = all.concat(r);
        }
        const set = new Set(all);

        const answered = Array.from(set);
        const notAns = MemberIdList.filter((id) => !answered.includes(id));
        const maru = reactions[0];
        const batu = reactions[1];

        let fieldNum;
        let GkNum = 0;
        if (maru.includes(keeperId)) {
          fieldNum -= 1;
          GkNum = 1;
        }

        let text1 = "⭕:";
        let text2 = "❓:";
        let text3 = "❌:";

        //まるの人
        for (let id of maru) {
          for (let mem of Members) {
            if (id == mem.id) {
              text1 += mem.name + " ";
              break;
            }
          }
        }

        //×の人
        for (let id of batu) {
          for (let mem of Members) {
            if (id == mem.id) {
              text3 += mem.name + " ";
              break;
            }
          }
        }

        //未回答の人
        for (let id of notAns) {
          for (let mem of Members) {
            if (id == mem.id) {
              text2 += mem.name + " ";
              break;
            }
          }
        }

        //遅れの人(長さ3のときのみ)
        if (reactions.length == 3) {
          //遅れで追加
          for (let id of reactions[2]) {
            for (let mem of Members) {
              if (id == mem.id) {
                text1 += mem.name + "(遅) ";
                break;
              }
            }
          }
          fieldNum = maru.length + reactions[2].includes(keeperId);
          if (maru.includes(keeperId) || reactions[2].includes(keeperId)) {
            fieldNum -= 1;
            GkNum = 1;
          }
        } else {
          fieldNum = maru.length;
          if (maru.includes(keeperId)) {
            fieldNum -= 1;
            GkNum = 1;
          }
        }
        const judgeNum = fieldNum + notAns.length;

        trackerText += `:[${Hour}:${Min}:${Sec}時点の人数]\n**フィールド${fieldNum}人・GK${GkNum}人\n未回答${notAns.length}人**`;
        trackerText += "```" + text1 + "```";
        trackerText += "```" + text2 + "```";
        trackerText += "```" + text3 + "```";
        trackerMsg.edit(trackerText).catch(console.error);

        //botのステータス設定
        client.user.setPresence({
          activities: [
            {
              name: `⭕${maru.length}❓${notAns.length}❌${batu.length}出欠`,
              type: 3,
            },
          ],
          status: "online",
        });

        const guild = await client.guilds.fetch(guildId);
        const roleMaru = guild.roles.cache.get(roleMaruId);
        const roleNotAns = guild.roles.cache.get(roleNotAnsId);

        addMaruRemoveNotAns(guild, maru, roleMaru, roleNotAns);
        removeMaruRemoveNotAns(guild, batu, roleMaru, roleNotAns);
        removeMaruAddNotAns(guild, notAns, roleMaru, roleNotAns);

        const booleanJudge = await booleanJudgePromise;
        const booleanMatchDay = await booleanMatchDayPromise;

        if (!booleanJudge && !booleanMatchDay) {
          if (judgeNum < config.minPlayer) {
            let judgeText = "";
            if (notAns.length == 0) {
              judgeText += `<@&${roleMaruId}> 全員回答完了\n`;
            } else {
              judgeText += `<@&${roleMaruId}> <@&${roleNotAnsId}> 全員回答完了してませんが\n`;
            }
            judgeText += `フィールド${config.minPlayer}人に満たないので今日はfin`;
            console.log("fin送信");
            client.channels.cache.get(myChannels.ProClubVoteCh).send(judgeText);
          } else if (notAns.length == 0) {
            const judgeText = `<@&${roleMaruId}> 全員回答完了\nフィールド8人以上・GK${GkNum}人集まったので活動あります。\n <#${myChannels.ProClubInfo}> で、活動メンバーと配置が出た後に出欠を変える場合は連絡ください。`;
            client.channels.cache.get(myChannels.ProClubVoteCh).send(judgeText);
            console.log("活動アリ送信");
          } else {
            //console.log("まだ判定できない");
          }
        } else {
          //console.log("すでに判定済み");
        }
        break;
      }
    }
  }
});

//cron:回答リマインダー
cron.schedule(config.reminderTime, async () => {
  //オフじゃないなら
  const booleanMatchDay = await isMatchDay();
  if (!isOff() && !booleanMatchDay) {
    let text = `<@&${roleNotAnsId}> 回答よろしくお願いします`;
    client.channels.cache.get(myChannels.ProClubVoteCh).send(text);
  }
});

//cron:週出欠リアクションリセット
cron.schedule(config.WeekVoteResetTime, async () => {
  resetWeekVote();
});

//以下、便利関数
async function resetWeekVote() {
  let MsgCollection = await client.channels.cache
    .get(myChannels.WeekVoteCh)
    .messages.fetch({ limit: 7 - config.offDay.length });

  const currentDate = new Date();
  // 1週間後の日付を計算
  const oneWeekLater = new Date(
    currentDate.getTime() + 7 * 24 * 60 * 60 * 1000
  );

  const year = oneWeekLater.getFullYear();
  const month = oneWeekLater.getMonth();
  const date = oneWeekLater.getDate();

  for (const m of MsgCollection.values()) {
    await m.reactions.removeAll();
    for (let emoji of ["⭕", "❌"]) await m.react(emoji);

    try {
      let defaultEmbed = new EmbedBuilder()
        .setTitle(m.embeds[0].title)
        .setDescription(null)
        .setColor(m.embeds[0].color);
      m.edit({ embeds: [defaultEmbed] });

      if (m.embeds[0].title == "金") {
        for (const md of leagueFixtureJson.match) {
          if (md.year == year && md.month == month + 1 && md.date == date) {
            let defaultEmbed = new EmbedBuilder()
              .setTitle(m.embeds[0].title)
              .setDescription(md.opponent)
              .setColor(m.embeds[0].color);
            m.edit({ embeds: [defaultEmbed] });
            await m.react("🚫");
            break;
          }
        }
      }
    } catch (error) {
      console.log(error);
    }
  }
}

//オフの日判定
function isOff() {
  let now = new Date();
  let nowday = now.getDay();
  if (config.offDay.includes(nowday)) return true;

  let nowyear = now.getFullYear();
  for (let od of config.offDate) {
    let s = new Date(nowyear + od.start);
    let e = new Date(nowyear + od.end);

    if (s <= now && now <= e) {
      return true;
    }
  }
  return false;
}

//試合日か判定
async function isMatchDay(targetDay = new Date().getDay()) {
  let MsgCollection = await client.channels.cache
    .get(myChannels.WeekVoteCh)
    .messages.fetch({ limit: 5 });
  let days = ["日", "月", "火", "水", "木", "金", "土"];
  let nowday = targetDay;
  for (const m of MsgCollection.values()) {
    try {
      if (m.embeds[0].title == days[nowday]) {
        if (m.embeds[0].description != null) {
          return m.embeds[0].description;
        } else {
          return false;
        }
      }
    } catch (error) {
      console.log(error);
    }
  }
  return false;
}

// 指定のユーザー、内容、チャンネルから最新n個メッセージをとってくる
async function GetTargetMessage(channel, n) {
  return await client.channels.cache.get(channel).messages.fetch({ limit: n });
}

async function BooleanMessageExist(content, messageNum = 5) {
  let nowday = new Date().getDay();
  let MsgCollection = await GetTargetMessage(
    myChannels.ProClubVoteCh,
    messageNum
  );
  for (const m of MsgCollection.values()) {
    if (
      m.author.id == botID &&
      m.content.match(content) &&
      m.createdAt.getDay() == nowday
    ) {
      return true;
    }
  }
  return false;
}

//ジャッジメッセージがあるか
async function BooleanJudgeMessageExist(messageNum = 5) {
  let nowday = new Date().getDay();
  let MsgCollection = await GetTargetMessage(
    myChannels.ProClubVoteCh,
    messageNum
  );
  for (const m of MsgCollection.values()) {
    if (
      m.author.id == botID &&
      m.content.match("全員回答完了") &&
      m.createdAt.getDay() == nowday
    ) {
      return true;
    }
  }
  return false;
}

async function BooleanVoteMessageExist(messageNum = 3) {
  let nowday = new Date().getDay();
  let MsgCollection = await GetTargetMessage(
    myChannels.ProClubVoteCh,
    messageNum
  );
  for (const m of MsgCollection.values()) {
    if (
      m.author.id == botID &&
      m.content == "" &&
      m.createdAt.getDay() == nowday
    ) {
      return true;
    }
  }
  return false;
}

async function BooleanTrackerMessageExist(messageNum = 3) {
  let nowday = new Date().getDay();
  let MsgCollection = await GetTargetMessage(
    myChannels.ProClubVoteCh,
    messageNum
  );
  for (const m of MsgCollection.values()) {
    if (
      m.author.id == botID &&
      m.content.match("Tracker") &&
      m.createdAt.getDay() == nowday
    ) {
      return true;
    }
  }
  return false;
}

//当日と週の合わせたリアクションを取得
//当日＞週
async function GetAllTodayVoteReaction(targetDay = new Date().getDay()) {
  let TodayVoteReaction = [];
  //let WeekVoteReaction;

  await Promise.all([
    GetTodayVoteReaction((targetDay = targetDay)),
    GetWeekVoteReaction((targetDay = targetDay)),
  ]).then((values) => {
    let numR = Math.min(values[0].length, values[1].length);

    let todayall = [];
    for (let i = 0; i < numR; i++) {
      todayall = todayall.concat(values[0][i]);
    }
    todayall = Array.from(new Set(todayall));

    for (let i = 0; i < numR; i++) {
      let todayR = values[0][i];
      let weekR = values[1][i].filter((id) => !todayall.includes(id));
      TodayVoteReaction.push(Array.from(new Set([...todayR, ...weekR])));
    }
  });
  return TodayVoteReaction;
}

//当日出欠のリアクション取得
async function GetTodayVoteReaction(
  targetDay = new Date().getDay(),
  channel = myChannels.ProClubVoteCh
) {
  let TodayVoteArray = [];

  //メッセ取得
  let MsgCollection = await client.channels.cache
    .get(channel)
    .messages.fetch({ limit: 30 });

  for (const m of MsgCollection.values()) {
    //メッセージの条件
    //botかつ内容無しかつ今日送信されたメッセージ
    if (
      m.author.id == botID &&
      m.content == "" &&
      m.createdAt.getDay() == targetDay
    ) {
      //リアクションされている全ての絵文字
      const reactionEmojis = Array.from(m.reactions.cache.keys());
      let emojis = [];
      for (const emoji of config.emojisForVoteReaction) {
        if (reactionEmojis.includes(emoji)) emojis.push(emoji);
      }

      //リアクションされている全ての絵文字それぞれのユーザーを取得
      for (const emoji of emojis) {
        TodayVoteArray.push(
          m.reactions.cache
            .get(emoji)
            .users.fetch()
            .then((data) => {
              return data
                .filter((usr) => !usr.bot)
                .map((usr) => {
                  return usr.id;
                });
            })
            .catch((e) => {
              console.log(e);
            })
        );
      }
      break;
    }
  }
  return Promise.all(TodayVoteArray);
}

//週出欠のリアクション取得
async function GetWeekVoteReaction(
  targetDay = new Date().getDay(),
  channel = myChannels.WeekVoteCh
) {
  let weekVoteArray = [];
  //埋め込みメッセージのタイトル
  let days = ["日", "月", "火", "水", "木", "金", "土"];
  let titleName = days[targetDay];

  //メッセージ取得
  let MsgCollection = await client.channels.cache
    .get(channel)
    .messages.fetch({ limit: 5 });

  for (const m of MsgCollection.values()) {
    //メッセージの条件
    //botかつ埋め込みタイトルが条件に一致
    if (m.author.id == botID && m.embeds[0].title == titleName) {
      //リアクションされているすべての絵文字
      const reactionEmojis = Array.from(m.reactions.cache.keys());
      let emojis = [];
      for (const emoji of config.emojisForVoteReaction) {
        if (reactionEmojis.includes(emoji)) emojis.push(emoji);
      }

      for (const emoji of emojis) {
        weekVoteArray.push(
          m.reactions.cache
            .get(emoji)
            .users.fetch()
            .then((data) => {
              return data
                .filter((usr) => !usr.bot)
                .map((usr) => {
                  return usr.id;
                });
            })
            .catch((e) => {
              console.log(e);
            })
        );
      }
      break;
    }
  }
  return Promise.all(weekVoteArray);
}

async function addMaruRemoveNotAns(guild, maru, roleMaru, roleNotAns) {
  for (const id of maru) {
    guild.members.fetch(id).then(async (member) => {
      await member.fetch(true);
      if (!member.roles.cache.has(roleMaruId)) {
        await member.roles.add(roleMaru);
        console.log(member.user.tag, "に出欠〇を付与しました");
      }
      if (member.roles.cache.has(roleNotAnsId)) {
        await member.roles.remove(roleNotAns);
        console.log(member.user.tag, "未回答を削除しました");
      }
    });
  }
}

async function removeMaruRemoveNotAns(guild, batu, roleMaru, roleNotAns) {
  for (const id of batu) {
    guild.members.fetch(id).then(async (member) => {
      await member.fetch(true);
      if (member.roles.cache.has(roleMaruId)) {
        await member.roles.remove(roleMaru);
        console.log(member.user.tag, "出欠〇を削除しました");
      }
      if (member.roles.cache.has(roleNotAnsId)) {
        await member.roles.remove(roleNotAns);
        console.log(member.user.tag, "未回答を削除しました");
      }
    });
  }
}

async function removeMaruAddNotAns(guild, notAns, roleMaru, roleNotAns) {
  for (const id of notAns) {
    guild.members.fetch(id).then(async (member) => {
      await member.fetch(true);
      if (member.roles.cache.has(roleMaruId)) {
        await member.roles.remove(roleMaru);
        console.log(member.user.tag, "出欠〇を削除しました");
      }
      if (!member.roles.cache.has(roleNotAnsId)) {
        await member.roles.add(roleNotAns);
        console.log(member.user.tag, "未回答を付与しました");
      }
    });
  }
}

client.login(process.env.DISCORD_BOT_TOKEN);
