const Webhook = require('@slack/client').IncomingWebhook;
const logger = require('./logger');

let slack;
const options = {};

module.exports = {
	init: ({webhook, channel}) => {
		slack = new Webhook(webhook);
		options.channel = channel;
	},
	send: (title, msgs = [], errs = []) => {
		msgs = msgs.map((msg) => {
			msg.color = 'good';
			return msg;
		});
		errs = errs.map((err) => {
			err.color = 'danger';
			return err;
		});
		if (!slack || !options.channel) {
			console.error('Slack Webhook not set');
			return;
		}

		const payload = {
			username: 'githook-bot',
			icon_emoji: ':bar_chart:',
			channel: options.channel,
			text: title,
			attachments: [...msgs, ...errs],
		};
		slack.send(payload, (error, header, statusCode) => {
			if (error) {
				logger.error(error);
				return;
			}
			logger.log('Sent slack msg. Received', statusCode, 'from Slack.\n');
		});
	},
	format: {
		url: (url, text) => `<${url}|${text}>`,
		bold: txt => `*${txt}*`,
		code: txt => `\`${txt}\``,
	},
};
