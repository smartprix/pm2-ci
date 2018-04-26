/**
 * Copyright 2018 rohit-smpx, vmarchaud. All rights reserved.
 * Use of this source code is governed by a license that
 * can be found in the LICENSE file.
 */

const pmx = require('pmx');
const pm2 = require('pm2');
const {URL} = require('url');

const Worker = require('./lib/Worker');
const slack = require('./lib/slack');
const logger = require('./lib/logger');
const db = require('./lib/db');

let globalConf;
/**
 * Init pmx module
 */
pmx.initModule({}, (err, conf) => {
	globalConf = conf;
	globalConf.wwwUrl = new URL(conf.host);
	if (conf.host.lastIndexOf(':') < 7) {
		globalConf.wwwUrl.port = conf.port;
	}

	// logger.init(`${conf.dataDir}/logs`);
	slack.init(conf);
	db.setPath(`${conf.dataDir}/db`);

	process.on('uncaughtException', (error) => {
		logger.error('UncaughtException:', error.message);
		logger.error(error.stack);
		process.exit(1);
	});

	// init only if we can connect to pm2
	pm2.connect(async (err2) => {
		if (err || err2) {
			logger.error('Startup Error: %s', JSON.stringify(err || err2));
			process.exit(1);
			return;
		}

		// Compact db at start
		const tests = await db.getDb('tests');
		await tests.compact();

		const worker = new Worker(conf);
		try {
			await worker.start();
		}
		catch (err3) {
			logger.error(err3);
			process.exit(1);
		}
	});
});

pmx.configureModule({
	human_info: [
		['Status', 'Launched'],
		['Port', globalConf.port],
		['Apps', Object.keys(globalConf.apps).toString()],
		['Tests', Object.keys(globalConf.apps).filter(app => globalConf.apps[app].tests).toString()],
		['Slack Channel', globalConf.slackChannel || 'N/A'],
		['Host', globalConf.wwwUrl.origin],
	],
});
