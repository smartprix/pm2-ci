/**
 * Copyright 2018 rohit-smpx, vmarchaud. All rights reserved.
 * Use of this source code is governed by a license that
 * can be found in the LICENSE file.
 */

const pmx = require('pmx');
const pm2 = require('pm2');
const {URL} = require('url');
const path = require('path');

const version = require('./package.json').version;
const Worker = require('./lib/Worker');
const slack = require('./lib/slack');
const logger = require('./lib/logger');
const db = require('./lib/db');

function updateConf(conf, worker) {
	pmx.configureModule({
		human_info: [
			['Status', 'Launched'],
			['Version', version],
			['Port', conf.port],
			['Apps', worker && Object.keys(worker.apps || {}).toString()],
			['Tests', worker && Object.keys(worker.apps || {}).filter(app => ((worker.apps || {})[app] || {}).tests || '').toString()],
			['Slack Channel', conf.slackChannel || 'N/A'],
			['Host', (conf.wwwUrl || {}).origin],
			['Queue Size', worker && worker.queue.size()]
		],
	});	
}

/**
 * Init pmx module
 */
pmx.initModule({}, async (err, conf) => {
	conf.wwwUrl = new URL(conf.host);
	if (conf.host.lastIndexOf(':') < 7) {
		conf.wwwUrl.port = conf.port;
	}
	conf.dataDir = path.resolve(conf.dataDir);

	// logger.init(`${conf.dataDir}/logs`);
	slack.init(conf);
	db.setPath(`${conf.dataDir}/db`);

	process.on('uncaughtException', (error) => {
		logger.error('UncaughtException:', error.message);
		logger.error(error.stack);
		process.exit(1);
	});

	// init only if we can connect to pm2
	await new Promise((resolve, reject) => {
		pm2.connect(async (err2) => {
			if (err || err2) {
				logger.error('Startup Error: %s', JSON.stringify(err || err2));
				reject(err || err2);
				return;
			}
			// Compact db and delete older reports data & files (2 weeks) at start
			await db.optimiseDbs(conf.dataDir);

			conf.apps = await Worker.getApps();

			const worker = new Worker(conf, updateConf);

			updateConf(conf, worker);
			try {
				await worker.start();
			}
			catch (err3) {
				logger.error(err3);
				reject(err3);
				return;
			}
			resolve();
		});
	});
});