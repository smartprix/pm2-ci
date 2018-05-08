const Webhook = require('@slack/client').IncomingWebhook;

let slack;
const options = {};

module.exports = {
	init: (conf) => {
		if (conf.slackChannel && conf.slackWebhook) {
			slack = new Webhook(conf.slackWebhook);
			options.channel = conf.slackChannel;
		}
	},
	send: async (title, msgs = []) => {
		if (!slack || !options.channel) {
			return Promise.resolve('Slack webhook not set, not sending slack');
		}

		const payload = {
			username: 'pm2-ci-bot',
			icon_emoji: ':bar_chart:',
			channel: options.channel,
			text: title,
			attachments: msgs,
		};
		return new Promise((resolve, reject) => {
			slack.send(payload, (error, header, statusCode) => {
				if (error) {
					reject(error);
					return;
				}
				resolve(`Sent slack msg. Received ${statusCode} from Slack.`);
			});
		});
	},
	format: {
		url: (url, text) => `<${url}|${text}>`,
		bold: txt => `*${txt}*`,
		code: txt => `\`${txt}\``,
	},
};
