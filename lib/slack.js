const Webhook = require('@slack/client').IncomingWebhook;

let slack;
const options = {};

module.exports = {
	init: (conf) => {
		slack = new Webhook(conf.slackWebhook);
		options.channel = conf.slackChannel;
	},
	send: async (title, msgs = [], errs = []) => {
		msgs = msgs.map((msg) => {
			msg.color = 'good';
			return msg;
		});
		errs = errs.map((err) => {
			err.color = 'danger';
			return err;
		});
		if (!slack || !options.channel) {
			return Promise.resolve('Slack webhook not set, not sending slack');
		}

		const payload = {
			username: 'githook-bot',
			icon_emoji: ':bar_chart:',
			channel: options.channel,
			text: title,
			attachments: [...msgs, ...errs],
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
