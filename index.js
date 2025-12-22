const express = require("express");
const line = require("@line/bot-sdk");

const config = {
  channelSecret: process.env.LINE_CHANNEL_SECRET,
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
};

const app = express();
const client = new line.messagingApi.MessagingApiClient({
  channelAccessToken: config.channelAccessToken,
});

app.post("/webhook", line.middleware(config), (req, res) => {
  req.body.events.forEach((event) => {
    if (event.type === "message" && event.message.type === "text") {
      client.replyMessage({
        replyToken: event.replyToken,
        messages: [
          {
            type: "text",
            text: "我收到你的訊息了 👍",
          },
        ],
      });
    }
  });
  res.sendStatus(200);
});

app.get("/", (req, res) => {
  res.send("LINE Bot is running");
});

app.listen(3000, () => {
  console.log("Server started");
});
