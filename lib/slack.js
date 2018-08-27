const Webhook = require('@slack/client').IncomingWebhook;

let slack;
const options = {};

module.exports = {
	init: (conf) => {
		if (conf.slackWebhook) {
			slack = new Webhook(conf.slackWebhook);
			options.channel = conf.slackChannel;
		}
	},
	send: async (title, msgs = [], channel = undefined) => {
		channel = channel || options.channel;
		if (!(slack && channel)) {
			return Promise.resolve('Slack webhook and channel not set, not sending slack');
		}

		const payload = {
			username: 'pm2-ci-bot',
			icon_emoji: ':bar_chart:',
			channel,
			text: title,
			attachments: msgs,
		};
		return new Promise((resolve, reject) => {
			slack.send(payload, (error, res) => {
				if (error) {
					reject(error);
					return;
				}
				resolve(`Sent slack msg. Received ${res} from Slack.`);
			});
		});
	},
	format: {
		url: (url, text) => `<${url}|${text}>`,
		bold: txt => `*${txt}*`,
		code: txt => `\`${txt}\``,
	},
};
